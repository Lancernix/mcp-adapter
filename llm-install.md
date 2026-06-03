# mcp-adapter AI Installation Guide

This document is an AI agent installation guide for `@lancernix/mcp-adapter`.

## Client Detection

The `import` command defaults to reading `~/.claude.json` (Claude Code configuration).

- **Claude Code users**: Quick import workflow below
- **Other clients**: Use `--from <path>` to specify your config file:
  - Cursor: `~/.cursor/mcp.json`
  - Windsurf: `~/.codeium/windsurf/mcp_config.json`
  - Cline: `~/.cline/mcp_settings.json`

## Step 1: Register MCP Server

Add to your client's MCP configuration (e.g., `~/.claude.json` for Claude Code):

```json
{
  "mcpServers": {
    "mcp-adapter": {
      "command": "npx",
      "args": ["-y", "@lancernix/mcp-adapter@latest"]
    }
  }
}
```

The `@latest` tag ensures automatic updates on each startup.

## Step 2: Import Existing Configuration

**Preview first** (recommended):

```bash
npx -y @lancernix/mcp-adapter@latest import --dry-run
```

**Confirm and import**:

```bash
npx -y @lancernix/mcp-adapter@latest import
```

Configuration will be written to `~/.mcp-adapter/config.json`.

**Notes:**
- The import command automatically skips mcp-adapter's own entry — no self-reference risk.
- After import succeeds, **remove all original MCP server entries** from `~/.claude.json`, keeping **only** the `mcp-adapter` entry. Otherwise the same tools will appear twice (direct path + meta-tool proxy path).

## Step 3: Configure Aliases (Optional)

Aliases improve search accuracy for `search_tools`. Edit `~/.mcp-adapter/config.json`:

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

## Step 4: Verify Installation

Restart your AI client. You should see 4 meta-tools available:

- `search_tools` - Search for tools by keyword
- `list_tools` - List all tools in a server
- `describe_tool` - Get full schema for a tool
- `execute_tool` - Execute a tool

Test with:

```
search_tools(query="resolve library documentation")
```

## Troubleshooting

- **Connection timeout**: Check that the underlying MCP server is accessible
- **Tool not found**: Verify the server is registered in `~/.mcp-adapter/config.json`
- **Cache issues**: Delete `~/.mcp-adapter/cache.json` to force metadata refresh

## More Information

Full documentation: https://github.com/Lancernix/mcp-adapter
