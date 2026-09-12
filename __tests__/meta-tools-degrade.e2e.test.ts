// meta-tools-degrade.e2e.test.ts - server 提示指向不可用服务时的降级行为
//
// 覆盖：高置信 hint 的服务拉不起来时降级为全局搜索而不是报错 /
//      同一次搜索不对同一服务重复尝试刷新（spawn 计数为主判据）/
//      服务可用时降级逻辑不影响正常窄化

import assert from "node:assert/strict";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import {
  type AdapterHandle,
  callTool,
  fakeServer,
  startAdapter,
  textOf,
  waitForCache,
} from "./e2e-harness.js";
import { readPids } from "./helpers.js";

describe("元工具 - server 提示指向不可用服务时降级为全局搜索 (e2e)", () => {
  let adapter: AdapterHandle;
  /** broken 独占的 spawn 记录：每次刷新尝试必然拉起一个子进程，用它数"刷了几次" */
  let brokenSpawnLog = "";

  before(async () => {
    adapter = await startAdapter((ctx) => {
      brokenSpawnLog = path.join(ctx.home, "broken-spawn.log");
      return {
        version: 1,
        // failureBackoffMs 必须显式关掉：默认 60s 冷却会把失败后的再次刷新变成
        // 0ms 快速失败，下方"不重复刷新"用例将因此失去判别力——即使去掉去重
        // 逻辑，第二次尝试也会被冷却瞬间弹回，次数和耗时都看不出差别。
        settings: { startupMetadataCheck: true, failureBackoffMs: 0 },
        mcpServers: {
          // initialize 被延迟 3s，而建连超时只有 800ms → 刷新必然失败，
          // 且每次失败都要实打实等满 800ms
          broken: fakeServer({
            env: {
              FAKE_INIT_DELAY_MS: "3000",
              FAKE_SPAWN_LOG: brokenSpawnLog,
            },
            connectTimeoutMs: 800,
          }),
          ok: fakeServer({ aliases: ["可用服务"] }),
        },
      };
    });
    await waitForCache(adapter.home, ["ok"]);
  });

  after(async () => {
    await adapter.stop();
  });

  it("server 提示解析成功但服务拉不起来时，降级为全局搜索而不是直接报错", async () => {
    const result = await callTool(adapter.client, "search_tools", {
      query: "echo",
      server: "broken",
    });
    const text = textOf(result);

    // 关键断言：不是 isError，也不是把整条搜索打断成一句错误提示
    assert.equal(
      result.isError,
      undefined,
      "刷新失败应当降级为全局搜索，而不是把整条搜索打断",
    );
    assert.match(text, /已降级为全局搜索/);
    assert.match(text, /该服务当前无法访问/);
    // 全局搜索必须真的返回了其它服务的结果
    assert.match(text, /ok\.echo/);
  });

  it("降级后不会对同一个服务反复尝试刷新（避免一次搜索等两次连接超时）", async () => {
    // query 里再次提到 broken 时，若没有去重就会再刷一次、再等满一个 800ms 超时。
    // 预热一次，让后续的计时不被首次启动开销污染。
    await callTool(adapter.client, "search_tools", {
      query: "echo",
      server: "broken",
    });

    // 主判据用 spawn 计数而不是耗时：每次刷新尝试必然拉起一个子进程，
    // 去不掉就是 2 次、去重生效就是 1 次，与机器快慢无关。
    const spawnsBefore = readPids(brokenSpawnLog).length;
    const startedAt = Date.now();
    const result = await callTool(adapter.client, "search_tools", {
      query: "用 broken 查一下 echo",
      server: "broken",
    });
    const elapsed = Date.now() - startedAt;
    const spawned = readPids(brokenSpawnLog).length - spawnsBefore;

    // 顺序有意为之：spawn 计数与耗时是"刷了几次"的直接证据，放在行为断言
    // 之前。否则去掉去重逻辑时，会先在"搜索结果里没有 ok.echo"这里红掉，
    // 看起来像是行为回归，真正的回归点（多刷了一次）反而没被指出来。
    assert.equal(result.isError, undefined);
    assert.equal(
      spawned,
      1,
      `一次搜索里同一服务只应尝试刷新一次，实际拉起了 ${spawned} 个子进程`,
    );
    // 耗时是辅助判据：两次 800ms 超时约 1600ms+，只刷一次应明显低于它
    assert.ok(
      elapsed < 1400,
      `一次搜索里同一服务只应尝试刷新一次，实际耗时 ${elapsed}ms`,
    );
    assert.match(textOf(result), /已降级为全局搜索/);
    assert.match(textOf(result), /ok\.echo/);
  });

  it("服务可用时仍然按提示窄化搜索，降级逻辑不影响正常路径", async () => {
    const result = await callTool(adapter.client, "search_tools", {
      query: "echo",
      server: "ok",
    });
    const text = textOf(result);
    assert.match(text, /已解析为 server "ok"/);
    assert.doesNotMatch(text, /已降级为全局搜索/);
  });
});
