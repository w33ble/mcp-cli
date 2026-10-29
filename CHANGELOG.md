# Changelog

## [Unreleased]

## [0.5.0] - 2026-10-29

### Changed

- Bumped `@modelcontextprotocol/sdk` to 1.32.2

### Security

- **Requires Bun ~1.4.4** - `engines.bun` pinned (was `>=1.0.0`). Bun 1.4.4 updates its bundled root certificates to NSS 3.131.1, which distrusts the compromised [eMudhra intermediate CAs](https://emudhra.we-have-a-problem.com/). Earlier Bun versions, and binaries compiled with them, still trust those intermediates for HTTPS connections to MCP servers and OAuth endpoints
- **Daemon no longer leaks config secrets via argv** - Resolved server config (including `${VAR}`-substituted `env`/`headers`) is now passed to the daemon over stdin instead of as a command-line argument, so it no longer shows up in `ps`

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
