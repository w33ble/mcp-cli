/**
 * Integration tests for the connection daemon (daemon enabled)
 *
 * Requires npx and @modelcontextprotocol/server-filesystem.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { $ } from 'bun';

describe('daemon', () => {
  const canary = `mcp-cli-canary-${crypto.randomUUID()}`;
  let tempDir: string;
  let configPath: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'mcp-cli-daemon-'));
    configPath = join(tempDir, 'mcp_servers.json');

    const filesystem = {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', tempDir],
      env: {
        npm_config_registry: 'https://registry.npmjs.org',
        SECRET_TOKEN: '${MCP_CLI_TEST_SECRET}',
      },
    };

    const large = {
      command: 'bun',
      args: [join(import.meta.dir, '..', 'fixtures', 'large-payload-server.ts')],
    };

    // Separate names give separate daemons, so one test can't reuse the other's
    await writeFile(
      configPath,
      JSON.stringify({ mcpServers: { filesystem, compiled: filesystem, large } })
    );
  });

  afterAll(async () => {
    // Daemon argv includes the config path, so this only matches our daemon
    await $`pkill -f ${configPath}`.nothrow().quiet();
    await rm(tempDir, { recursive: true, force: true });
  });

  test('does not expose resolved secrets in process arguments', async () => {
    const cliPath = join(import.meta.dir, '..', '..', 'src', 'index.ts');

    const result = await $`bun run ${cliPath} -c ${configPath} info filesystem`
      .env({ ...process.env, MCP_CLI_TEST_SECRET: canary, MCP_DEBUG: '1' })
      .nothrow()
      .quiet();

    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toContain('Using daemon connection');

    const processArgs = await $`ps -ax -o args=`.text();

    expect(processArgs).toContain(configPath);
    expect(processArgs).not.toContain(canary);
  });

  test('compiled binary spawns and reuses its daemon', async () => {
    const entry = join(import.meta.dir, '..', '..', 'src', 'index.ts');
    const binary = join(tempDir, 'mcp-cli');
    await $`bun build --compile ${entry} --outfile ${binary}`.quiet();

    const env = { ...process.env, MCP_CLI_TEST_SECRET: canary, MCP_DEBUG: '1' };
    const first = await $`${binary} -c ${configPath} info compiled`.env(env).nothrow().quiet();
    const second = await $`${binary} -c ${configPath} info compiled`.env(env).nothrow().quiet();

    expect(first.exitCode).toBe(0);
    expect(first.stderr.toString()).toContain('Using daemon connection');
    expect(second.exitCode).toBe(0);
    expect(second.stderr.toString()).not.toContain('Spawning daemon');
    expect(second.stderr.toString()).toContain('Using daemon connection');

    const processArgs = await $`ps -ax -o args=`.text();

    expect(processArgs).toContain(`${binary} --daemon compiled`);
    expect(processArgs).not.toContain(canary);
  }, 60000);

  test('relays messages larger than one socket read in both directions', async () => {
    const cliPath = join(import.meta.dir, '..', '..', 'src', 'index.ts');
    const env = { ...process.env, MCP_CLI_TEST_SECRET: canary, MCP_DEBUG: '1' };

    const info = await $`bun run ${cliPath} -c ${configPath} -d info large`
      .env(env)
      .nothrow()
      .quiet();

    expect(info.stderr.toString()).toContain('Using daemon connection');
    expect(info.exitCode).toBe(0);
    expect(info.stdout.toString()).toContain('Tools (300)');
    expect(info.stdout.toString()).toContain('café — ✓ ünïcödé');

    const text = 'é✓'.repeat(300_000);
    const args = new Response(JSON.stringify({ text }));
    const call = await $`bun run ${cliPath} -c ${configPath} call large echo < ${args}`
      .env(env)
      .nothrow()
      .quiet();

    expect(call.stderr.toString()).toContain('Using daemon connection');
    expect(call.exitCode).toBe(0);
    expect(call.stdout.toString().trim()).toBe(text);
  }, 60000);
});
