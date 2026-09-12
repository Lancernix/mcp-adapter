// server-options.test.ts - 服务专属配置项的单元测试
//
// 职责边界：这里只测**与服务配置解析相关的纯函数与工具对象**——
//   - filterServerTools：includeTools / excludeTools 的匹配语义
//   - resolveCwd / buildChildEnv：cwd 与 stdio 环境变量解析
//   - FailureBackoff：连接失败冷却
// 缓存层本身（配置指纹、有效性校验、落盘、快照、getValidCachedServers）
// 统一由 cache-manager.test.ts 负责，避免两处都测同一件事。

import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  filterServerTools,
  toolPatternToRegExp,
} from "../src/cache-manager.js";
import { buildChildEnv, resolveCwd } from "../src/config-manager.js";
import { FailureBackoff } from "../src/failure-backoff.js";
import type { CachedTool } from "../src/types.js";

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

  it("? 通配符匹配单个字符，不匹配空和多字符", () => {
    const result = filterServerTools(
      [makeTool("get"), makeTool("getA"), makeTool("getAB"), makeTool("ge")],
      { includeTools: ["get?"] },
    );
    assert.deepEqual(
      result.map((t) => t.name),
      ["getA"],
      "? 应当且仅当匹配一个字符",
    );
  });

  it("模式与工具名的匹配是大小写敏感的（锁定语义，不随实现漂移）", () => {
    const tools = [makeTool("Echo"), makeTool("echo")];

    assert.deepEqual(
      filterServerTools(tools, { includeTools: ["echo"] }).map((t) => t.name),
      ["echo"],
    );
    assert.deepEqual(
      filterServerTools(tools, { excludeTools: ["Echo"] }).map((t) => t.name),
      ["echo"],
    );
  });

  it("多个模式取并集，且没有任何命中时返回空数组", () => {
    assert.deepEqual(
      filterServerTools(TOOLS, {
        includeTools: ["list_tables", "health_check"],
      }).map((t) => t.name),
      ["list_tables", "health_check"],
    );
    assert.deepEqual(
      filterServerTools(TOOLS, { includeTools: ["nope_*"] }),
      [],
    );
  });

  it("通配符模式编译结果被缓存复用", () => {
    assert.strictEqual(
      toolPatternToRegExp("cached_*"),
      toolPatternToRegExp("cached_*"),
    );
  });

  it("includeTools 与 excludeTools 都为空数组时等价于不过滤", () => {
    assert.strictEqual(
      filterServerTools(TOOLS, { includeTools: [], excludeTools: [] }),
      TOOLS,
    );
  });
});

// ---- resolveCwd ----

describe("resolveCwd", () => {
  it("未配置时使用当前进程的工作目录", () => {
    assert.equal(resolveCwd(), process.cwd());
    assert.equal(resolveCwd(""), process.cwd());
  });

  it("~ 与 ~/xxx 展开为用户主目录", () => {
    assert.equal(resolveCwd("~"), os.homedir());
    assert.equal(resolveCwd("~/projects"), path.join(os.homedir(), "projects"));
  });

  it("相对路径基于当前工作目录解析，绝对路径原样返回", () => {
    assert.equal(resolveCwd("./sub"), path.resolve("./sub"));
    assert.equal(resolveCwd("/tmp/work"), "/tmp/work");
  });

  it("路径中段出现的 ~ 不做展开（只处理开头）", () => {
    assert.equal(resolveCwd("/tmp/~backup"), path.resolve("/tmp/~backup"));
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

  it("显式 env 覆盖同名的宿主变量", () => {
    process.env[PROBE] = "host";
    try {
      assert.equal(buildChildEnv({ [PROBE]: "config" })[PROBE], "config");
      assert.equal(
        buildChildEnv({ [PROBE]: "config" }, false)[PROBE],
        "config",
      );
    } finally {
      delete process.env[PROBE];
    }
  });

  it("空字符串的值会被保留，不会被当成未设置而丢弃", () => {
    const env = buildChildEnv({ EMPTY: "" }, false);
    assert.equal(env.EMPTY, "");
  });

  it("输出环境对象里只有字符串值（spawn 不接受其它类型）", () => {
    process.env[PROBE] = "v";
    try {
      for (const env of [buildChildEnv(), buildChildEnv({ A: "1" }, false)]) {
        assert.equal(
          Object.values(env).some((value) => typeof value !== "string"),
          false,
        );
      }
    } finally {
      delete process.env[PROBE];
    }
  });
});
