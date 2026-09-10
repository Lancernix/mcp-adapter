// process-lifecycle.test.ts - 子进程生命周期的回归测试
//
// 覆盖：并发首次建连去重、建连失败后的可重试性、子进程崩溃后的自愈、
//       超时退役不误杀在途请求、metadata 刷新后按需关闭、eager 预热、
//       闲置回收边界、shutdownAll 的收口顺序与孤儿进程防护。
//
// 全部用例基于 __tests__/fixtures/fake-mcp-server.mjs（零依赖的最小 MCP stdio server），
// 不依赖网络、不依赖真实 MCP 服务，可在 CI 与发版前稳定重跑。

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { McpLifecycleManager } from "../src/lifecycle.js";
import {
  McpServerManager,
  type ServerConnection,
} from "../src/server-manager.js";
import { TimeoutError, withTimeout } from "../src/timeout.js";
import type { AdapterConfig, ServerConfig } from "../src/types.js";
import {
  delay,
  FAKE_SERVER,
  isAlive,
  mkdtempHome,
  readPids,
  waitFor,
} from "./helpers.js";

// 隔离 metadata cache / logs 的落盘位置，避免污染开发者本机 ~/.mcp-adapter
mkdtempHome("mcp-adapter-test-home-");

const WORK_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "mcp-adapter-test-work-"),
);
let logSeq = 0;

// ---- helpers ----

function newSpawnLog(): string {
  logSeq += 1;
  return path.join(WORK_DIR, `spawn-${logSeq}.log`);
}

function fakeConfig(env: Record<string, string> = {}): ServerConfig {
  return {
    type: "stdio",
    command: process.execPath,
    args: [FAKE_SERVER],
    env,
    connectTimeoutMs: 5000,
    closeTimeoutMs: 2000,
  };
}

function textOf(result: unknown): string {
  const content =
    (result as { content?: Array<{ type: string; text?: string }> }).content ??
    [];
  return content.map((part) => part.text ?? "").join("");
}

/** 复刻 execute_tool 的调用序列：retain → withTimeout(callTool) → 超时则退役 → release */
async function callWithTimeout(
  manager: McpServerManager,
  conn: ServerConnection,
  toolName: string,
  args: Record<string, unknown>,
  timeoutMs: number,
): Promise<unknown> {
  manager.retain(conn);
  let shouldRetire = false;
  try {
    return await withTimeout(
      conn.client.callTool({ name: toolName, arguments: args }),
      timeoutMs,
      `执行工具 [${conn.name}.${toolName}] 超时`,
    );
  } catch (err) {
    if (err instanceof TimeoutError) shouldRetire = true;
    throw err;
  } finally {
    if (shouldRetire) manager.retire(conn.name, conn);
    await manager.release(conn, 2000);
  }
}

// ---- 建连与复用 ----

describe("进程管理 - 建连去重与失败恢复", () => {
  it("同一 server 的并发首次调用只 spawn 一个子进程", async () => {
    const spawnLog = newSpawnLog();
    const manager = new McpServerManager();
    const config = fakeConfig({ FAKE_SPAWN_LOG: spawnLog });

    const [a, b] = await Promise.all([
      manager.connect("srv", config),
      manager.connect("srv", config),
    ]);

    assert.equal(a, b, "并发调用必须复用同一个 ServerConnection 实例");
    assert.equal(a.name, "srv");
    assert.equal(readPids(spawnLog).length, 1, "只允许 spawn 一次");

    await manager.shutdownAll(2000, true);
  });

  it("同一 server 顺序调用复用连接池中的同一条连接", async () => {
    const spawnLog = newSpawnLog();
    const manager = new McpServerManager();
    const config = fakeConfig({ FAKE_SPAWN_LOG: spawnLog });

    const first = await manager.connect("srv", config);
    manager.retain(first);
    await manager.release(first, 2000);

    const second = await manager.connect("srv", config);
    assert.equal(first, second);
    assert.equal(readPids(spawnLog).length, 1);

    await manager.shutdownAll(2000, true);
  });

  it("建连失败后 connectPromises 被清理，同名的下一次建连可以成功", async () => {
    const spawnLog = newSpawnLog();
    const manager = new McpServerManager();

    const brokenConfig: ServerConfig = {
      type: "stdio",
      command: "mcp-adapter-command-that-does-not-exist",
      args: [],
      connectTimeoutMs: 2000,
      closeTimeoutMs: 500,
    };

    await assert.rejects(
      () => manager.connect("srv", brokenConfig, { failureBackoffMs: 0 }),
      /连接底层真实 MCP 服务/,
    );
    assert.equal(manager.isConnected("srv"), false, "失败的连接不得进入连接池");

    // 若 connectPromises 未被 finally 清理，这里会一直复用 rejected promise 而失败
    // （failureBackoffMs: 0 关闭冷却，否则本次调用会被刚刚那次失败挡住）
    const conn = await manager.connect(
      "srv",
      fakeConfig({ FAKE_SPAWN_LOG: spawnLog }),
      { failureBackoffMs: 0 },
    );
    manager.retain(conn);
    const result = await conn.client.callTool({
      name: "echo",
      arguments: { text: "recovered" },
    });
    assert.equal(textOf(result), "echo:recovered");
    await manager.release(conn, 2000);

    await manager.shutdownAll(2000, true);
  });
});

// ---- 子进程崩溃后的自愈 ----

describe("进程管理 - 子进程崩溃后的自愈", () => {
  it("子进程崩溃后连接被摘出连接池，下一次调用自动重建", async () => {
    const spawnLog = newSpawnLog();
    const manager = new McpServerManager();
    const config = fakeConfig({ FAKE_SPAWN_LOG: spawnLog });

    const conn1 = await manager.connect("srv", config);
    manager.retain(conn1);
    const firstPid = textOf(
      await conn1.client.callTool({ name: "pid", arguments: {} }),
    );
    await manager.release(conn1, 2000);
    assert.equal(manager.isConnected("srv"), true);

    // 让子进程直接 process.exit(7)，不返回任何响应
    const conn2 = await manager.connect("srv", config);
    manager.retain(conn2);
    await assert.rejects(() =>
      conn2.client.callTool({ name: "crash", arguments: {} }),
    );
    await manager.release(conn2, 2000);

    // 关键断言：没有 onclose 主动摘除时，这里会一直是 true，
    // 后续调用只能拿到 "Not connected"，要等 sweeper 按 idleTimeout 兜底
    const removed = await waitFor(() => !manager.isConnected("srv"), 3000);
    assert.ok(removed, "子进程崩溃后连接必须从连接池摘除");

    const conn3 = await manager.connect("srv", config);
    manager.retain(conn3);
    const secondPid = textOf(
      await conn3.client.callTool({ name: "pid", arguments: {} }),
    );
    await manager.release(conn3, 2000);

    assert.notEqual(secondPid, firstPid, "必须是全新的子进程");
    assert.equal(secondPid, `pid:${String(readPids(spawnLog)[1])}`);
    assert.equal(readPids(spawnLog).length, 2);

    await manager.shutdownAll(2000, true);
  });
});

// ---- 超时退役与在途请求保护 ----

describe("进程管理 - 超时退役不误杀在途请求", () => {
  it("一个请求超时退役连接，不会中断同一 server 上正在执行的并发请求", async () => {
    const spawnLog = newSpawnLog();
    const manager = new McpServerManager();
    const config = fakeConfig({ FAKE_SPAWN_LOG: spawnLog });

    // 预热连接，让 A / B 复用同一条物理连接
    const warm = await manager.connect("srv", config);
    manager.retain(warm);
    await manager.release(warm, 2000);

    // B：300ms 的慢请求，超时预算充足，应当成功
    const connB = await manager.connect("srv", config);
    assert.equal(connB, warm);
    const bPromise = callWithTimeout(
      manager,
      connB,
      "sleep",
      { ms: 300 },
      5000,
    );

    await delay(40);

    // A：500ms 的请求 + 100ms 超时预算 → 必然超时 → 触发退役
    const connA = await manager.connect("srv", config);
    assert.equal(connA, warm, "A 复用的仍是同一条连接");
    await assert.rejects(
      () => callWithTimeout(manager, connA, "sleep", { ms: 500 }, 100),
      /超时/,
    );

    // 没有退役机制时，A 的 force close 会通过 SDK 的 _onclose 把 B 一并 reject
    const bResult = await bPromise;
    assert.equal(textOf(bResult), "slept:300", "B 必须不受 A 超时的影响");

    // B 是退役连接的最后一个使用者，释放后应被物理关闭
    const closed = await waitFor(() => !manager.isConnected("srv"), 3000);
    assert.ok(closed, "退役连接在引用归零后应被关闭");

    // 连接已退役，新请求必须重建而不是复用
    const connC = await manager.connect("srv", config);
    assert.notEqual(connC, warm, "退役的连接不得被复用");
    manager.retain(connC);
    await manager.release(connC, 2000);

    await manager.shutdownAll(2000, true);
  });

  it("force close 可以穿透在途请求保护（退出路径语义）", async () => {
    const manager = new McpServerManager();
    const config = fakeConfig();

    const conn = await manager.connect("srv", config);
    manager.retain(conn);

    // 非强制关闭必须被在途请求挡住
    await manager.close("srv", 2000, false);
    assert.equal(manager.isConnected("srv"), true, "非强制关闭应跳过在途请求");

    // 强制关闭必须穿透
    await manager.close("srv", 2000, true);
    assert.equal(manager.isConnected("srv"), false, "force close 必须能关闭");

    await manager.release(conn, 2000);
    await manager.shutdownAll(2000, true);
  });
});

// ---- metadata 刷新后的连接去留 ----

describe("进程管理 - metadata 刷新后的连接去留", () => {
  it("closeIfCreated 在无人复用时关闭刚建立的连接", async () => {
    const manager = new McpServerManager();
    const config = fakeConfig();

    const refreshed = await manager.refreshMetadataIfNeeded("srv", config, {
      forceRefresh: true,
      closeIfCreated: true,
      connectTimeoutMs: 5000,
      closeTimeoutMs: 2000,
    });

    assert.equal(refreshed, true);
    const closed = await waitFor(() => !manager.isConnected("srv"), 3000);
    assert.ok(closed, "刷新后无人使用时应自动关闭连接");

    await manager.shutdownAll(2000, true);
  });

  it("刷新期间连接被调用方持有时，不会被 closeIfCreated 关掉", async () => {
    const manager = new McpServerManager();
    const config = fakeConfig({ FAKE_INIT_DELAY_MS: "150" });

    const refreshPromise = manager.refreshMetadataIfNeeded("srv", config, {
      forceRefresh: true,
      closeIfCreated: true,
      connectTimeoutMs: 5000,
      closeTimeoutMs: 2000,
    });

    await delay(60);
    const conn = await manager.connect("srv", config);
    manager.retain(conn);

    assert.equal(await refreshPromise, true);

    // 刷新结束后连接仍被持有，不得被关闭
    await delay(80);
    assert.equal(manager.isConnected("srv"), true, "有在途引用时不得关闭连接");

    await manager.release(conn, 2000);
    await manager.shutdownAll(2000, true);
  });
});

// ---- eager 预热 ----

describe("进程管理 - eager 预热", () => {
  it("warmupEagerServers 只预热 lifecycle=eager 的服务", async () => {
    const spawnLog = newSpawnLog();
    const manager = new McpServerManager();

    const la: AdapterConfig = {
      version: 1,
      settings: {},
      mcpServers: {
        "eager-srv": {
          ...fakeConfig({ FAKE_SPAWN_LOG: spawnLog }),
          lifecycle: "eager",
        },
        "lazy-srv": fakeConfig({ FAKE_SPAWN_LOG: spawnLog }),
        "keep-srv": {
          ...fakeConfig({ FAKE_SPAWN_LOG: spawnLog }),
          lifecycle: "keep-alive",
        },
        "off-srv": {
          ...fakeConfig({ FAKE_SPAWN_LOG: spawnLog }),
          lifecycle: "eager",
          disabled: true,
        },
      },
    };

    const lifecycle = new McpLifecycleManager(manager, la);
    const warmed = await lifecycle.warmupEagerServers();

    assert.deepEqual(warmed, ["eager-srv"]);
    assert.equal(manager.isConnected("eager-srv"), true, "eager 应被预热");
    assert.equal(manager.isConnected("lazy-srv"), false, "lazy 不应被预热");
    assert.equal(
      manager.isConnected("keep-srv"),
      false,
      "keep-alive 同样按需启动",
    );
    assert.equal(manager.isConnected("off-srv"), false, "disabled 不应被预热");
    assert.equal(readPids(spawnLog).length, 1, "只应有 eager 服务被 spawn");

    await manager.shutdownAll(2000, true);
  });
});

// ---- 闲置回收边界 ----

describe("进程管理 - 闲置回收边界", () => {
  it("idleTimeout<=0 表示禁用回收，keep-alive 永不回收", async () => {
    const spawnLog = newSpawnLog();
    const manager = new McpServerManager();

    const la: AdapterConfig = {
      version: 1,
      settings: { idleTimeout: 10 },
      mcpServers: {
        "zero-srv": {
          ...fakeConfig({ FAKE_SPAWN_LOG: spawnLog }),
          lifecycle: "lazy",
          idleTimeout: 0,
        },
        "keep-srv": {
          ...fakeConfig({ FAKE_SPAWN_LOG: spawnLog }),
          lifecycle: "keep-alive",
        },
      },
    };

    const lifecycle = new McpLifecycleManager(manager, la);

    const zero = await manager.connect("zero-srv", la.mcpServers["zero-srv"]);
    manager.retain(zero);
    await manager.release(zero, 2000);

    const keep = await manager.connect("keep-srv", la.mcpServers["keep-srv"]);
    manager.retain(keep);
    await manager.release(keep, 2000);

    // 让 lastUsedAt 至少落后 1ms；旧实现下 idleTimeout=0 会让这里被误判为已闲置
    await delay(15);
    await lifecycle.sweepNow();

    assert.equal(
      manager.isConnected("zero-srv"),
      true,
      "idleTimeout=0 应被解释为禁用回收，而不是每轮必杀",
    );
    assert.equal(manager.isConnected("keep-srv"), true, "keep-alive 永不回收");

    await manager.shutdownAll(2000, true);
  });

  it("sweeper 只回收确实闲置的 lazy 连接", async () => {
    const manager = new McpServerManager();
    const la: AdapterConfig = {
      version: 1,
      settings: { idleTimeout: 10 },
      mcpServers: {
        "busy-srv": { ...fakeConfig(), lifecycle: "lazy" },
      },
    };

    const lifecycle = new McpLifecycleManager(manager, la);
    const conn = await manager.connect("busy-srv", la.mcpServers["busy-srv"]);
    manager.retain(conn);

    await delay(15);
    await lifecycle.sweepNow();
    assert.equal(manager.isConnected("busy-srv"), true, "在途请求期间不得回收");

    await manager.release(conn, 2000);
    await manager.shutdownAll(2000, true);
  });

  it("isIdle 支持注入 now，且只对 connected 状态生效", async () => {
    const manager = new McpServerManager();
    const config = fakeConfig();

    const conn = await manager.connect("srv", config);
    manager.retain(conn);
    await manager.release(conn, 2000);

    const farFuture = Date.now() + 10 * 60 * 1000;
    assert.equal(manager.isIdle("srv", 60 * 1000, farFuture), true);

    manager.retain(conn);
    assert.equal(
      manager.isIdle("srv", 60 * 1000, farFuture),
      false,
      "在途请求不算闲置",
    );
    await manager.release(conn, 2000);

    await manager.close("srv", 2000, true);
    assert.equal(manager.isIdle("srv", 60 * 1000, farFuture), false);

    await manager.shutdownAll(2000, true);
  });
});

// ---- 退出收敛与孤儿进程防护 ----

describe("进程管理 - 退出收敛", () => {
  it("shutdownAll 能杀死忽略 SIGTERM 的子进程，不会留下孤儿", async () => {
    const spawnLog = newSpawnLog();
    const manager = new McpServerManager();
    const config = fakeConfig({
      FAKE_SPAWN_LOG: spawnLog,
      FAKE_STUBBORN: "1",
    });

    const conn = await manager.connect("stubborn-srv", config);
    manager.retain(conn);
    await manager.release(conn, 2000);

    const pid = readPids(spawnLog)[0];
    assert.ok(Number.isFinite(pid) && pid > 0, "应当记录到子进程 pid");
    assert.equal(isAlive(pid), true);

    const startedAt = Date.now();
    // 故意传入远小于 SDK 升级链的 1000ms：物理关闭必须保底预算，
    // 否则 withTimeout 会在 SIGKILL 发出之前放弃，留下孤儿进程
    await manager.shutdownAll(1000, true);
    const elapsed = Date.now() - startedAt;

    assert.ok(
      elapsed >= 3500,
      `关闭预算被压到 SDK 升级链之下（实际 ${elapsed}ms），SIGKILL 可能发不出去`,
    );

    const dead = await waitFor(() => !isAlive(pid), 5000);
    assert.ok(dead, "顽固子进程最终必须被 SIGKILL 杀死");
  });

  it("建连过程中 shutdownAll：不残留连接，且子进程被回收", async () => {
    const spawnLog = newSpawnLog();
    const manager = new McpServerManager();
    const config = fakeConfig({
      FAKE_SPAWN_LOG: spawnLog,
      FAKE_INIT_DELAY_MS: "800",
    });

    const connectPromise = manager.connect("srv", config);
    connectPromise.catch(() => {});

    await delay(100);
    assert.equal(readPids(spawnLog).length, 1, "建连应已 spawn 出子进程");

    await manager.shutdownAll(3000, true);

    assert.equal(manager.isConnected("srv"), false);
    assert.equal(
      manager.inspect("srv").retiredCount,
      0,
      "退役集合必须被回收干净",
    );

    await connectPromise.catch(() => {});

    const pid = readPids(spawnLog)[0];
    const dead = await waitFor(() => !isAlive(pid), 8000);
    assert.ok(dead, "建连中被 shutdown 的子进程必须被回收");

    await assert.rejects(
      () => manager.connect("srv", config),
      /正在关闭/,
      "shutdown 后必须永久拒绝新建连接",
    );
  });
});
