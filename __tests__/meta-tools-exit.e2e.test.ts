// meta-tools-exit.e2e.test.ts - 缓存与进程的关系、退出收敛
//
// 覆盖：缓存有效时元工具零额外进程、execute 才按需冷启动 /
//      客户端断开后 adapter 退出且底层子进程全部回收 /
//      顽固子进程（忽略 SIGTERM）仍走完 SIGTERM→SIGKILL 升级链被收敛

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  type AdapterHandle,
  callTool,
  fakeServer,
  startAdapter,
  textOf,
  waitForCache,
} from "./e2e-harness.js";
import { delay, isAlive, waitFor } from "./helpers.js";

describe("元工具 - 缓存有效时不产生额外进程 (e2e)", () => {
  let adapter: AdapterHandle;

  before(async () => {
    adapter = await startAdapter({
      version: 1,
      settings: { startupMetadataCheck: true },
      mcpServers: { demo: fakeServer({ aliases: ["演示服务"] }) },
    });
    await waitForCache(adapter.home, ["demo"]);
    // 体检结束时临时连接会被 closeIfCreated 关掉，等它关干净再开始计数
    await waitFor(() => adapter.spawnedPids().length >= 1);
    await delay(200);
  });

  after(async () => {
    await adapter.stop();
  });

  it("缓存有效时，带 server 提示的 search / list / describe 都不重新拉起子进程", async () => {
    const before = adapter.spawnedPids().length;

    await callTool(adapter.client, "search_tools", {
      query: "echo",
      server: "演示服务",
    });
    await callTool(adapter.client, "list_tools", { server: "demo" });
    await callTool(adapter.client, "describe_tool", { tool: "demo.echo" });

    await delay(150);
    assert.equal(
      adapter.spawnedPids().length,
      before,
      "缓存有效时元工具不该为了刷新 metadata 再拉起进程",
    );
  });

  it("只有真正执行工具时才会拉起子进程", async () => {
    const before = adapter.spawnedPids().length;

    const executed = await callTool(adapter.client, "execute_tool", {
      tool: "demo.echo",
      arguments: { text: "lazy" },
    });
    assert.equal(textOf(executed), "echo:lazy");

    const spawned = await waitFor(
      () => adapter.spawnedPids().length > before,
      5000,
    );
    assert.ok(spawned, "执行工具时必须按需冷启动对应子进程");
  });
});

describe("元工具 - 优雅退出与子进程回收 (e2e)", () => {
  it("客户端断开后 adapter 退出，且它拉起过的底层子进程全部被回收", async () => {
    const adapter = await startAdapter({
      version: 1,
      settings: { startupMetadataCheck: true },
      mcpServers: {
        demo: fakeServer(),
      },
    });
    await waitForCache(adapter.home, ["demo"]);

    // 触发一次真实调用，确保底层子进程确实被拉起来了
    const executed = await callTool(adapter.client, "execute_tool", {
      tool: "demo.pid",
    });
    assert.match(textOf(executed), /^pid:\d+$/);

    const childPids = adapter.spawnedPids();
    assert.ok(childPids.length >= 1, "至少应拉起过一个底层子进程");

    // 体检用完之后会立刻关掉临时连接（closeIfCreated），所以这里以"最后一次
    // spawn"为准：它由 execute_tool 建立并留在连接池里，应当是存活的
    const activePid = childPids[childPids.length - 1];
    assert.equal(isAlive(activePid), true, "调用期间底层子进程应当存活");

    await adapter.stop();

    const allGone = await waitFor(
      () => childPids.every((pid) => !isAlive(pid)),
      8000,
    );
    assert.ok(
      allGone,
      `adapter 退出后不得留下孤儿子进程，残留 pid：${childPids.filter(isAlive).join(", ")}`,
    );
  });
});

describe("元工具 - 忽略 SIGTERM 的子进程仍被收敛 (e2e)", () => {
  it("退出时走完 SIGTERM→SIGKILL 升级链，不会在 SIGKILL 之前放弃", async () => {
    const adapter = await startAdapter({
      version: 1,
      settings: { startupMetadataCheck: false },
      mcpServers: {
        // 忽略 stdin 关闭与 SIGTERM，只有 SIGKILL 能杀死它。
        // 这条用例的意义：普通子进程即便网关什么都不做，也会因 stdin EOF 而自行
        // 退出，所以"退出不留孤儿"断言是**不可失败**的（把 shutdownAll 删掉照样绿）。
        // 顽固进程让 shutdownAll 的关闭预算与升级链在端到端层面真正可证伪。
        stubborn: fakeServer({
          env: { FAKE_STUBBORN: "1" },
          lifecycle: "keep-alive",
        }),
      },
    });

    const executed = await callTool(adapter.client, "execute_tool", {
      tool: "stubborn.pid",
    });
    assert.match(textOf(executed), /^pid:\d+$/);

    const pid = adapter.spawnedPids().at(-1);
    assert.ok(pid && isAlive(pid), "顽固子进程应当已被拉起且存活");

    const startedAt = Date.now();
    await adapter.stop();
    const elapsed = Date.now() - startedAt;

    // SDK 的关闭升级链是 stdin.end → 2s → SIGTERM → 2s → SIGKILL，约 4s。
    // 若关闭预算被压到这条链之下，Shutdown 会在 SIGKILL 发出前就放弃 → 留孤儿。
    assert.ok(
      elapsed >= 3500,
      `必须等升级链走完再退出，实际仅 ${elapsed}ms（约 4s 才到 SIGKILL）`,
    );
    assert.ok(
      await waitFor(() => !isAlive(pid), 5000),
      "顽固子进程最终必须被 SIGKILL 杀死",
    );
  });
});
