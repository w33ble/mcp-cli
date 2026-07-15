---
name: mcp-cli
description: Interface for MCP (Model Context Protocol) servers via CLI. Use when you need to interact with external tools, APIs, or data sources through MCP servers.
---

# MCP-CLI

Access MCP servers through the command line. MCP enables interaction with external systems like GitHub, filesystems, databases, and APIs.

## Commands

| Command | Output |
|---------|--------|
| `mcp-cli` | List all servers and tools |
| `mcp-cli info <server>` | Show server tools and parameters |
| `mcp-cli info <server> <tool>` | Get tool JSON schema |
| `mcp-cli grep "<pattern>"` | Search tools by name |
| `mcp-cli call <server> <tool>` | Call tool (reads JSON from stdin if no args) |
| `mcp-cli call <server> <tool> '<json>'` | Call tool with arguments |
| `mcp-cli auth login <server>` | Start OAuth login for an HTTP server |
| `mcp-cli auth status <server>` | Check stored OAuth credentials |
| `mcp-cli auth logout <server>` | Remove stored OAuth credentials |

**Both formats work:** `<server> <tool>` or `<server>/<tool>`

## Workflow

1. **Discover**: `mcp-cli` → see available servers
2. **Explore**: `mcp-cli info <server>` → see tools with parameters
3. **Inspect**: `mcp-cli info <server> <tool>` → get full JSON schema
4. **Authenticate when required**: `mcp-cli auth login <server>` → print the URL and ask the user to open it
5. **Execute**: `mcp-cli call <server> <tool> '<json>'` → run with arguments

### OAuth authentication

OAuth is supported for Streamable HTTP servers configured with a `url`. Stdio
and npx-based servers are expected to handle their own authentication.

When a command reports that authentication is required:

1. Run `mcp-cli auth login <server>` using the same `-c <path>` option, if one was used for the original command.
2. Capture the authorization URL printed to stderr.
3. Show the complete URL to the user and ask them to open it and authenticate.
4. Keep the login process running while the user completes authentication; it is waiting for the loopback callback.
5. Only report success after the command exits successfully.
6. Retry the original command after login completes.

Do not open the URL silently or claim authentication succeeded merely because a
URL was printed. The callback uses a temporary available loopback port, so the
URL must be used as printed and should not be edited.

Example:

```bash
mcp-cli -c ~/.config/mcp/mcp_servers.json auth login notion
# Show the printed authorization URL to the user and wait for completion.
mcp-cli -c ~/.config/mcp/mcp_servers.json auth status notion
```

## Examples

```bash
# List all servers
mcp-cli

# With descriptions  
mcp-cli -d

# See server tools
mcp-cli info filesystem

# Get tool schema (both formats work)
mcp-cli info filesystem read_file
mcp-cli info filesystem/read_file

# Call tool
mcp-cli call filesystem read_file '{"path": "./README.md"}'

# Pipe from stdin (no '-' needed!)
cat args.json | mcp-cli call filesystem read_file

# Search for tools
mcp-cli grep "*file*"

# Output is raw text (pipe-friendly)
mcp-cli call filesystem read_file '{"path": "./file"}' | head -10
```

## Advanced Chaining

```bash
# Chain: search files → read first match
mcp-cli call filesystem search_files '{"path": ".", "pattern": "*.md"}' \
  | head -1 \
  | xargs -I {} mcp-cli call filesystem read_file '{"path": "{}"}'

# Loop: process multiple files
mcp-cli call filesystem list_directory '{"path": "./src"}' \
  | while read f; do mcp-cli call filesystem read_file "{\"path\": \"$f\"}"; done

# Conditional: check before reading
mcp-cli call filesystem list_directory '{"path": "."}' \
  | grep -q "README" \
  && mcp-cli call filesystem read_file '{"path": "./README.md"}'

# Multi-server aggregation
{
  mcp-cli call github search_repositories '{"query": "mcp", "per_page": 3}'
  mcp-cli call filesystem list_directory '{"path": "."}'
}

# Save to file
mcp-cli call github get_file_contents '{"owner": "x", "repo": "y", "path": "z"}' > output.txt
```

**Note:** `call` outputs raw text content directly (no jq needed for text extraction)

## Options

| Flag | Purpose |
|------|---------|
| `-d` | Include descriptions |
| `-c <path>` | Specify config file |
| `--version` | Show the CLI version |

The config search order is:

1. `-c/--config` or `MCP_CONFIG_PATH`
2. `./mcp_servers.json`
3. `~/.mcp_servers.json`
4. `~/.config/mcp/mcp_servers.json`

An existing local `./mcp_servers.json` takes precedence over the home config.

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `MCP_CONFIG_PATH` | Path to config file | (none) |
| `MCP_DEBUG` | Enable debug output | `false` |
| `NO_COLOR` | Disable colored output | (unset) |
| `MCP_TIMEOUT` | Request timeout in seconds | `1800` (30 min) |
| `MCP_CONCURRENCY` | Servers processed in parallel | `5` |
| `MCP_MAX_RETRIES` | Retry attempts for transient errors (`0` disables retries) | `3` |
| `MCP_RETRY_DELAY` | Base retry delay in milliseconds | `1000` |
| `MCP_STRICT_ENV` | Error on missing `${VAR}` references in config | `true` |
| `MCP_NO_DAEMON` | Disable connection caching | `false` |
| `MCP_DAEMON_TIMEOUT` | Idle timeout for cached connections in seconds | `60` |

## Common Errors

| Wrong Command | Error | Fix |
|---------------|-------|-----|
| `mcp-cli server tool` | AMBIGUOUS_COMMAND | Use `call server tool` or `info server tool` |
| `mcp-cli run server tool` | UNKNOWN_SUBCOMMAND | Use `call` instead of `run` |
| `mcp-cli list` | UNKNOWN_SUBCOMMAND | Use `info` instead of `list` |
| `mcp-cli call server` | MISSING_ARGUMENT | Add tool name |
| `mcp-cli call server tool {bad}` | INVALID_JSON | Use valid JSON with quotes |
| `mcp-cli info server` (HTTP) | AUTH_ERROR | Run `mcp-cli auth login server` and show the URL to the user |

## Exit Codes

- `0`: Success
- `1`: Client error (bad args, missing config)
- `2`: Server error (tool failed)
- `3`: Network error
- `4`: Authentication error (run the OAuth login flow)
