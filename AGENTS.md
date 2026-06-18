# AGENTS.md

- Repo is a Bun/TypeScript CLI; `src/index.ts` is the entrypoint and `src/commands/*` hold the subcommands.
- `src/client.ts` handles server connections and daemon fallback; `src/daemon.ts` is the background socket daemon.
- Config search order is: `-c/--config` or `MCP_CONFIG_PATH`, then `./mcp_servers.json`, `~/.mcp_servers.json`, `~/.config/mcp/mcp_servers.json`.
- `call` reads JSON from stdin when no inline args are given; a literal `-` is treated as “read stdin”.
- `grep` matches tool names only, not server names or descriptions.
- `list`/`grep` fan out with a concurrency limit from `MCP_CONCURRENCY`; disable daemon caching with `MCP_NO_DAEMON=1` for deterministic runs/tests.
- `MCP_STRICT_ENV` defaults to strict; missing `${VAR}` references in config fail unless set to `false`/`0`.
- Useful env vars: `MCP_TIMEOUT`, `MCP_MAX_RETRIES`, `MCP_RETRY_DELAY`, `MCP_DAEMON_TIMEOUT`, `MCP_DEBUG`.
- Use Bun scripts: `bun run dev`, `bun run build`, `bun test`, `bun test --timeout 30000 tests/integration`, `bun run typecheck`, `bun run lint`, `bun run lint:fix`, `bun run format`.
- Biome is the source of truth for style: 2-space indentation, single quotes, semicolons.
- Integration tests need `npx` and `@modelcontextprotocol/server-filesystem`; they create a temp config and disable the daemon.
- Build outputs go to `dist/`; do not treat them as source.
