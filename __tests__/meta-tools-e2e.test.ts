// meta-tools-e2e.test.ts - 主线链端到端测试
//
// 这是"改完代码不知道该不该发版"时最主要的一道防线：真实拉起 mcp-adapter 进程
// （stdio 传输），用官方 MCP SDK 的 Client 当客户端，把 4 个元工具的完整链路跑一遍。
//
// 与单元测试的区别：
//   - process-lifecycle.test.ts 直接操作 McpServerManager，验证并发与资源释放
//   - 本文件走真实进程 + 真实协议，验证「客户端看到的对外行为」
//
// 覆盖主线：4 个元工具的暴露面 / 冷启动自动体检写缓存 / search 的多种命中与兜底 /
//          search → execute 两步闭环 / list / describe / 重名冲突 /
//          includeTools·excludeTools·disabled 的可见性与可执行性 /
//          env·inheritEnv·cwd 真实生效 / eager 启动预热与无崩溃守护 /
//          缓存有效时不产生额外进程 / 关闭启动期体检后的按需刷新 /
//          优雅退出不留孤儿子进程
//
// 前置依赖：仅需 node_modules（tsx 作为 TS 加载器），不依赖网络与真实 MCP 服务。

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  delay,
  FAKE_SERVER,
  isAlive,
  ROOT,
  readPids,
  trackTmpDir,
  waitFor,
} from "./helpers.js";

const TSX_CLI = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const ADAPTER_ENTRY = path.join(ROOT, "src", "index.ts");

const META_TOOL_NAMES = [
  "search_tools",
  "describe_tool",
  "list_tools",
  "execute_tool",
].sort();

/** fake-mcp-server.mjs 暴露的全部工具，与夹具保持同步 */
const FAKE_TOOLS = ["crash", "cwd", "echo", "env", "fail", "pid", "sleep"];

interface AdapterHandle {
  client: Client;
  home: string;
  /** 底层假 server 每次启动追加的 pid 记录，用于统计真实 spawn 次数 */
  spawnedPids: () => number[];
  /** adapter 进程的 stderr 全文，用于断言启动日志 */
  logs: () => string;
  stop: () => Promise<void>;
}

function fakeServer(overrides: Record<string, unknown> = {}) {
  return {
    type: "stdio",
    command: process.execPath,
    args: [FAKE_SERVER],
    connectTimeoutMs: 5000,
    closeTimeoutMs: 2000,
    ...overrides,
  };
}

interface AdapterContext {
  home: string;
  /** 默认的底层假 server spawn 记录文件（所有未单独覆写的假 server 共用） */
  spawnLog: string;
}

async function startAdapter(
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

/**
 * 所有启动过的 adapter 都登记在这里，由文件级的 after 兜底回收。
 * 只在用例正常走到末尾时靠 suite 的 after 收尾是不够的：断言失败会直接跳过
 * 后面的代码，adapter 与它的子进程就会残留，进而把这个测试进程挂住、
 * 报告不出失败原因。兜底回收保证"用例失败"永远只是失败，不是卡死。
 */
const runningAdapters = new Set<AdapterHandle>();

after(async () => {
  await Promise.all([...runningAdapters].map((adapter) => adapter.stop()));
});

interface ToolResultLike {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
}

function textOf(result: unknown): string {
  const content = (result as ToolResultLike).content ?? [];
  return content.map((part) => part.text ?? "").join("\n");
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResultLike> {
  return (await client.callTool({ name, arguments: args })) as ToolResultLike;
}

/**
 * 从搜索结果里数出实际返回的工具条数。
 * 命中路径的分组标题形如 `### demo (3 matches)`，
 * 服务浏览兜底路径形如 `### demo (3 tools)`，两种都要统计。
 */
function countMatches(text: string): number {
  return [...text.matchAll(/\((\d+) (?:matches|tools)\)/g)].reduce(
    (sum, m) => sum + Number(m[1]),
    0,
  );
}

/** 等待启动期体检把指定 server 的工具写进 cache.json */
async function waitForCache(home: string, servers: string[]): Promise<void> {
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

// ---- 主链路 ----

describe("元工具主链路 (e2e)", () => {
  let adapter: AdapterHandle;

  before(async () => {
    adapter = await startAdapter({
      version: 1,
      settings: { startupMetadataCheck: true, toolSearchLimit: 10 },
      mcpServers: {
        demo: fakeServer({ aliases: ["演示服务", "demo server"] }),
      },
    });
    await waitForCache(adapter.home, ["demo"]);
  });

  after(async () => {
    await adapter.stop();
  });

  it("对外只暴露 4 个元工具，底层 4 个真实工具全部被拦截", async () => {
    const { tools } = await adapter.client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      META_TOOL_NAMES,
      "客户端不应该看到底层真实工具，只应看到 4 个元工具",
    );
    // 底层其实有 6 个工具，验证它们确实没有泄漏到对外列表
    const listed = await callTool(adapter.client, "list_tools", {
      server: "demo",
    });
    assert.match(
      textOf(listed),
      new RegExp(`共有 ${FAKE_TOOLS.length} 个工具`),
    );
  });

  it("冷启动自动完成 metadata 体检并写入 cache.json", async () => {
    const cache = JSON.parse(
      fs.readFileSync(path.join(adapter.home, "cache.json"), "utf-8"),
    ) as { servers: Record<string, { tools: Array<{ name: string }> }> };

    assert.deepEqual(
      cache.servers.demo.tools.map((tool) => tool.name).sort(),
      [...FAKE_TOOLS].sort(),
    );
  });

  it("启动日志明确写出体检范围与强制重拉的服务", async () => {
    const ready = await waitFor(() =>
      adapter.logs().includes("[Bootstrap] 启动期 metadata 体检开始"),
    );
    assert.ok(ready, `未看到体检日志，实际 stderr：\n${adapter.logs()}`);

    const logs = adapter.logs();
    assert.match(logs, /1 个服务待刷新 —— demo/);
    assert.match(logs, /\[Bootstrap\] 正在刷新 \[demo\]（缓存缺失或已失效）/);
    assert.match(
      logs,
      new RegExp(
        `✓ \\[demo\\] metadata 刷新完成，发现 ${FAKE_TOOLS.length} 个工具`,
      ),
    );
  });

  it("search_tools 按功能关键词命中，并返回 inputSchema 与匹配依据", async () => {
    const result = await callTool(adapter.client, "search_tools", {
      query: "echo text",
    });
    const text = textOf(result);

    assert.equal(result.isError, undefined);
    assert.match(text, /demo\.echo/);
    assert.match(text, /inputSchema/);
    assert.match(text, /匹配依据/);
    assert.match(text, /执行建议/);
  });

  it("search_tools 用中文别名也能定位到服务", async () => {
    const result = await callTool(adapter.client, "search_tools", {
      query: "echo",
      server: "演示服务",
    });
    const text = textOf(result);

    assert.match(text, /已解析为 server "demo"/);
    assert.match(text, /demo\.echo/);
  });

  it("search_tools 的 server hint 无法匹配时回退全局搜索而不是报错", async () => {
    const result = await callTool(adapter.client, "search_tools", {
      query: "echo",
      server: "完全不存在的服务名",
    });
    const text = textOf(result);

    assert.equal(result.isError, undefined);
    assert.match(text, /未匹配到已配置服务/);
    // 仍应通过把 hint 拼进 query 的方式完成全局搜索
    assert.match(text, /demo\.echo/);
  });

  it("search_tools 无结果时返回可用 server 列表作为兜底", async () => {
    const result = await callTool(adapter.client, "search_tools", {
      query: "zzzz_完全不相关的东西_zzzz",
    });
    const text = textOf(result);

    assert.equal(result.isError, undefined);
    assert.match(text, /暂未匹配到/);
    assert.match(text, /可用 server 列表/);
    assert.match(text, /- demo \(aliases: 演示服务, demo server\)/);
  });

  it("search_tools 支持 limit 控制返回数量", async () => {
    // 用一个必然匹配不到功能词的 query，走"已识别 server 但无强匹配"的浏览兜底：
    // 该路径会返回该服务的全部工具，条数只受 limit 约束，断言可以做到精确。
    const browseWithLimit = async (limit: number) => {
      const result = await callTool(adapter.client, "search_tools", {
        query: "zzz-这个关键词一定匹配不到任何工具",
        server: "demo",
        limit,
      });
      assert.equal(result.isError, undefined, "limit 应当被正常受理");
      return countMatches(textOf(result));
    };

    const one = await browseWithLimit(1);
    const three = await browseWithLimit(3);

    assert.equal(one, 1, `limit=1 应只返回 1 条，实际 ${one} 条`);
    assert.equal(three, 3, `limit=3 应返回 3 条，实际 ${three} 条`);

    // 兜底路径最多只能给出该服务的全部工具数，limit 再大也不会超
    assert.ok(
      three <= FAKE_TOOLS.length,
      `返回条数不应超过服务实际工具数（${FAKE_TOOLS.length}）`,
    );
  });

  it("list_tools 返回工具名目录，且刻意不带 schema", async () => {
    const result = await callTool(adapter.client, "list_tools", {
      server: "demo",
    });
    const text = textOf(result);

    assert.match(text, new RegExp(`demo 共有 ${FAKE_TOOLS.length} 个工具`));
    for (const name of FAKE_TOOLS) {
      assert.match(text, new RegExp(`\\b${name}\\b`));
    }
    assert.doesNotMatch(text, /inputSchema/);
    assert.match(text, /不包含描述和参数/);
  });

  it("describe_tool 返回指定工具的完整 inputSchema", async () => {
    const result = await callTool(adapter.client, "describe_tool", {
      tool: "demo.echo",
    });
    const text = textOf(result);

    assert.match(text, /工具全名: \*\*demo\.echo\*\*/);
    assert.match(text, /"text"/);
  });

  it("describe_tool 找不到工具时给出可行动的引导", async () => {
    const result = await callTool(adapter.client, "describe_tool", {
      tool: "demo.不存在的工具",
    });
    assert.match(textOf(result), /未能定位到工具/);
    assert.match(textOf(result), /search_tools/);
  });

  it("search → execute 两步闭环可以真正调用到底层工具", async () => {
    const search = await callTool(adapter.client, "search_tools", {
      query: "echo text",
    });
    // 从 search 结果里确认拿到的是可直接执行的 qualifiedName
    assert.match(textOf(search), /demo\.echo/);

    const executed = await callTool(adapter.client, "execute_tool", {
      tool: "demo.echo",
      arguments: { text: "hello" },
    });
    assert.equal(executed.isError, undefined);
    assert.equal(textOf(executed), "echo:hello");
  });

  it("execute_tool 支持裸工具名（不带 server 前缀）", async () => {
    const executed = await callTool(adapter.client, "execute_tool", {
      tool: "echo",
      arguments: { text: "bare" },
    });
    assert.equal(textOf(executed), "echo:bare");
  });

  it("execute_tool 对未知工具返回可行动的 isError，而不是静默失败", async () => {
    const result = await callTool(adapter.client, "execute_tool", {
      tool: "完全不存在的工具",
    });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /未能定位到工具/);
    assert.match(textOf(result), /search_tools/);
  });

  it("execute_tool 把底层返回的原始结果原样透传（长文本不截断、特殊字符不转义）", async () => {
    // 刻意构造长文本 + 需要转义的字符：验证网关没有做任何加工
    const payload = [
      "中文内容",
      "换行\n第二行",
      '引号"与反斜杠\\',
      "x".repeat(5000),
    ].join("|");

    const result = await callTool(adapter.client, "execute_tool", {
      tool: "demo.echo",
      arguments: { text: payload },
    });

    assert.equal(result.isError, undefined);
    const text = textOf(result);
    assert.equal(
      text.length,
      payload.length + "echo:".length,
      `长文本必须原样透传：期望 ${payload.length + 5} 字符，实际 ${text.length}`,
    );
    assert.ok(text.includes("x".repeat(5000)), "长文本不得被截断");
    assert.ok(text.includes("换行\n第二行"), "换行符不得被转义或吞掉");
    assert.ok(text.includes('引号"与反斜杠\\'), "引号与反斜杠不得被转义");
  });

  it("底层工具的业务失败不会被误判成网关断连", async () => {
    // 错误文案里刻意带上 "connection closed"：如果分类靠匹配文本，
    // 这里就会被套上断连引导，给出完全错误的处置建议
    const result = await callTool(adapter.client, "execute_tool", {
      tool: "demo.fail",
      arguments: { message: "database connection closed unexpectedly" },
    });

    assert.equal(result.isError, true);
    const text = textOf(result);
    assert.match(
      text,
      /database connection closed unexpectedly/,
      "业务错误应原样透传",
    );
    assert.doesNotMatch(
      text,
      /与 \[demo\] 的连接已断开/,
      "业务失败不该被套用断连引导",
    );
  });
});

// ---- 可见性与可执行性过滤 ----

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

// ---- 关闭启动期体检 ----

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

// ---- 环境变量与工作目录 ----

describe("元工具 - env / inheritEnv / cwd (e2e)", () => {
  const HOST_PROBE = "MCP_ADAPTER_E2E_HOST_PROBE";
  let adapter: AdapterHandle;
  let cwdTarget = "";

  before(async () => {
    cwdTarget = fs.realpathSync(
      trackTmpDir(fs.mkdtempSync(path.join(os.tmpdir(), "mcp-adapter-cwd-"))),
    );

    adapter = await startAdapter(
      ({ spawnLog }) => ({
        version: 1,
        settings: { startupMetadataCheck: true },
        mcpServers: {
          inheritOn: fakeServer({
            env: { FAKE_SPAWN_LOG: spawnLog, E2E_EXPLICIT: "explicit-on" },
          }),
          inheritOff: fakeServer({
            inheritEnv: false,
            env: { FAKE_SPAWN_LOG: spawnLog, E2E_EXPLICIT: "explicit-off" },
          }),
          withCwd: fakeServer({
            cwd: cwdTarget,
            env: { FAKE_SPAWN_LOG: spawnLog },
          }),
        },
      }),
      { [HOST_PROBE]: "host-value" },
    );

    await waitForCache(adapter.home, ["inheritOn", "inheritOff", "withCwd"]);
  });

  after(async () => {
    await adapter.stop();
  });

  it("config.env 中显式配置的变量会传给子进程", async () => {
    const on = await callTool(adapter.client, "execute_tool", {
      tool: "inheritOn.env",
      arguments: { name: "E2E_EXPLICIT" },
    });
    assert.equal(textOf(on), "env:E2E_EXPLICIT=explicit-on");

    const off = await callTool(adapter.client, "execute_tool", {
      tool: "inheritOff.env",
      arguments: { name: "E2E_EXPLICIT" },
    });
    assert.equal(
      textOf(off),
      "env:E2E_EXPLICIT=explicit-off",
      "inheritEnv=false 时显式 env 仍然必须生效",
    );
  });

  it("inheritEnv 默认为 true，子进程能读到宿主进程的环境变量", async () => {
    const result = await callTool(adapter.client, "execute_tool", {
      tool: "inheritOn.env",
      arguments: { name: HOST_PROBE },
    });
    assert.equal(textOf(result), `env:${HOST_PROBE}=host-value`);
  });

  it("inheritEnv=false 时子进程读不到宿主任意变量", async () => {
    const result = await callTool(adapter.client, "execute_tool", {
      tool: "inheritOff.env",
      arguments: { name: HOST_PROBE },
    });
    assert.equal(
      textOf(result),
      `env:${HOST_PROBE}=<unset>`,
      "inheritEnv=false 应隔离宿主任意变量",
    );
  });

  it("inheritEnv=false 仍保留 SDK 的跨平台安全默认集（PATH / HOME）", async () => {
    for (const key of ["PATH", "HOME"]) {
      const result = await callTool(adapter.client, "execute_tool", {
        tool: "inheritOff.env",
        arguments: { name: key },
      });
      assert.doesNotMatch(
        textOf(result),
        /<unset>/,
        `inheritEnv=false 不应把 ${key} 也一起剥掉，否则子进程无法正常工作`,
      );
    }
  });

  it("cwd 配置会真正改变子进程的工作目录", async () => {
    const result = await callTool(adapter.client, "execute_tool", {
      tool: "withCwd.cwd",
    });
    assert.equal(textOf(result), `cwd:${cwdTarget}`);
  });
});

// ---- eager 预热 ----

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

// ---- 服务不可用时的降级 ----

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

// ---- 缓存有效性对进程拉起的影响 ----

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

// ---- 优雅退出 ----

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

// ---- 顽固子进程的退出收敛 ----

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
