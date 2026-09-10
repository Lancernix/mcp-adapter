#!/usr/bin/env node
// fake-mcp-server.mjs - 零依赖的最小 MCP stdio server，用于进程生命周期测试。
//
// 之所以不用 SDK 的 Server 实现：测试要能精确制造故障（初始化慢、直接崩溃、
// 忽略 SIGTERM 等），手写 JSON-RPC 循环可控性最高，也不引入加载器依赖。
//
// 环境变量：
//   FAKE_SPAWN_LOG      每次启动把 pid 追加到该文件（用于统计 spawn 次数）
//   FAKE_INIT_DELAY_MS  initialize 响应延迟，用于制造"建连中"状态
//   FAKE_STUBBORN       1 = 忽略 stdin 关闭与 SIGTERM，只能被 SIGKILL 杀死
//
// 暴露的工具：
//   echo   { text }   立即回显
//   sleep  { ms }     延迟 ms 后返回
//   pid    {}         返回当前进程 pid
//   crash  {}         立即 process.exit(7)（用来模拟子进程意外崩溃）

import fs from "node:fs";
import process from "node:process";

const SPAWN_LOG = process.env.FAKE_SPAWN_LOG;
const INIT_DELAY_MS = Number(process.env.FAKE_INIT_DELAY_MS ?? 0);
const STUBBORN = process.env.FAKE_STUBBORN === "1";

if (SPAWN_LOG) {
  try {
    fs.appendFileSync(SPAWN_LOG, `${process.pid}\n`, "utf-8");
  } catch {
    // 统计文件写失败不影响协议行为
  }
}

if (STUBBORN) {
  // 注册 SIGTERM handler 会让 Node 不再走默认终止路径 —— 正是我们要的"顽固"行为；
  // 同时挂一个定时器让事件循环在 stdin 关闭后依然存活。
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
}

const TOOLS = [
  {
    name: "echo",
    description: "回显给定文本",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
  {
    name: "sleep",
    description: "延迟指定毫秒后返回",
    inputSchema: {
      type: "object",
      properties: { ms: { type: "number" } },
      required: ["ms"],
    },
  },
  {
    name: "pid",
    description: "返回当前子进程 pid",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "crash",
    description: "立即退出进程，模拟意外崩溃",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "env",
    description: "读取本进程看到的环境变量，用于验证 env / inheritEnv 配置",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  },
  {
    name: "cwd",
    description: "返回本进程的工作目录，用于验证 cwd 配置",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "fail",
    description: "以指定文案返回一个业务失败，用于验证错误分类不会误判",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
    },
  },
];

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function write(message) {
  try {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  } catch {
    // 连接已被对端关闭时写入会失败，忽略即可
  }
}

function respond(id, result) {
  write({ jsonrpc: "2.0", id, result });
}

function respondError(id, code, message) {
  write({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handleToolCall(id, params) {
  const name = params?.name;
  const args = params?.arguments ?? {};

  switch (name) {
    case "echo":
      respond(id, {
        content: [{ type: "text", text: `echo:${String(args.text ?? "")}` }],
      });
      return;
    case "sleep": {
      const ms = Number(args.ms ?? 0);
      await delay(ms);
      respond(id, { content: [{ type: "text", text: `slept:${ms}` }] });
      return;
    }
    case "pid":
      respond(id, { content: [{ type: "text", text: `pid:${process.pid}` }] });
      return;
    case "crash":
      process.exit(7);
      return;
    case "env": {
      const key = String(args.name ?? "");
      const value = process.env[key];
      respond(id, {
        content: [
          {
            type: "text",
            text: `env:${key}=${value === undefined ? "<unset>" : value}`,
          },
        ],
      });
      return;
    }
    case "cwd":
      respond(id, {
        content: [{ type: "text", text: `cwd:${process.cwd()}` }],
      });
      return;
    case "fail":
      // 故意用一个非 -32000 的错误码，模拟底层工具自身的业务失败
      respondError(id, -32603, String(args.message ?? "business failure"));
      return;
    default:
      respondError(id, -32602, `Unknown tool: ${String(name)}`);
  }
}

async function handle(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  const { id, method, params } = message;

  if (method === "initialize") {
    if (INIT_DELAY_MS > 0) await delay(INIT_DELAY_MS);
    // 回显客户端请求的 protocolVersion，保证落在 SDK 的支持列表里
    respond(id, {
      protocolVersion: params?.protocolVersion ?? "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "fake-mcp-server", version: "1.0.0" },
    });
    return;
  }

  if (method === "tools/list") {
    respond(id, { tools: TOOLS });
    return;
  }

  if (method === "tools/call") {
    await handleToolCall(id, params);
    return;
  }

  if (method === "ping") {
    respond(id, {});
    return;
  }

  // 通知类消息（notifications/*）没有 id，不回复
  if (id !== undefined && id !== null) {
    respondError(id, -32601, `Method not found: ${String(method)}`);
  }
}

let buffer = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\n");
  while (index !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) void handle(line);
    index = buffer.indexOf("\n");
  }
});

// 非顽固模式下，stdin 关闭即视为父进程已退出，主动结束自己
process.stdin.on("end", () => {
  if (!STUBBORN) process.exit(0);
});
process.stdin.on("error", () => {
  if (!STUBBORN) process.exit(0);
});
