// meta-tools-eager.e2e.test.ts - lifecycle 模式的启动预热与守护边界
//
// 覆盖：eager 启动后台预热且只建连一次 / 预热不拉工具目录不写缓存 /
//      keep-alive 与 lazy 不预热 / 预热连接被首次调用复用 /
//      eager·keep-alive 无崩溃守护：不自动重启，下次调用才重建

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import {
  type AdapterHandle,
  callTool,
  fakeServer,
  startAdapter,
  textOf,
} from "./e2e-harness.js";
import { delay, readPids, waitFor } from "./helpers.js";

describe("元工具 - eager 预热与 keep-alive (e2e)", () => {
  let adapter: AdapterHandle;
  let eagerLog = "";
  let keepAliveLog = "";
  let lazyLog = "";

  before(async () => {
    adapter = await startAdapter(({ home }) => {
      eagerLog = path.join(home, "spawn-eager.log");
      keepAliveLog = path.join(home, "spawn-keep-alive.log");
      lazyLog = path.join(home, "spawn-lazy.log");
      return {
        version: 1,
        // 关掉体检，把"预热"这一个变量单独隔离出来
        settings: { startupMetadataCheck: false },
        mcpServers: {
          eagerSrv: fakeServer({
            lifecycle: "eager",
            env: { FAKE_SPAWN_LOG: eagerLog },
          }),
          keepAliveSrv: fakeServer({
            lifecycle: "keep-alive",
            env: { FAKE_SPAWN_LOG: keepAliveLog },
          }),
          lazySrv: fakeServer({
            lifecycle: "lazy",
            env: { FAKE_SPAWN_LOG: lazyLog },
          }),
        },
      };
    });
  });

  after(async () => {
    await adapter.stop();
  });

  it("lifecycle=eager 的服务会在没有任何工具调用时被后台拉起", async () => {
    const warmed = await waitFor(() => readPids(eagerLog).length === 1);
    assert.ok(warmed, "eager 服务应当被启动期预热拉起");
    assert.equal(readPids(eagerLog).length, 1, "预热只应建连一次");
  });

  it("eager 预热只建连、不拉工具目录，所以不会写 cache.json", async () => {
    await delay(200);
    assert.equal(
      fs.existsSync(path.join(adapter.home, "cache.json")),
      false,
      "预热不做 listTools，不该产生缓存；工具目录仍走按需刷新",
    );
  });

  it("keep-alive 与 lazy 都不会被启动预热", async () => {
    await delay(400);
    assert.equal(fs.existsSync(keepAliveLog), false, "keep-alive 不做预热");
    assert.equal(fs.existsSync(lazyLog), false, "lazy 不做预热");
  });

  it("预热过的连接会被复用，首次调用不再重新拉起子进程", async () => {
    const result = await callTool(adapter.client, "execute_tool", {
      tool: "eagerSrv.pid",
    });
    assert.match(textOf(result), /^pid:\d+$/);

    await delay(150);
    assert.equal(
      readPids(eagerLog).length,
      1,
      "预热建立的连接应当被首次调用复用，不应重新 spawn",
    );
  });

  it("eager/keep-alive 没有守护机制：崩溃后不会自动重启，下次调用才重建", async () => {
    // 自己等预热完成，不依赖兄弟用例先跑过（否则按名字单独跑这个用例会挂）
    const warmed = await waitFor(() => readPids(eagerLog).length >= 1);
    assert.ok(warmed, "eager 预热应当先完成");

    const spawnsBefore = readPids(eagerLog).length;
    const pidBefore = textOf(
      await callTool(adapter.client, "execute_tool", { tool: "eagerSrv.pid" }),
    );
    assert.match(pidBefore, /^pid:\d+$/);
    assert.equal(
      readPids(eagerLog).length,
      spawnsBefore,
      "这条调用应当复用已有连接",
    );

    // 让子进程崩溃。崩溃时该请求正在途，所以它拿到的是裸的 Connection closed，
    // 并且不会自动重试 —— 这一点同样在下面被锁定
    const crashed = await callTool(adapter.client, "execute_tool", {
      tool: "eagerSrv.crash",
    });
    assert.equal(crashed.isError, true);
    // 断连错误必须给出可行动引导，而不是把裸的 "Connection closed" 丢给模型
    assert.match(textOf(crashed), /与 \[eagerSrv\] 的连接已断开/);
    assert.match(textOf(crashed), /该连接已被回收/);
    assert.match(textOf(crashed), /自动冷启动新连接/);

    // 等待一段明显长于任何重试间隔的时间，确认没有被后台自动拉起
    await delay(1500);
    assert.equal(
      readPids(eagerLog).length,
      spawnsBefore,
      "eager 只保证启动预热与免回收，不提供崩溃守护/自动重启",
    );

    // 直到下一次真实调用，才走常规冷启动路径重新拉起
    const pidAfter = textOf(
      await callTool(adapter.client, "execute_tool", { tool: "eagerSrv.pid" }),
    );
    assert.match(pidAfter, /^pid:\d+$/);
    assert.notEqual(pidAfter, pidBefore, "重新拉起的是全新的子进程");
    assert.equal(
      readPids(eagerLog).length,
      spawnsBefore + 1,
      "只有真实调用才会触发重建",
    );
  });
});
