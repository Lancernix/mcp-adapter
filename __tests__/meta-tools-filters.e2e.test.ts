// meta-tools-filters.e2e.test.ts - 可见性/可执行性过滤与启动体检开关
//
// 覆盖：重名冲突的 describe/execute 处理 / includeTools·excludeTools 的
//      可见性与可执行性 / disabled 服务的隔离 / 关闭启动期体检后的
//      按需刷新与旧字段 metadataBootstrap 的迁移提示

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import {
  type AdapterHandle,
  callTool,
  FAKE_TOOLS,
  fakeServer,
  flushAdapters,
  startAdapter,
  textOf,
  waitForCache,
} from "./e2e-harness.js";
import { delay, waitFor } from "./helpers.js";

after(flushAdapters);

describe("元工具 - 重名冲突、过滤与禁用 (e2e)", () => {
  let adapter: AdapterHandle;

  /** disabled 服务如果被错误拉起，只会写进这个独立文件 */
  let disabledSpawnLog = "";

  before(async () => {
    adapter = await startAdapter(({ home, spawnLog }) => {
      disabledSpawnLog = path.join(home, "spawn-disabled.log");
      return {
        version: 1,
        settings: { startupMetadataCheck: true },
        mcpServers: {
          // 与 beta 存在同名工具 echo，用来验证冲突处理
          alpha: fakeServer({
            aliases: ["阿尔法"],
            env: { FAKE_SPAWN_LOG: spawnLog },
          }),
          beta: fakeServer({
            aliases: ["贝塔"],
            env: { FAKE_SPAWN_LOG: spawnLog },
          }),
          // 黑名单：crash 与 sleep 不可发现也不可执行
          gamma: fakeServer({
            excludeTools: ["crash", "sleep"],
            env: { FAKE_SPAWN_LOG: spawnLog },
          }),
          // 白名单：只暴露 echo 与 pid（等价于排除另外两个）
          delta: fakeServer({
            includeTools: ["echo", "pid"],
            env: { FAKE_SPAWN_LOG: spawnLog },
          }),
          off: fakeServer({
            disabled: true,
            env: { FAKE_SPAWN_LOG: disabledSpawnLog },
          }),
        },
      };
    });
    await waitForCache(adapter.home, ["alpha", "beta", "gamma", "delta"]);
  });

  after(async () => {
    await adapter.stop();
  });

  it("重名工具在 describe_tool 时提示冲突并要求指定 server", async () => {
    const result = await callTool(adapter.client, "describe_tool", {
      tool: "echo",
    });
    const text = textOf(result);

    assert.match(text, /存在于多个服务器上/);
    assert.match(text, /alpha\.echo/);
    assert.match(text, /beta\.echo/);
  });

  it("重名工具在 execute_tool 时同样被拒绝，避免误调", async () => {
    const result = await callTool(adapter.client, "execute_tool", {
      tool: "echo",
      arguments: { text: "x" },
    });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /重名冲突/);
    assert.match(textOf(result), /请显式提供 server 参数/);
  });

  it("显式指定 server 即可消除重名冲突", async () => {
    const described = await callTool(adapter.client, "describe_tool", {
      tool: "echo",
      server: "贝塔",
    });
    assert.match(textOf(described), /工具全名: \*\*beta\.echo\*\*/);

    const executed = await callTool(adapter.client, "execute_tool", {
      tool: "echo",
      server: "alpha",
      arguments: { text: "resolved" },
    });
    assert.equal(textOf(executed), "echo:resolved");
  });

  it("excludeTools 排除的工具不可发现（list / search 都看不到）", async () => {
    const listed = await callTool(adapter.client, "list_tools", {
      server: "gamma",
    });
    const text = textOf(listed);

    assert.match(
      text,
      new RegExp(`gamma 共有 ${FAKE_TOOLS.length - 2} 个工具`),
    );
    assert.match(text, /\becho\b/);
    assert.match(text, /\bpid\b/);
    assert.doesNotMatch(text, /\bcrash\b/);
    assert.doesNotMatch(text, /\bsleep\b/);

    const searched = await callTool(adapter.client, "search_tools", {
      query: "crash",
      server: "gamma",
    });
    assert.doesNotMatch(textOf(searched), /gamma\.crash/);
  });

  it("excludeTools 排除的工具也不可执行", async () => {
    const result = await callTool(adapter.client, "execute_tool", {
      tool: "gamma.crash",
    });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /includeTools\/excludeTools/);
  });

  it("includeTools 白名单同样同时约束可见性与可执行性", async () => {
    const listed = await callTool(adapter.client, "list_tools", {
      server: "delta",
    });
    assert.match(textOf(listed), /delta 共有 2 个工具/);
    assert.doesNotMatch(textOf(listed), /\bcrash\b/);

    const executed = await callTool(adapter.client, "execute_tool", {
      tool: "delta.crash",
    });
    assert.equal(executed.isError, true);
    assert.match(textOf(executed), /includeTools\/excludeTools/);
  });

  it("disabled 的服务不参与体检，也不会拉起子进程", async () => {
    // 只有启用中的 4 个服务写过自己的 spawn 记录
    assert.ok(
      adapter.spawnedPids().length >= 4,
      "启用中的服务应至少各被拉起一次",
    );
    // disabled 服务有独立的 spawn 记录文件：它不该存在
    assert.equal(
      fs.existsSync(disabledSpawnLog),
      false,
      "disabled 服务不应被拉起，但它产生了 spawn 记录",
    );

    const listed = await callTool(adapter.client, "list_tools", {
      server: "off",
    });
    assert.match(textOf(listed), /已被 disabled/);
  });

  it("disabled 的服务即使直接点名执行也会被拒绝", async () => {
    const result = await callTool(adapter.client, "execute_tool", {
      tool: "off.echo",
      arguments: { text: "x" },
    });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /已被 disabled/);
  });

  it("被 excludeTools 排除的工具在全局搜索里同样不可见", async () => {
    // alpha / beta 的 crash 是可见的，只有 gamma 的被排除；全局搜索不该带出 gamma.crash
    const result = await callTool(adapter.client, "search_tools", {
      query: "crash",
    });
    const text = textOf(result);

    assert.match(
      text,
      /alpha\.crash|beta\.crash/,
      "其他服务的同名工具应正常返回",
    );
    assert.doesNotMatch(
      text,
      /gamma\.crash/,
      "被排除的工具不允许通过全局搜索绕过可见性过滤",
    );
  });
});

describe("元工具 - 关闭启动期体检后的按需刷新 (e2e)", () => {
  let adapter: AdapterHandle;

  before(async () => {
    adapter = await startAdapter({
      version: 1,
      // 故意使用旧字段名，顺带验证迁移提示会出现在启动日志里
      settings: { metadataBootstrap: "off" },
      mcpServers: {
        demo: fakeServer({ aliases: ["演示服务"] }),
      },
    });
  });

  after(async () => {
    await adapter.stop();
  });

  it("旧字段 metadataBootstrap 会被兼容并在启动日志中给出迁移提示", async () => {
    const ready = await waitFor(() =>
      adapter.logs().includes("[Config-Migration]"),
    );
    assert.ok(ready, `未看到迁移提示，实际 stderr：\n${adapter.logs()}`);
    assert.match(
      adapter.logs(),
      /metadataBootstrap 已更名为 settings\.startupMetadataCheck/,
    );
    assert.match(adapter.logs(), /off → false/);
  });

  it("启动后不会主动体检，cache.json 不会被写入", async () => {
    await delay(600);
    assert.equal(
      fs.existsSync(path.join(adapter.home, "cache.json")),
      false,
      "关闭启动期体检后不应产生 cache.json",
    );
    assert.match(
      adapter.logs(),
      /已关闭启动期 metadata 体检（startupMetadataCheck: false）/,
    );
    assert.equal(adapter.spawnedPids().length, 0, "不应为了体检拉起任何子进程");
  });

  it("无结果时给出与关闭体检一致的引导文案", async () => {
    const result = await callTool(adapter.client, "search_tools", {
      query: "echo",
    });
    const text = textOf(result);

    assert.match(text, /当前 metadata cache 为空/);
    assert.match(text, /已关闭启动期 metadata 体检/);
    assert.match(text, /手动触发对应服务的 metadata 刷新/);
  });

  it("带 server 提示的检索会触发按需刷新，之后即可正常搜索与执行", async () => {
    const searched = await callTool(adapter.client, "search_tools", {
      query: "echo",
      server: "demo",
    });
    assert.match(textOf(searched), /demo\.echo/);

    // 按需刷新同样会写回 cache.json
    await waitForCache(adapter.home, ["demo"]);

    const executed = await callTool(adapter.client, "execute_tool", {
      tool: "demo.echo",
      arguments: { text: "on-demand" },
    });
    assert.equal(textOf(executed), "echo:on-demand");
  });
});
