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

    await writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          filesystem: {
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-filesystem', tempDir],
            env: {
              npm_config_registry: 'https://registry.npmjs.org',
              SECRET_TOKEN: '${MCP_CLI_TEST_SECRET}',
            },
          },
        },
      }),
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
});
