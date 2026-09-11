// helpers.ts - 测试套件共享工具
//
// 放在 __tests__/ 下但**故意不以 .test.ts 结尾**，因此不会被
// `tsx --test __tests__/*.test.ts` 收集成用例，只作为公共底座被引用。
//
// 这里只放真正跨文件复用的东西：进程观测（是否存活、轮询等待）、
// 假 MCP server 的定位与 spawn 记录读取、临时工作区创建。
// 用例特定的夹具（如 startAdapter）仍留在各自的测试文件里。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/** 零依赖假 MCP stdio server 的绝对路径 */
export const FAKE_SERVER = path.join(
  ROOT,
  "__tests__",
  "fixtures",
  "fake-mcp-server.mjs",
);

export const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** 进程是否还存在（pid 已被回收则返回 false） */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 轮询等待条件成立。
 * 返回布尔值而不是直接抛错，让调用方自己决定失败时如何给出诊断信息
 * （多数情况下要把 adapter 的 stderr 一起打出来才定位得了问题）。
 */
export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 10000,
  intervalMs = 25,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(intervalMs);
  }
  return predicate();
}

/**
 * 读取假 server 的 spawn 记录：它每次启动都会把自己 pid 追加一行。
 * 文件不存在表示一次都没被拉起过。
 */
export function readPids(logPath: string): number[] {
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, "utf-8")
    .split("\n")
    .map((line) => Number(line.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}

/**
 * 创建一个临时目录并把 MCP_ADAPTER_HOME 指向它，用于隔离测试间的配置与缓存。
 * 目录会登记在模块级的清理清单里，测试进程退出时统一删除——每次全量跑会在
 * /tmp 留下十几个目录，靠系统清理既慢又不可控。
 */
export function mkdtempHome(prefix = "mcp-adapter-test-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.MCP_ADAPTER_HOME = dir;
  tmpDirs.add(dir);
  return dir;
}

const tmpDirs = new Set<string>();

/** 登记一个需要随测试进程退出的临时目录（自行 mkdtemp 的地方用它挂上清理） */
export function trackTmpDir(dir: string): string {
  tmpDirs.add(dir);
  return dir;
}

process.on("exit", () => {
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // 清理失败无所谓，不影响测试结果
    }
  }
  tmpDirs.clear();
});
