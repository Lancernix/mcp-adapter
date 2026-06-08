# mcp-adapter AI Installation Guide

This document is an AI agent installation guide for `@lancernix/mcp-adapter`.

## Supported Clients

The `import` command can parse and rewrite supported AI client MCP configurations.

| Client | `--client` | Default Config Path | Import Support |
|--------|------------|---------------------|----------------|
| Claude Code | `claude` | `~/.claude.json` | Read `mcpServers`, write `mcpServers["mcp-adapter"]` |
| OpenCode | `opencode` | `$OPENCODE_CONFIG`, then `~/.config/opencode/opencode.json` | Read `mcp`, write `mcp["mcp-adapter"]` |

Notes:
- OpenCode `local` MCP entries are converted to mcp-adapter `stdio` servers.
- OpenCode `remote` MCP entries are converted to mcp-adapter `http` servers only when `oauth` is absent or `false`.
- OpenCode remote OAuth entries are skipped because OAuth state cannot be migrated safely.
- OMP does not need mcp-adapter because its native `mcp-only` discovery mode is already lightweight.

## Step 1: Preview Import

Always start with dry-run:

```bash
# Claude Code
npx -y @lancernix/mcp-adapter@latest import --client claude --from ~/.claude.json --dry-run

# OpenCode
npx -y @lancernix/mcp-adapter@latest import --client opencode --from ~/.config/opencode/opencode.json --dry-run
```

Dry-run prints:
- the source client and config path
- the mcp-adapter target config path
- imported and skipped MCP servers
- the exact mcp-adapter entry that would be written back to the client config

If exactly one supported config is detected, this also works:

```bash
npx -y @lancernix/mcp-adapter@latest import --dry-run
```

Formal import requires explicit `--client` and `--from`.

## Step 2: Import Existing MCP Servers

Write only mcp-adapter's own config:

```bash
# Claude Code
npx -y @lancernix/mcp-adapter@latest import --client claude --from ~/.claude.json

# OpenCode
npx -y @lancernix/mcp-adapter@latest import --client opencode --from ~/.config/opencode/opencode.json
```

This writes to:

```text
~/.mcp-adapter/config.json              # Claude Code
~/.mcp-adapter-opencode/config.json     # OpenCode
```

The generated client entry always contains an explicit `MCP_ADAPTER_HOME`, even for the default workspace.

## Step 3: Rewrite Client MCP Config (Optional)

After reviewing dry-run output, you can let mcp-adapter rewrite the source client config so it keeps only the `mcp-adapter` entry in its MCP section:

```bash
# Claude Code
npx -y @lancernix/mcp-adapter@latest import --client claude --from ~/.claude.json --write-client-config

# OpenCode
npx -y @lancernix/mcp-adapter@latest import --client opencode --from ~/.config/opencode/opencode.json --write-client-config
```

This preserves non-MCP fields in the client config, replaces the MCP server section with a single `mcp-adapter` entry, and writes `MCP_ADAPTER_HOME` explicitly.

Claude Code output shape:

```json
{
  "mcpServers": {
    "mcp-adapter": {
      "command": "npx",
      "args": ["-y", "@lancernix/mcp-adapter@latest"],
      "env": {
        "MCP_ADAPTER_HOME": "~/.mcp-adapter"
      }
    }
  }
}
```

OpenCode output shape:

```json
{
  "mcp": {
    "mcp-adapter": {
      "type": "local",
      "command": ["npx", "-y", "@lancernix/mcp-adapter@latest"],
      "environment": {
        "MCP_ADAPTER_HOME": "~/.mcp-adapter-opencode"
      }
    }
  }
}
```

## Step 4: Configure Aliases (Optional)

Aliases improve search accuracy for `search_tools`. Edit the `config.json` in the mcp-adapter workspace printed by the import command:

```json
{
  "mcpServers": {
    "context7": {
      "aliases": ["ctx7", "documentation", "docs", "查文档"]
    },
    "filesystem": {
      "aliases": ["文件", "文件系统", "fs", "files"]
    }
  }
}
```

## Step 5: Verify Installation

Restart your AI client. You should see 4 meta-tools available:

- `search_tools` - Search for tools by keyword
- `list_tools` - List all tools in a server
- `describe_tool` - Get full schema for a tool
- `execute_tool` - Execute a tool

Test with:

```text
search_tools(query="resolve library documentation")
```

## Troubleshooting

- **Connection timeout**: Check that the underlying MCP server is accessible
- **Tool not found**: Verify the server is registered in the mcp-adapter workspace printed by `mcp-adapter import`
- **Cache issues**: Delete `cache.json` in that workspace to force metadata refresh
- **Import can't find source config**: Use `--client <name> --from <path>` to specify the client and config file directly
- **OpenCode OAuth remote skipped**: Reconfigure that remote service manually, or keep it outside mcp-adapter until OAuth migration is supported

## More Information

Full documentation: https://github.com/Lancernix/mcp-adapter
