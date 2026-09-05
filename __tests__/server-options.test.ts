// server-options.test.ts - Tests for per-server tool filters, failure backoff,
// and stdio env inheritance (features borrowed from pi-mcp-adapter)

import assert from "node:assert";
import { describe, it } from "node:test";
import {
  computeServerHash,
  filterServerTools,
  getValidCachedServers,
  toolPatternToRegExp,
} from "../src/cache-manager.js";
import { buildChildEnv } from "../src/config-manager.js";
import { FailureBackoff } from "../src/failure-backoff.js";
import type { AdapterConfig, CachedTool, MetadataCache } from "../src/types.js";

// ---- helpers ----

function makeTool(name: string): CachedTool {
  return { name, description: `${name} description` };
}

const TOOLS: CachedTool[] = [
  makeTool("sql_query"),
  makeTool("sql_insert"),
  makeTool("list_tables"),
  makeTool("health_check"),
];

// ---- filterServerTools ----

describe("filterServerTools", () => {
  it("无过滤配置时返回原数组引用", () => {
    assert.strictEqual(filterServerTools(TOOLS, {}), TOOLS);
  });

  it("includeTools 精确匹配", () => {
    const result = filterServerTools(TOOLS, {
      includeTools: ["sql_query", "list_tables"],
    });
    assert.deepEqual(
      result.map((t) => t.name),
      ["sql_query", "list_tables"],
    );
  });

  it("includeTools 支持 glob 通配", () => {
    const result = filterServerTools(TOOLS, { includeTools: ["sql_*"] });
    assert.deepEqual(
      result.map((t) => t.name),
      ["sql_query", "sql_insert"],
    );
  });

  it("excludeTools 在 includeTools 之后应用", () => {
    const result = filterServerTools(TOOLS, {
      includeTools: ["sql_*", "list_tables"],
      excludeTools: ["sql_insert"],
    });
    assert.deepEqual(
      result.map((t) => t.name),
      ["sql_query", "list_tables"],
    );
  });

  it("仅 excludeTools 时从全集剔除", () => {
    const result = filterServerTools(TOOLS, { excludeTools: ["health_*"] });
    assert.deepEqual(
      result.map((t) => t.name),
      ["sql_query", "sql_insert", "list_tables"],
    );
  });

  it("空字符串模式被忽略", () => {
    assert.strictEqual(filterServerTools(TOOLS, { includeTools: [""] }), TOOLS);
  });

  it("glob 特殊字符被正确转义", () => {
    const regexp = toolPatternToRegExp("a.b+c");
    assert.ok(regexp.test("a.b+c"));
    assert.ok(!regexp.test("axbyc"));
  });
});

// ---- getValidCachedServers：工具过滤端到端 ----

describe("getValidCachedServers 工具过滤", () => {
  function makeConfig(serverCfg: Record<string, unknown>): AdapterConfig {
    return {
      version: 1,
      settings: {},
      mcpServers: {
        srv: { type: "stdio", command: "node", ...serverCfg },
      },
    };
  }

  function makeCache(config: AdapterConfig): MetadataCache {
    return {
      version: 1,
      servers: {
        srv: {
          configHash: computeServerHash(config.mcpServers.srv),
          cachedAt: Date.now(),
          tools: TOOLS,
        },
      },
    };
  }

  it("缓存条目按 includeTools/excludeTools 过滤后输出", () => {
    const config = makeConfig({
      includeTools: ["sql_*"],
      excludeTools: ["sql_insert"],
    });
    const result = getValidCachedServers(config, makeCache(config));
    assert.deepEqual(
      result.srv.tools.map((t) => t.name),
      ["sql_query"],
    );
  });

  it("无过滤配置时缓存工具原样输出", () => {
    const config = makeConfig({});
    const result = getValidCachedServers(config, makeCache(config));
    assert.equal(result.srv.tools.length, TOOLS.length);
  });

  it("调整过滤配置不改变哈希指纹（不触发重新发现）", () => {
    const before = computeServerHash(
      makeConfig({ includeTools: ["sql_*"] }).mcpServers.srv,
    );
    const after = computeServerHash(
      makeConfig({ includeTools: ["all_*"], excludeTools: ["x"] }).mcpServers
        .srv,
    );
    assert.equal(before, after);
  });

  it("修改 command 仍会使哈希指纹变化", () => {
    const before = computeServerHash(makeConfig({}).mcpServers.srv);
    const after = computeServerHash({ type: "stdio", command: "python" });
    assert.notEqual(before, after);
  });
});

// ---- FailureBackoff ----

describe("FailureBackoff", () => {
  const T0 = 1_000_000;

  it("未记录失败时不在冷却期", () => {
    const backoff = new FailureBackoff();
    assert.strictEqual(backoff.remainingMs("srv", 60_000, T0), null);
  });

  it("冷却窗口内返回剩余毫秒数", () => {
    const backoff = new FailureBackoff();
    backoff.recordFailure("srv", T0);
    assert.strictEqual(backoff.remainingMs("srv", 60_000, T0 + 10_000), 50_000);
  });

  it("冷却窗口过后返回 null", () => {
    const backoff = new FailureBackoff();
    backoff.recordFailure("srv", T0);
    assert.strictEqual(backoff.remainingMs("srv", 60_000, T0 + 60_000), null);
    assert.strictEqual(backoff.remainingMs("srv", 60_000, T0 + 61_000), null);
  });

  it("windowMs 为 0 时冷却机制关闭", () => {
    const backoff = new FailureBackoff();
    backoff.recordFailure("srv", T0);
    assert.strictEqual(backoff.remainingMs("srv", 0, T0 + 1), null);
  });

  it("clear 清除冷却状态", () => {
    const backoff = new FailureBackoff();
    backoff.recordFailure("srv", T0);
    backoff.clear("srv");
    assert.strictEqual(backoff.remainingMs("srv", 60_000, T0 + 1), null);
  });
});

// ---- buildChildEnv inheritEnv ----

describe("buildChildEnv", () => {
  const PROBE = "MCP_ADAPTER_INHERIT_ENV_PROBE_VAR";

  it("默认继承宿主进程环境变量", () => {
    process.env[PROBE] = "1";
    try {
      assert.equal(buildChildEnv({ EXTRA: "x" })[PROBE], "1");
    } finally {
      delete process.env[PROBE];
    }
  });

  it("inheritEnv=false 时不继承宿主任意变量，但保留显式 env", () => {
    process.env[PROBE] = "1";
    try {
      const env = buildChildEnv({ EXTRA: "x" }, false);
      assert.equal(env[PROBE], undefined);
      assert.equal(env.EXTRA, "x");
      // 仍保留 SDK 的跨平台安全默认集（如 PATH）
      assert.ok(env.PATH || env.Path);
    } finally {
      delete process.env[PROBE];
    }
  });
});
