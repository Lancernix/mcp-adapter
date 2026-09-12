// e2e-harness.ts - 元工具 e2e 测试的共享基础设施
//
// 这是"改完代码不知道该不该发版"时最主要的一道防线：真实拉起 mcp-adapter 进程
// （stdio 传输），用官方 MCP SDK 的 Client 当客户端，把 4 个元工具的完整链路跑一遍。
//
// 与单元测试的区别：
//   - process-lifecycle.test.ts 直接操作 McpServerManager，验证并发与资源释放
//   - e2e 走真实进程 + 真实协议，验证「客户端看到的对外行为」
//
// 各 *-e2e.test.ts 文件按关注点分组引用本文件。adapter 的兜底回收由本文件
// 自动注册（见下方 runningAdapters 的注释），测试文件无需自己写 after。
//
// 前置依赖：仅需 node_modules（tsx 作为 TS 加载器），不依赖网络与真实 MCP 服务。

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  FAKE_SERVER,
  isAlive,
  ROOT,
  readPids,
  trackTmpDir,
  waitFor,
} from "./helpers.js";

const TSX_CLI = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const ADAPTER_ENTRY = path.join(ROOT, "src", "index.ts");

/**
 * 所有启动过的 adapter 都登记在这里，由本文件的文件级 after 兜底回收。
 * 只在用例正常走到末尾时靠 suite 的 after 收尾是不够的：断言失败会直接跳过
 * 后面的代码，adapter 与它的子进程就会残留，进而把这个测试进程挂住、
 * 报告不出失败原因。兜底回收保证"用例失败"永远只是失败，不是卡死。
 *
 * 注册发生在 harness 模块求值时：harness 被每个 e2e 测试文件导入，此时正处于
 * 该文件的 root suite 收集阶段，这里的 after 会挂到**每个导入方文件**上——
 * 各 e2e 文件因此不需要（也不能再靠）自己记得写 after(flushAdapters)。
 *
 * 验证 hook 是否生效，不能用"跑完无残留进程"作判据：adapter 的死亡守卫会在
 * 测试进程退出后自行收尾，无残留无论 hook 是否生效都成立。要用留痕法——
 * 临时在本函数里写一个标记文件，数调用它的测试进程数（应为 e2e 文件数）。
 */
const runningAdapters = new Set<AdapterHandle>();

async function flushAdapters(): Promise<void> {
  await Promise.all([...runningAdapters].map((adapter) => adapter.stop()));
}

after(flushAdapters);

export const META_TOOL_NAMES = [
  "search_tools",
  "describe_tool",
  "list_tools",
  "execute_tool",
].sort();

/** fake-mcp-server.mjs 暴露的全部工具，与夹具保持同步 */
export const FAKE_TOOLS = [
  "crash",
  "cwd",
  "echo",
  "env",
  "fail",
  "pid",
  "sleep",
];

export interface AdapterHandle {
  client: Client;
  home: string;
  /** 底层假 server 每次启动追加的 pid 记录，用于统计真实 spawn 次数 */
  spawnedPids: () => number[];
  /** adapter 进程的 stderr 全文，用于断言启动日志 */
  logs: () => string;
  stop: () => Promise<void>;
}

export function fakeServer(overrides: Record<string, unknown> = {}) {
  return {
    type: "stdio",
    command: process.execPath,
    args: [FAKE_SERVER],
    connectTimeoutMs: 5000,
    closeTimeoutMs: 2000,
    ...overrides,
  };
}

export interface AdapterContext {
  home: string;
  /** 默认的底层假 server spawn 记录文件（所有未单独覆写的假 server 共用） */
  spawnLog: string;
}

export async function startAdapter(
  configOrFactory: unknown | ((ctx: AdapterContext) => unknown),
  extraEnv: Record<string, string> = {},
): Promise<AdapterHandle> {
  const home = trackTmpDir(
    fs.mkdtempSync(path.join(os.tmpdir(), "mcp-adapter-e2e-")),
  );
  const spawnLog = path.join(home, "spawn.log");
  const config =
    typeof configOrFactory === "function"
      ? (configOrFactory as (ctx: AdapterContext) => unknown)({
          home,
          spawnLog,
        })
      : configOrFactory;

  fs.writeFileSync(
    path.join(home, "config.json"),
    JSON.stringify(config, null, 2),
    "utf-8",
  );

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.MCP_ADAPTER_HOME = home;
  // 由 adapter 继承给底层假 server，用于统计真实 spawn 次数
  env.FAKE_SPAWN_LOG = spawnLog;
  // 用于验证 inheritEnv 的宿主侧探针变量
  Object.assign(env, extraEnv);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [TSX_CLI, ADAPTER_ENTRY],
    env,
    stderr: "pipe",
  });

  const chunks: string[] = [];
  transport.stderr?.on("data", (chunk) => chunks.push(String(chunk)));

  const client = new Client(
    { name: "mcp-adapter-e2e-client", version: "1.0.0" },
    { capabilities: {} },
  );
  await client.connect(transport);
  const adapterPid = transport.pid;

  /**
   * 关掉 adapter 的 stdin，等它自己走完 shutdownAndExit 退出。
   *
   * 不能用 SDK 的 `client.close()`：它会先 stdin.end()，2 秒后 SIGTERM，
   * 再 2 秒后 SIGKILL adapter 进程。而 adapter 关闭顽固子进程同样需要约 4 秒
   * 的升级链，两边时间几乎完全重合——adapter 会在发出 SIGKILL 之前被测试
   * 强杀，于是"退出不留孤儿"这类断言是靠测试自己杀进程通过的，把
   * shutdownAll 整个删掉它照样绿。
   *
   * 真实宿主（Claude Code 等）正常退出时也是关闭管道而非发信号，所以这里
   * 模拟的才是真实路径。StdioClientTransport 没有暴露 stdin getter，只能取
   * 底层子进程句柄；拿不到就退回发 SIGTERM，两条路径最终都汇到
   * shutdownAndExit。最后再兜底 SIGKILL，避免 adapter 不响应时把测试挂住。
   */
  const shutdownAdapterGracefully = async () => {
    if (!adapterPid) return;

    const childStdin = (
      transport as unknown as {
        _process?: { stdin?: { end: () => void; destroyed?: boolean } };
      }
    )._process?.stdin;

    if (childStdin && !childStdin.destroyed) {
      try {
        childStdin.end();
      } catch {
        // 管道可能已经关闭，忽略
      }
    }

    if (await waitFor(() => !isAlive(adapterPid), 15000, 50)) return;

    // 没响应：退回信号，最后强杀。走到这一步说明退出路径有问题，
    // 但至少不能让整个测试进程挂死在这里而无法报告失败。
    try {
      process.kill(adapterPid, "SIGTERM");
    } catch {
      return;
    }
    if (await waitFor(() => !isAlive(adapterPid), 5000, 50)) return;
    try {
      process.kill(adapterPid, "SIGKILL");
    } catch {
      // 已经退出
    }
    await waitFor(() => !isAlive(adapterPid), 3000, 50);
  };

  const handle: AdapterHandle = {
    client,
    home,
    spawnedPids: () => readPids(spawnLog),
    logs: () => chunks.join(""),
    stop: async () => {
      runningAdapters.delete(handle);
      await shutdownAdapterGracefully();
    },
  };

  runningAdapters.add(handle);
  return handle;
}

export interface ToolResultLike {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
}

export function textOf(result: unknown): string {
  const content = (result as ToolResultLike).content ?? [];
  return content.map((part) => part.text ?? "").join("\n");
}

export async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResultLike> {
  return (await client.callTool({ name, arguments: args })) as ToolResultLike;
}

/** 等待启动期体检把指定 server 的工具写进 cache.json */
export async function waitForCache(
  home: string,
  servers: string[],
): Promise<void> {
  const ready = await waitFor(() => {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(path.join(home, "cache.json"), "utf-8"),
      ) as { servers?: Record<string, { tools?: unknown[] }> };
      return servers.every(
        (name) => (parsed.servers?.[name]?.tools?.length ?? 0) > 0,
      );
    } catch {
      return false;
    }
  });
  assert.ok(ready, `等待 cache.json 就绪超时：${servers.join(", ")}`);
}
