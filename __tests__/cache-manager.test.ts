// cache-manager.test.ts - 缓存指纹、有效性校验与落盘安全
//
// 缓存是否被判定为"有效"，直接决定 search_tools 能不能搜到工具、以及 adapter
// 启动时会不会主动拉起子进程。这里的三个校验（结构 / configHash / TTL）是整套
// 惰性发现机制的地基，任何一条被改坏都会表现为"工具莫名搜不到"。

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  computeServerHash,
  getValidCachedServers,
  isServerCacheValid,
  loadMetadataCache,
  saveMetadataCache,
  stableStringify,
} from "../src/cache-manager.js";
import { getCachePath } from "../src/config-manager.js";
import type {
  MetadataCache,
  ServerCacheEntry,
  ServerConfig,
} from "../src/types.js";

function freshHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-adapter-cache-home-"));
  process.env.MCP_ADAPTER_HOME = dir;
  return dir;
}

const BASE_SERVER: ServerConfig = {
  type: "stdio",
  command: "node",
  args: ["server.js"],
  env: { TOKEN: "abc" },
};

function entryFor(
  definition: ServerConfig,
  overrides: Partial<ServerCacheEntry> = {},
): ServerCacheEntry {
  return {
    configHash: computeServerHash(definition),
    cachedAt: Date.now(),
    tools: [{ name: "echo", description: "回显" }],
    ...overrides,
  };
}

// ---- 配置指纹 ----

describe("computeServerHash", () => {
  it("相同配置产生相同指纹，且字段书写顺序不影响结果", () => {
    const a: ServerConfig = {
      type: "stdio",
      command: "node",
      args: ["x.js"],
      env: { A: "1", B: "2" },
    };
    const b: ServerConfig = {
      env: { B: "2", A: "1" },
      args: ["x.js"],
      command: "node",
      type: "stdio",
    };
    assert.equal(computeServerHash(a), computeServerHash(b));
  });

  it("影响工具集的连接字段变化会改变指纹", () => {
    const base = computeServerHash(BASE_SERVER);

    assert.notEqual(
      base,
      computeServerHash({ ...BASE_SERVER, command: "other" }),
    );
    assert.notEqual(
      base,
      computeServerHash({ ...BASE_SERVER, args: ["other.js"] }),
    );
    assert.notEqual(
      base,
      computeServerHash({ ...BASE_SERVER, env: { TOKEN: "x" } }),
    );
    assert.notEqual(
      base,
      computeServerHash({ ...BASE_SERVER, type: "http", url: "https://x/mcp" }),
    );
    assert.notEqual(base, computeServerHash({ ...BASE_SERVER, cwd: "/tmp" }));
    assert.notEqual(
      base,
      computeServerHash({ ...BASE_SERVER, headers: { "X-A": "1" } }),
    );
  });

  it("adapter 侧元数据字段变化不会改变指纹（不该触发重新发现）", () => {
    const base = computeServerHash(BASE_SERVER);

    const metaOnly: ServerConfig[] = [
      { ...BASE_SERVER, aliases: ["别名"] },
      { ...BASE_SERVER, lifecycle: "eager" },
      { ...BASE_SERVER, disabled: true },
      { ...BASE_SERVER, idleTimeout: 1 },
      { ...BASE_SERVER, refreshOnStartup: true },
      { ...BASE_SERVER, connectTimeoutMs: 1 },
      { ...BASE_SERVER, requestTimeoutMs: 1 },
      { ...BASE_SERVER, closeTimeoutMs: 1 },
      { ...BASE_SERVER, includeTools: ["echo"] },
      { ...BASE_SERVER, excludeTools: ["crash"] },
    ];

    for (const variant of metaOnly) {
      assert.equal(
        computeServerHash(variant),
        base,
        `元数据字段不该进入指纹：${JSON.stringify(variant)}`,
      );
    }
  });

  it("stableStringify 对嵌套对象同样稳定", () => {
    assert.equal(
      stableStringify({ b: { d: 1, c: 2 }, a: [1, { y: 1, x: 2 }] }),
      stableStringify({ a: [1, { x: 2, y: 1 }], b: { c: 2, d: 1 } }),
    );
  });
});

// ---- 有效性三校验 ----

describe("isServerCacheValid", () => {
  it("结构、指纹、TTL 全部通过时判定有效", () => {
    assert.equal(isServerCacheValid(entryFor(BASE_SERVER), BASE_SERVER), true);
  });

  it("结构不合法（缺字段 / 类型不对 / 非对象）一律判定无效", () => {
    const definition = BASE_SERVER;
    for (const broken of [
      undefined,
      null,
      {},
      { configHash: 1, cachedAt: 1, tools: [] },
      { configHash: "x", cachedAt: "y", tools: [] },
      { configHash: "x", cachedAt: 1, tools: "not-array" },
    ]) {
      assert.equal(
        isServerCacheValid(broken as ServerCacheEntry, definition),
        false,
        `非法结构应判定无效：${JSON.stringify(broken)}`,
      );
    }
  });

  it("configHash 不匹配时判定无效（配置变了）", () => {
    const entry = entryFor(BASE_SERVER, { configHash: "stale" });
    assert.equal(isServerCacheValid(entry, BASE_SERVER), false);
    // 换成新配置后，用新配置算出来的指纹又应当有效
    assert.equal(isServerCacheValid(entryFor(BASE_SERVER), BASE_SERVER), true);
  });

  it("TTL 过期时判定无效，maxAgeMs=0 表示不因年龄失效", () => {
    const entry = entryFor(BASE_SERVER, { cachedAt: Date.now() - 10_000 });

    assert.equal(isServerCacheValid(entry, BASE_SERVER, 1_000), false);
    assert.equal(isServerCacheValid(entry, BASE_SERVER, 60_000), true);
    assert.equal(
      isServerCacheValid(entry, BASE_SERVER, 0),
      true,
      "cacheTtlDays: 0 应表示不因 TTL 过期",
    );
  });
});

// ---- 落盘安全 ----

describe("metadata cache 落盘", () => {
  it("loadMetadataCache 在文件缺失、损坏、版本不符时返回 null", () => {
    const home = freshHome();
    assert.equal(loadMetadataCache(), null, "文件不存在应返回 null");

    fs.writeFileSync(getCachePath(home), "{ 不是合法 JSON", "utf-8");
    assert.equal(loadMetadataCache(), null, "损坏的 JSON 应返回 null");

    fs.writeFileSync(
      getCachePath(home),
      JSON.stringify({ version: 999, servers: {} }),
      "utf-8",
    );
    assert.equal(loadMetadataCache(), null, "版本不符应返回 null");
  });

  it("保存时与已有缓存合并，不会冲掉其他服务的条目", async () => {
    freshHome();

    await saveMetadataCache({
      version: 1,
      servers: { alpha: entryFor(BASE_SERVER) },
    });
    await saveMetadataCache({
      version: 1,
      servers: { beta: entryFor(BASE_SERVER) },
    });

    const merged = loadMetadataCache();
    assert.deepEqual(Object.keys(merged?.servers ?? {}).sort(), [
      "alpha",
      "beta",
    ]);
  });

  it("并发保存不同服务时全部保留（串行写队列 + 读改写合并）", async () => {
    freshHome();

    await Promise.all(
      ["a", "b", "c", "d", "e"].map((name) =>
        saveMetadataCache({
          version: 1,
          servers: { [name]: entryFor(BASE_SERVER) },
        }),
      ),
    );

    const merged = loadMetadataCache();
    assert.deepEqual(Object.keys(merged?.servers ?? {}).sort(), [
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
  });

  it("同名服务重复保存时以最后一次为准", async () => {
    freshHome();

    await saveMetadataCache({
      version: 1,
      servers: { same: entryFor(BASE_SERVER) },
    });
    await saveMetadataCache({
      version: 1,
      servers: {
        same: entryFor(BASE_SERVER, {
          tools: [{ name: "newer" }, { name: "second" }],
        }),
      },
    });

    const merged = loadMetadataCache();
    assert.deepEqual(
      merged?.servers.same.tools.map((tool) => tool.name),
      ["newer", "second"],
    );
  });

  it("缓存文件权限被收紧为 0600", async () => {
    const home = freshHome();
    await saveMetadataCache({
      version: 1,
      servers: { alpha: entryFor(BASE_SERVER) },
    });

    const mode = fs.statSync(getCachePath(home)).mode & 0o777;
    assert.equal(mode, 0o600);
  });
});

// ---- 进程内快照（mtime 短路）----

describe("metadata cache 进程内快照", () => {
  function write(dir: string, servers: Record<string, ServerCacheEntry>): void {
    fs.writeFileSync(
      getCachePath(dir),
      JSON.stringify({ version: 1, servers }, null, 2),
      "utf-8",
    );
  }

  it("外部进程改写 cache.json 后能读到新内容，不会返回过期快照", () => {
    const home = freshHome();

    write(home, {
      alpha: entryFor(BASE_SERVER, { tools: [{ name: "t1" }] }),
    });
    assert.equal(loadMetadataCache()?.servers.alpha.tools[0].name, "t1");

    // 模拟另一个 adapter 进程写入：条目不同、长度也不同
    write(home, {
      beta: entryFor(BASE_SERVER, { tools: [{ name: "t2" }, { name: "t3" }] }),
    });

    const after = loadMetadataCache();
    assert.equal(after?.servers.beta?.tools.length, 2);
    assert.equal(
      after?.servers.alpha,
      undefined,
      "不应命中外层进程写入前的快照",
    );
  });

  it("本进程写入后立即可见（写入会让快照失效）", async () => {
    const home = freshHome();

    await saveMetadataCache({
      version: 1,
      servers: { alpha: entryFor(BASE_SERVER, { tools: [{ name: "first" }] }) },
    });
    assert.equal(loadMetadataCache()?.servers.alpha.tools[0].name, "first");

    await saveMetadataCache({
      version: 1,
      servers: {
        alpha: entryFor(BASE_SERVER, { tools: [{ name: "second" }] }),
      },
    });
    assert.equal(
      loadMetadataCache()?.servers.alpha.tools[0].name,
      "second",
      "自己写完必须能立刻读到，不能命中写入前的快照",
    );

    assert.ok(fs.existsSync(getCachePath(home)));
  });

  it("切换到另一个工作区时不会命中上一个工作区的快照", () => {
    const homeA = freshHome();
    write(homeA, {
      onlyInA: entryFor(BASE_SERVER, { tools: [{ name: "a" }] }),
    });
    assert.equal(loadMetadataCache()?.servers.onlyInA?.tools[0].name, "a");

    const homeB = freshHome();
    assert.equal(
      loadMetadataCache(),
      null,
      "新工作区还没有 cache.json，不得返回上一个工作区的快照",
    );

    write(homeB, {
      onlyInB: entryFor(BASE_SERVER, { tools: [{ name: "b" }] }),
    });
    const inB = loadMetadataCache();
    assert.equal(inB?.servers.onlyInB?.tools[0].name, "b");
    assert.equal(inB?.servers.onlyInA, undefined);
  });

  it("cache.json 被删除后返回 null，不会继续返回旧快照", () => {
    const home = freshHome();
    write(home, { alpha: entryFor(BASE_SERVER) });
    assert.ok(loadMetadataCache());

    fs.unlinkSync(getCachePath(home));
    assert.equal(loadMetadataCache(), null, "文件没了就不该再返回快照");
  });

  it("缓存内容损坏时返回 null，修好后能恢复读取", () => {
    const home = freshHome();

    fs.writeFileSync(getCachePath(home), "{ 坏掉的 JSON", "utf-8");
    assert.equal(loadMetadataCache(), null);

    write(home, { alpha: entryFor(BASE_SERVER) });
    assert.deepEqual(Object.keys(loadMetadataCache()?.servers ?? {}), [
      "alpha",
    ]);
  });
});

// ---- 有效服务筛选 ----

describe("getValidCachedServers", () => {
  it("同时应用 disabled、指纹、TTL 与工具过滤四种约束", () => {
    freshHome();

    const enabled: ServerConfig = { ...BASE_SERVER, aliases: ["可用"] };
    const disabled: ServerConfig = { ...BASE_SERVER, disabled: true };
    const filtered: ServerConfig = {
      ...BASE_SERVER,
      excludeTools: ["crash"],
    };

    const cache: MetadataCache = {
      version: 1,
      servers: {
        enabled: entryFor(enabled, {
          tools: [{ name: "echo" }, { name: "crash" }],
        }),
        disabled: entryFor(disabled),
        filtered: entryFor(filtered, {
          tools: [{ name: "echo" }, { name: "crash" }],
        }),
        staleHash: entryFor(enabled, { configHash: "stale" }),
        expired: entryFor(enabled, {
          cachedAt: Date.now() - 30 * 24 * 3600 * 1000,
        }),
      },
    };

    const config = {
      version: 1,
      settings: { cacheTtlDays: 7 },
      mcpServers: {
        enabled,
        disabled,
        filtered,
        staleHash: enabled,
        expired: enabled,
      },
    };

    const valid = getValidCachedServers(config, cache);

    assert.deepEqual(Object.keys(valid).sort(), ["enabled", "filtered"]);
    assert.deepEqual(
      valid.filtered.tools.map((tool) => tool.name),
      ["echo"],
      "excludeTools 应在读取缓存时就被应用",
    );
  });

  it("缓存里的工具过滤同样支持 glob，且 include 先于 exclude", () => {
    freshHome();

    const globbed: ServerConfig = {
      ...BASE_SERVER,
      includeTools: ["sql_*"],
      excludeTools: ["sql_insert"],
    };
    const cache: MetadataCache = {
      version: 1,
      servers: {
        srv: entryFor(globbed, {
          tools: [
            { name: "sql_query" },
            { name: "sql_insert" },
            { name: "list_tables" },
          ],
        }),
      },
    };
    const config = {
      version: 1,
      settings: { cacheTtlDays: 7 },
      mcpServers: { srv: globbed },
    };

    const valid = getValidCachedServers(config, cache);
    assert.deepEqual(
      valid.srv.tools.map((tool) => tool.name),
      ["sql_query"],
    );
  });

  it("无过滤配置时缓存工具原样输出", () => {
    freshHome();

    const plain = BASE_SERVER;
    const tools = [{ name: "a" }, { name: "b" }, { name: "c" }];
    const cache: MetadataCache = {
      version: 1,
      servers: { srv: entryFor(plain, { tools }) },
    };
    const config = {
      version: 1,
      settings: { cacheTtlDays: 7 },
      mcpServers: { srv: plain },
    };

    assert.deepEqual(
      getValidCachedServers(config, cache).srv.tools.map((tool) => tool.name),
      ["a", "b", "c"],
    );
  });
});
