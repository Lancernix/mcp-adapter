// server-manager.test.ts - Offline integration tests for the failure backoff
// window and HTTP bearer header resolution (no real network required)

import assert from "node:assert";
import { describe, it } from "node:test";
import { McpServerManager, resolveHttpHeaders } from "../src/server-manager.js";
import type { ServerConfig } from "../src/types.js";

// ---- helpers ----

/** 一个 spawn 时立即 ENOENT 的命令，用于离线触发真实连接失败 */
function missingCommandConfig(): ServerConfig {
  return {
    type: "stdio",
    command: "mcp-adapter-missing-command-for-tests",
    args: [],
    connectTimeoutMs: 2000,
    closeTimeoutMs: 100,
  };
}

// ---- 失败冷却 ----

describe("McpServerManager 失败冷却", () => {
  it("连接失败后进入冷却，窗口内快速失败而非重新付出连接超时", async () => {
    const manager = new McpServerManager();
    const config = missingCommandConfig();

    await assert.rejects(
      () =>
        manager.connect("backoff-srv", config, { failureBackoffMs: 60_000 }),
      /连接底层真实 MCP 服务/,
    );

    const start = Date.now();
    await assert.rejects(
      () =>
        manager.connect("backoff-srv", config, { failureBackoffMs: 60_000 }),
      (err: Error) => {
        assert.match(err.message, /正在冷却/);
        assert.match(err.message, /剩余/);
        return true;
      },
    );
    // 冷却路径应远快于 connectTimeoutMs（2000ms）
    assert.ok(Date.now() - start < 2_000);
  });

  it("failureBackoffMs=0 时冷却机制关闭，每次都尝试真实连接", async () => {
    const manager = new McpServerManager();
    const config = missingCommandConfig();

    for (let i = 0; i < 2; i++) {
      await assert.rejects(
        () =>
          manager.connect("nocooldown-srv", config, { failureBackoffMs: 0 }),
        /连接底层真实 MCP 服务/,
      );
    }
  });

  it("不同 server 的冷却互相独立", async () => {
    const manager = new McpServerManager();
    const config = missingCommandConfig();

    await assert.rejects(
      () => manager.connect("srv-a", config, { failureBackoffMs: 60_000 }),
      /连接底层真实 MCP 服务/,
    );

    // srv-b 未失败过，虽然走真实连接会失败，但错误不是冷却错误
    await assert.rejects(
      () => manager.connect("srv-b", config, { failureBackoffMs: 60_000 }),
      (err: Error) => {
        assert.doesNotMatch(err.message, /正在冷却/);
        return true;
      },
    );
  });
});

// ---- resolveHttpHeaders（bearerTokenEnv） ----

describe("resolveHttpHeaders", () => {
  const base: ServerConfig = { type: "http", url: "https://example.com/mcp" };

  it("透传显式 headers", () => {
    const headers = resolveHttpHeaders(
      "srv",
      { ...base, headers: { "X-Trace": "1" } },
      {},
    );
    assert.deepEqual(headers, { "X-Trace": "1" });
  });

  it("bearerTokenEnv 从环境变量注入 Bearer 头", () => {
    const headers = resolveHttpHeaders(
      "srv",
      { ...base, bearerTokenEnv: "TEST_TOKEN_VAR" },
      { TEST_TOKEN_VAR: "abc" },
    );
    assert.equal(headers.Authorization, "Bearer abc");
  });

  it("显式 Authorization 优先于 bearerTokenEnv", () => {
    const headers = resolveHttpHeaders(
      "srv",
      {
        ...base,
        headers: { Authorization: "Bearer explicit" },
        bearerTokenEnv: "TEST_TOKEN_VAR",
      },
      { TEST_TOKEN_VAR: "abc" },
    );
    assert.equal(headers.Authorization, "Bearer explicit");
  });

  it("大小写不敏感识别已有 Authorization 头", () => {
    const headers = resolveHttpHeaders(
      "srv",
      {
        ...base,
        headers: { authorization: "Bearer x" },
        bearerTokenEnv: "TEST_TOKEN_VAR",
      },
      { TEST_TOKEN_VAR: "abc" },
    );
    assert.equal(headers.Authorization, undefined);
    assert.equal(headers.authorization, "Bearer x");
  });

  it("环境变量缺失或为空时报错", () => {
    assert.throws(
      () =>
        resolveHttpHeaders(
          "srv",
          { ...base, bearerTokenEnv: "MISSING_VAR_XYZ" },
          {},
        ),
      /bearerTokenEnv/,
    );
    assert.throws(
      () =>
        resolveHttpHeaders(
          "srv",
          { ...base, bearerTokenEnv: "EMPTY_VAR_XYZ" },
          { EMPTY_VAR_XYZ: "" },
        ),
      /未设置或为空/,
    );
  });
});
