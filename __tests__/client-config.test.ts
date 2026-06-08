import assert from "node:assert";
import { describe, it } from "node:test";
import { claudeAdapter } from "../src/client-config/adapters/claude.js";
import { opencodeAdapter } from "../src/client-config/adapters/opencode.js";
import { getDefaultAdapterHome } from "../src/client-config/common.js";

// ---- Claude adapter ----

describe("Claude client config adapter", () => {
  it("extracts mcpServers and normalizes stdio entries", () => {
    const config = {
      other: true,
      mcpServers: {
        docs: {
          command: "npx",
          args: ["-y", "docs-server"],
          env: { TOKEN: "x" },
        },
      },
    };

    const servers = claudeAdapter.extractServers(config);
    const result = claudeAdapter.normalizeServer("docs", servers.docs);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.server.command, "npx");
    assert.deepEqual(result.server.args, ["-y", "docs-server"]);
    assert.deepEqual(result.server.env, { TOKEN: "x" });
  });

  it("writes mcp-adapter entry and preserves non-MCP fields", () => {
    const config = {
      theme: "dark",
      mcpServers: {
        old: { command: "node" },
      },
    };
    const entry = claudeAdapter.buildAdapterEntry({
      adapterHomeEnv: "~/.mcp-adapter",
    });

    const updated = claudeAdapter.installAdapterEntry(config, entry);

    assert.equal(updated.theme, "dark");
    assert.deepEqual(
      Object.keys(updated.mcpServers as Record<string, unknown>),
      ["mcp-adapter"],
    );
    assert.deepEqual(
      (updated.mcpServers as Record<string, { env: Record<string, string> }>)[
        "mcp-adapter"
      ].env,
      { MCP_ADAPTER_HOME: "~/.mcp-adapter" },
    );
  });
});

// ---- OpenCode adapter ----

describe("OpenCode client config adapter", () => {
  it("converts local entries to stdio server config", () => {
    const result = opencodeAdapter.normalizeServer("local", {
      type: "local",
      command: ["npx", "-y", "server"],
      environment: { TOKEN: "x" },
      enabled: false,
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.server.type, "stdio");
    assert.equal(result.server.command, "npx");
    assert.deepEqual(result.server.args, ["-y", "server"]);
    assert.deepEqual(result.server.env, { TOKEN: "x" });
    assert.equal(result.server.disabled, true);
  });

  it("converts non-oauth remote entries to http server config", () => {
    const result = opencodeAdapter.normalizeServer("remote", {
      type: "remote",
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer token" },
      oauth: false,
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.server.type, "http");
    assert.equal(result.server.url, "https://example.com/mcp");
    assert.deepEqual(result.server.headers, { Authorization: "Bearer token" });
  });

  it("skips remote OAuth entries", () => {
    const result = opencodeAdapter.normalizeServer("remote", {
      type: "remote",
      url: "https://example.com/mcp",
      oauth: { clientId: "x" },
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.reason, /OAuth/);
  });

  it("writes local mcp-adapter entry with environment", () => {
    const config = {
      $schema: "https://opencode.ai/config.json",
      mcp: {
        old: { type: "local", command: ["node", "server.js"] },
      },
    };
    const entry = opencodeAdapter.buildAdapterEntry({
      adapterHomeEnv: "~/.mcp-adapter-opencode",
    });

    const updated = opencodeAdapter.installAdapterEntry(config, entry);

    assert.equal(updated.$schema, "https://opencode.ai/config.json");
    assert.deepEqual(Object.keys(updated.mcp as Record<string, unknown>), [
      "mcp-adapter",
    ]);
    assert.deepEqual(
      (updated.mcp as Record<string, { environment: Record<string, string> }>)[
        "mcp-adapter"
      ].environment,
      { MCP_ADAPTER_HOME: "~/.mcp-adapter-opencode" },
    );
  });
});

// ---- workspace defaults ----

describe("adapter home defaults", () => {
  it("uses default workspace for Claude and isolated workspace for OpenCode", () => {
    const previous = process.env.MCP_ADAPTER_HOME;
    delete process.env.MCP_ADAPTER_HOME;
    try {
      assert.equal(getDefaultAdapterHome("claude").env, "~/.mcp-adapter");
      assert.equal(
        getDefaultAdapterHome("opencode").env,
        "~/.mcp-adapter-opencode",
      );
    } finally {
      if (previous === undefined) delete process.env.MCP_ADAPTER_HOME;
      else process.env.MCP_ADAPTER_HOME = previous;
    }
  });
});
