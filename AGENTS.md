# AGENTS.md

- Repo is a Bun/TypeScript CLI; `src/index.ts` is the entrypoint and `src/commands/*` hold the subcommands.
- Bun version is pinned in two places: `mise.toml` (`[tools] bun`, exact) and `package.json` `engines.bun` (`~x.y.z`). Change both together, along with the Bun prerequisite in `README.md`. CI and release workflows read `engines.bun` via `setup-bun`'s `bun-version-file: package.json`.
- `src/client.ts` handles server connections and daemon fallback; `src/daemon.ts` is the background socket daemon.
- MCP SDK is `@modelcontextprotocol/client` (v2); only `src/client.ts` and `src/oauth.ts` import it. Keep the default (legacy) `versionNegotiation`: `'auto'` adds a probe round trip, which the SDK advises against for spawn-per-invocation CLIs.
- Config search order is: `-c/--config` or `MCP_CONFIG_PATH`, then `./mcp_servers.json`, `~/.mcp_servers.json`, `~/.config/mcp/mcp_servers.json`.
- `call` reads JSON from stdin when no inline args are given; a literal `-` is treated as “read stdin”.
- `grep` matches tool names only, not server names or descriptions.
- `list`/`grep` fan out with a concurrency limit from `MCP_CONCURRENCY`; disable daemon caching with `MCP_NO_DAEMON=1` for deterministic runs/tests.
- `MCP_STRICT_ENV` defaults to strict; missing `${VAR}` references in config fail unless set to `false`/`0`.
- Useful env vars: `MCP_TIMEOUT`, `MCP_MAX_RETRIES`, `MCP_RETRY_DELAY`, `MCP_DAEMON_TIMEOUT`, `MCP_DEBUG`.
- Use Bun scripts: `bun run dev`, `bun run build`, `bun test`, `bun test --timeout 30000 tests/integration`, `bun run typecheck`, `bun run lint`, `bun run lint:fix`, `bun run fmt`, `bun run fmt:check`.
- Oxc is the source of truth for style: `oxfmt` (`.oxfmtrc.json`: 2-space indent, single quotes, semicolons, ES5 trailing commas, 100 cols, sorted imports) and `oxlint` (`.oxlintrc.json`). Run `bun run fmt` and `bun run lint` after changes.
- Integration tests need `npx` and `@modelcontextprotocol/server-filesystem`; they create a temp config and disable the daemon, except `tests/integration/daemon.test.ts`, which exercises a real daemon.
- Build outputs go to `dist/`; do not treat them as source.
- After a user-facing change is merged to `main`, record it in `CHANGELOG.md` under `## [Unreleased]` (Keep a Changelog sections: `Added`/`Changed`/`Fixed`/`Security`), as a separate `docs(changelog): ...` commit, not inside the change's commit.
