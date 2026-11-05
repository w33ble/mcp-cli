# Changelog

## [Unreleased]

### Added

- **Disable a server with `"enabled": false`** - A disabled server stays in the config but is never listed or connected to by `mcp-cli` and `grep`, so an OAuth server you rarely use doesn't need a current login. `info`, `call`, and `auth` on it fail with `SERVER_DISABLED`. Omitting the field means enabled; a value that isn't `true` or `false` is rejected when the config loads

### Changed

- **One server needing a login no longer fails the whole list** - `mcp-cli` and `grep` used to exit 4 as soon as any server needed `auth login`. The other servers now list normally, the affected server shows `<auth required: run 'mcp-cli auth login <server>'>`, and the exit code is 0. `grep` prints the login command for each such server. `call` and `info` on that server still exit 4
- **Migrated to `@modelcontextprotocol/client` v2** - Replaces the combined client/server `@modelcontextprotocol/sdk` 1.32.2 with the client-only v2 package (2.4.0), which cuts the lockfile from 161 packages to 79. The wire protocol is unchanged. Error details from HTTP servers no longer start with `Streamable HTTP error: `

### Fixed

- **OAuth login callback page loads** - The loopback callback server shut down before sending its response, so the browser showed a connection error instead of "Authentication complete" even when login succeeded
- **401s with an empty or unrecognized body are reported as `AUTH_ERROR`** - A server that rejected a request with a 401 and an empty body, or a message like `Bearer token required`, was reported as a generic connection error with no `auth login` hint

## [0.5.2] - 2026-11-04

### Fixed

- **Large daemon responses no longer fail** - The CLI and the connection daemon treated each chunk read from the socket as a whole JSON message, and the daemon ignored partial socket writes. Any response bigger than one read, which covers most real tool lists, failed with `Invalid response from daemon`. Messages are now newline-terminated, buffered until complete, and resumed on drain when the socket applies backpressure. Daemons started by 0.5.1 keep running the old code until they go idle, so run `pkill -f "mcp-cli --daemon"` once after upgrading

## [0.5.1] - 2026-10-29

### Fixed

- **Connection daemon works in release binaries** - Compiled binaries tried to spawn the daemon with `bun run <dir>/daemon.ts`, a file that doesn't exist inside a compiled executable, so every call silently fell back to a fresh direct connection. This has been broken in every release binary since the daemon was introduced in 0.3.0. The binary now re-executes itself with `--daemon`, so connections stay warm between calls as intended

## [0.5.0] - 2026-10-29

### Changed

- Bumped `@modelcontextprotocol/sdk` to 1.32.2

### Security

- **Requires Bun ~1.4.4** - `engines.bun` pinned (was `>=1.0.0`). Bun 1.4.4 updates its bundled root certificates to NSS 3.131.1, which distrusts the compromised [eMudhra intermediate CAs](https://emudhra.we-have-a-problem.com/). Earlier Bun versions, and binaries compiled with them, still trust those intermediates for HTTPS connections to MCP servers and OAuth endpoints
- **Daemon no longer leaks config secrets via argv** - Resolved server config (including `${VAR}`-substituted `env`/`headers`) is now passed to the daemon over stdin instead of as a command-line argument, so it no longer shows up in `ps`
- **Daemon refuses an unsafe socket directory** - `/tmp/mcp-cli-<uid>` must be a real directory owned by the current user with mode `0700`. Previously an existing directory was used as-is, so another local user who pre-created it could swap in their own socket and intercept tool calls. When the check fails, mcp-cli warns and uses direct connections

### Fixed

- Unknown-option errors listed nonexistent `-j/--json` and `-r/--raw` flags; they now list `-c/--config`, `-d/--with-descriptions`, `-h/--help`, and `-v/--version`

## [0.4.1] - 2026-07-16

### Fixed

- **Linux arm64 build** - Release workflow now builds the `linux-arm64` binary the install script expects

### Changed

- Repository, install script, and release references point at this fork instead of upstream
- Release workflow runs on Node 24

## [0.4.0] - 2026-07-16

### Added

- **OAuth for HTTP servers** - Authenticate Streamable HTTP servers with PKCE and a loopback callback
  - `mcp-cli auth login <server>`: Prints the authorization URL to stderr and waits for the callback
  - `mcp-cli auth status <server>`: Check stored credentials
  - `mcp-cli auth logout <server>`: Remove stored credentials
  - Commands against an unauthenticated server fail with `AUTH_ERROR` and suggest `auth login`
  - Credentials are stored in the OS secure store, keyed by config path, server name, and URL

### Fixed

- Falls back to a `0600` file under `~/.config/mcp/oauth/` when the OS secure store is unavailable (e.g. headless systems)
- Invalid OAuth token errors are classified as `AUTH_ERROR`

## [0.3.1] - 2026-07-15

### Fixed

- **`call` outputs raw text content** - Previously emitted the full MCP `{ "content": [...] }` envelope
- **Daemon IPC honors `MCP_TIMEOUT`** - `listTools`, `callTool`, and `getInstructions` requests through the daemon use the configured timeout; timed-out sockets are closed

## [0.3.0] - 2026-01-22

### Added

- **Server Instructions Support** - Display MCP server instructions in output
  - `mcp-cli` (list all): Shows first line of instructions per server
  - `mcp-cli info <server>`: Shows full instructions under "Instructions:" heading

- **Tool Filtering** - Restrict tools per server via config
  - `allowedTools`: Glob patterns for tools to allow (e.g., `["read_*", "list_*"]`)
  - `disabledTools`: Glob patterns for tools to exclude (e.g., `["delete_*"]`)
  - `disabledTools` takes precedence over `allowedTools`
  - Filtering applies globally to all CLI operations (info, grep, call)

- **Connection Daemon** - Lazy-spawn connection pooling
  - Per-server daemon keeps MCP connections warm
  - 60s idle timeout (configurable via `MCP_DAEMON_TIMEOUT`)
  - Automatic config hash invalidation
  - `MCP_NO_DAEMON=1` to disable

- **3-Subcommand Architecture** - `info`, `grep`, `call`
  - Flexible format support: `server tool` and `server/tool`
  - `call` outputs raw text content (CLI-friendly, pipe to grep/head/etc.)
  - `info`/`grep` output human-readable format

- **Improved Error Messages for LLMs**
  - AMBIGUOUS_COMMAND: Shows both `call` and `info` options
  - UNKNOWN_SUBCOMMAND: Smart mapping (run→call, list→info, search→grep)
  - MISSING_ARGUMENT: Shows available servers list
  - INVALID_JSON: Schema hint with example

- **Advanced Chaining Examples** - New documentation section
  - Search and read pipelines with jq
  - Multi-file processing with loops
  - Conditional execution with `jq -e`
  - Multi-server aggregation
  - Error handling patterns

- **Generate System Instructions Script** - `scripts/generate-system-instructions.ts`

### Changed

- **CLI Command Structure**
  - `mcp-cli` (no args) lists all servers
  - `mcp-cli info <server>` requires a server argument

- **Grep Output Format**
  - Output now uses space-separated format: `<server> <tool> <description>`
  - Descriptions are always shown when available
  - Pattern now matches tool name only (not server name or description)

### Removed

- **Backward Compatibility Syntax** - `mcp-cli server/tool [args]` now errors with helpful message
- **`--json` and `--raw` options** - Output format now automatic based on command
