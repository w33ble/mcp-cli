/**
 * MCP-CLI Daemon - Background worker that maintains persistent MCP connections
 *
 * This is spawned as a detached process and manages a Unix socket for IPC.
 * It maintains the MCP server connection and forwards requests from CLI invocations.
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';

import type { Socket } from 'bun';

import { type ConnectedClient, callTool, connectToServer, listTools } from './client.js';
import {
  type ServerConfig,
  debug,
  getConfigHash,
  getDaemonTimeoutMs,
  getPidPath,
  ensureSocketDir,
  getSocketPath,
} from './config.js';
import { JsonLineSocket } from './framing.js';

// ============================================================================
// Types
// ============================================================================

export interface DaemonRequest {
  id: string;
  type: 'listTools' | 'callTool' | 'ping' | 'close' | 'getInstructions';
  toolName?: string;
  args?: Record<string, unknown>;
}

export interface DaemonResponse {
  id: string;
  success: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}

interface PidFileContent {
  pid: number;
  configHash: string;
  startedAt: string;
}

// ============================================================================
// PID File Management
// ============================================================================

/**
 * Write PID file with config hash for stale detection
 */
export function writePidFile(serverName: string, configHash: string): void {
  const pidPath = getPidPath(serverName);

  const content: PidFileContent = {
    pid: process.pid,
    configHash,
    startedAt: new Date().toISOString(),
  };

  writeFileSync(pidPath, JSON.stringify(content), { mode: 0o600 });
}

/**
 * Read PID file content
 */
export function readPidFile(serverName: string): PidFileContent | null {
  const pidPath = getPidPath(serverName);

  if (!existsSync(pidPath)) {
    return null;
  }

  try {
    const content = readFileSync(pidPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Remove PID file
 */
export function removePidFile(serverName: string): void {
  const pidPath = getPidPath(serverName);
  try {
    if (existsSync(pidPath)) {
      unlinkSync(pidPath);
    }
  } catch {
    // Ignore errors during cleanup
  }
}

/**
 * Remove socket file
 */
export function removeSocketFile(serverName: string): void {
  const socketPath = getSocketPath(serverName);
  try {
    if (existsSync(socketPath)) {
      unlinkSync(socketPath);
    }
  } catch {
    // Ignore errors during cleanup
  }
}

/**
 * Check if a process is running
 */
export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Kill a process by PID
 */
export function killProcess(pid: number): boolean {
  try {
    process.kill(pid, 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Daemon Worker
// ============================================================================

/**
 * Main daemon entry point - run as detached background process
 */
export async function runDaemon(
  serverName: string,
  config: ServerConfig,
  namespace = serverName,
  configPath?: string
): Promise<void> {
  const socketPath = getSocketPath(namespace);
  const configHash = getConfigHash(config);
  const timeoutMs = getDaemonTimeoutMs();

  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let mcpClient: ConnectedClient | null = null;
  let server: ReturnType<typeof Bun.listen> | null = null;
  const activeConnections = new Map<Socket<unknown>, JsonLineSocket>();

  // Cleanup function
  const cleanup = async () => {
    debug(`[daemon:${serverName}] Shutting down...`);

    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }

    // Close all active socket connections
    for (const socket of activeConnections.keys()) {
      try {
        socket.end();
      } catch {
        // Ignore
      }
    }
    activeConnections.clear();

    // Close MCP connection
    if (mcpClient) {
      try {
        await mcpClient.close();
      } catch {
        // Ignore
      }
      mcpClient = null;
    }

    // Close socket server
    if (server) {
      try {
        server.stop();
      } catch {
        // Ignore
      }
      server = null;
    }

    // Clean up files
    removeSocketFile(namespace);
    removePidFile(namespace);

    debug(`[daemon:${serverName}] Cleanup complete`);
  };

  // Reset idle timer
  const resetIdleTimer = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
    }
    idleTimer = setTimeout(async () => {
      debug(`[daemon:${serverName}] Idle timeout reached, shutting down`);
      await cleanup();
      process.exit(0);
    }, timeoutMs);
  };

  // Handle signals
  process.on('SIGTERM', async () => {
    await cleanup();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    await cleanup();
    process.exit(0);
  });

  ensureSocketDir();

  // Remove stale socket if exists
  removeSocketFile(namespace);

  // Write PID file
  writePidFile(namespace, configHash);

  // Connect to MCP server
  try {
    debug(`[daemon:${serverName}] Connecting to MCP server...`);
    mcpClient = await connectToServer(serverName, config, configPath);
    debug(`[daemon:${serverName}] Connected to MCP server`);
  } catch (error) {
    console.error(`[daemon:${serverName}] Failed to connect:`, (error as Error).message);
    await cleanup();
    process.exit(1);
  }

  // Handle incoming request
  const handleRequest = async (request: DaemonRequest): Promise<DaemonResponse> => {
    resetIdleTimer();

    debug(`[daemon:${serverName}] Request: ${request.type} (${request.id})`);

    if (!mcpClient) {
      return {
        id: request.id,
        success: false,
        error: { code: 'NOT_CONNECTED', message: 'MCP client not connected' },
      };
    }

    try {
      switch (request.type) {
        case 'ping':
          return { id: request.id, success: true, data: 'pong' };

        case 'listTools': {
          const tools = await listTools(mcpClient.client);
          return { id: request.id, success: true, data: tools };
        }

        case 'callTool': {
          if (!request.toolName) {
            return {
              id: request.id,
              success: false,
              error: { code: 'MISSING_TOOL', message: 'toolName required' },
            };
          }
          const result = await callTool(mcpClient.client, request.toolName, request.args ?? {});
          return { id: request.id, success: true, data: result };
        }

        case 'getInstructions': {
          const instructions = mcpClient.client.getInstructions();
          return { id: request.id, success: true, data: instructions };
        }

        case 'close':
          // Graceful shutdown requested
          setTimeout(async () => {
            await cleanup();
            process.exit(0);
          }, 100);
          return { id: request.id, success: true, data: 'closing' };

        default:
          return {
            id: request.id,
            success: false,
            error: {
              code: 'UNKNOWN_TYPE',
              message: `Unknown request type: ${request.type}`,
            },
          };
      }
    } catch (error) {
      const err = error as Error;
      return {
        id: request.id,
        success: false,
        error: {
          code: String((err as Error & { code?: unknown }).code ?? 'EXECUTION_ERROR'),
          message: err.message,
        },
      };
    }
  };

  // Start Unix socket server
  try {
    server = Bun.listen({
      unix: socketPath,
      socket: {
        open(socket) {
          activeConnections.set(socket, new JsonLineSocket(socket));
          debug(`[daemon:${serverName}] Client connected`);
        },
        async data(socket, data) {
          const connection = activeConnections.get(socket);
          if (!connection) return;

          let requests: unknown[];
          try {
            requests = connection.receive(data);
          } catch {
            connection.send({
              id: 'unknown',
              success: false,
              error: { code: 'INVALID_REQUEST', message: 'Invalid JSON' },
            });
            return;
          }

          for (const request of requests) {
            connection.send(await handleRequest(request as DaemonRequest));
          }
        },
        drain(socket) {
          activeConnections.get(socket)?.flush();
        },
        close(socket) {
          activeConnections.delete(socket);
          debug(`[daemon:${serverName}] Client disconnected`);
        },
        error(socket, error) {
          debug(`[daemon:${serverName}] Socket error: ${error.message}`);
          activeConnections.delete(socket);
        },
      },
    });

    debug(`[daemon:${serverName}] Listening on ${socketPath}`);

    // Start idle timer
    resetIdleTimer();

    // Signal readiness by writing to stdout (parent will read this)
    console.log('DAEMON_READY');
  } catch (error) {
    console.error(
      `[daemon:${serverName}] Failed to start socket server:`,
      (error as Error).message
    );
    await cleanup();
    process.exit(1);
  }
}

// ============================================================================
// Entry point: `--daemon <serverName> [namespace] [configPath]`, config JSON on stdin
// ============================================================================

export async function runDaemonFromArgs(args: string[]): Promise<void> {
  const [serverName, namespace, configPath] = args;

  if (!serverName) {
    console.error('Usage: --daemon <serverName> [namespace] [configPath] < configJson');
    process.exit(1);
  }

  let config: ServerConfig;
  try {
    config = JSON.parse(await Bun.stdin.text());
  } catch {
    console.error('Invalid config JSON on stdin');
    process.exit(1);
  }

  await runDaemon(serverName, config, namespace, configPath);
}

// Source runs spawn this file directly; compiled binaries route `--daemon` through src/index.ts
if (import.meta.main && process.argv[2] === '--daemon') {
  runDaemonFromArgs(process.argv.slice(3)).catch((error) => {
    console.error('Daemon failed:', error);
    process.exit(1);
  });
}
