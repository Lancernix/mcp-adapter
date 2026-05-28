#!/usr/bin/env node
/**
 * memory-benchmark.js
 * 模拟"直接注册所有 MCP 服务"场景，启动所有 stdio 服务的子进程，
 * 测量其物理内存(RSS)总和，与 mcp-adapter 单进程内存对比。
 *
 * 用法: node scripts/memory-benchmark.js
 */

import { spawn, execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const CONFIG_PATH =
  process.env.MCP_ADAPTER_HOME
    ? path.join(process.env.MCP_ADAPTER_HOME, "config.json")
    : path.join(os.homedir(), ".mcp-adapter", "config.json");

let config;
try {
  config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
} catch (err) {
  console.error(`无法读取 config: ${CONFIG_PATH}\n${err.message}`);
  process.exit(1);
}

const stdioServers = Object.entries(config.mcpServers).filter(
  ([, cfg]) => (cfg.type ?? "stdio") === "stdio" && !cfg.disabled,
);

if (stdioServers.length === 0) {
  console.log("没有配置 stdio 类型的服务，无法测试。");
  process.exit(0);
}

// ---- 获取 adapter RSS ----
function getAdapterRSS() {
  const out = execSync(
    "ps -eo pid,rss,command | grep 'dist/index.js' | grep -v grep | grep -v memory-benchmark",
    { encoding: "utf-8" },
  ).trim();
  if (!out) return 0;
  const parts = out.split(/\s+/);
  return parseInt(parts[1], 10);
}

// ---- 获取指定 PID 及其所有子进程的 RSS ----
function getProcessTreeRSS(pid) {
  const pids = new Set([pid]);
  // 获取子进程 PID
  try {
    const childOut = execSync(`pgrep -P ${pid} 2>/dev/null || true`, { encoding: "utf-8" }).trim();
    if (childOut) {
      childOut.split("\n").forEach((p) => pids.add(parseInt(p, 10)));
    }
  } catch {}
  // 二级子进程
  for (const p of [...pids]) {
    try {
      const grandchildOut = execSync(`pgrep -P ${p} 2>/dev/null || true`, { encoding: "utf-8" }).trim();
      if (grandchildOut) {
        grandchildOut.split("\n").forEach((gp) => pids.add(parseInt(gp, 10)));
      }
    } catch {}
  }

  let totalRSS = 0;
  for (const p of pids) {
    try {
      const out = execSync(`ps -p ${p} -o rss= 2>/dev/null || true`, { encoding: "utf-8" }).trim();
      if (out) totalRSS += parseInt(out, 10);
    } catch {}
  }
  return totalRSS;
}

console.log(`找到 ${stdioServers.length} 个 stdio 服务:\n`);
for (const [name, cfg] of stdioServers) {
  console.log(`  ${name}: ${cfg.command} ${(cfg.args || []).join(" ")}`);
}

// ---- 启动所有服务 ----
console.log("\n正在启动所有 stdio 服务...\n");
const children = [];

for (const [name, cfg] of stdioServers) {
  const child = spawn(cfg.command, cfg.args || [], {
    env: { ...process.env, ...(cfg.env || {}) },
    stdio: ["pipe", "pipe", "pipe"],
    cwd: cfg.cwd || process.cwd(),
  });
  child.on("error", (err) => console.error(`  [${name}] 启动失败: ${err.message}`));
  children.push({ name, pid: child.pid, child });
  console.log(`  ✓ ${name} 已启动 (PID: ${child.pid})`);
}

// ---- 等待稳定 ----
const WAIT_SEC = 15;
console.log(`\n等待 ${WAIT_SEC} 秒让进程稳定...`);
await new Promise((r) => setTimeout(r, WAIT_SEC * 1000));

// ---- 测量每个服务 ----
console.log("\n========== 测量结果 ==========\n");
console.log("服务                     PID       RSS(KB)   RSS(MB)");
console.log("-".repeat(60));

let totalServerRSS = 0;
for (const { name, pid } of children) {
  const rss = getProcessTreeRSS(pid);
  totalServerRSS += rss;
  console.log(
    `${name.padEnd(25)} ${String(pid).padEnd(10)} ${String(rss).padEnd(10)} ${(rss / 1024).toFixed(1)}`,
  );
}

console.log("-".repeat(60));
console.log(
  `${"直接注册合计".padEnd(25)} ${"".padEnd(10)} ${String(totalServerRSS).padEnd(10)} ${(totalServerRSS / 1024).toFixed(1)}`,
);

// ---- adapter 对比 ----
const adapterRSS = getAdapterRSS();
console.log("");
console.log("========== 对比 ==========\n");
console.log(
  `直接注册 ${stdioServers.length} 个服务:    ${totalServerRSS} KB (${(totalServerRSS / 1024).toFixed(1)} MB)`,
);
console.log(
  `mcp-adapter 单进程:       ${adapterRSS} KB (${(adapterRSS / 1024).toFixed(1)} MB)`,
);

if (totalServerRSS > 0 && adapterRSS > 0) {
  const saved = totalServerRSS - adapterRSS;
  const pct = ((saved / totalServerRSS) * 100).toFixed(1);
  console.log(
    `\n节省内存:                 ${saved} KB (${(saved / 1024).toFixed(1)} MB) = ${pct}%`,
  );
}

// ---- 清理 ----
console.log("\n正在关闭所有测试进程...");
for (const { child } of children) {
  try { child.kill("SIGTERM"); } catch {}
}
await new Promise((r) => setTimeout(r, 2000));
for (const { child, pid } of children) {
  try { if (child.exitCode === null) process.kill(pid, "SIGKILL"); } catch {}
}
console.log("测试完成。");
process.exit(0);