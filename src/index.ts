#!/usr/bin/env node
// index.ts - 网关入口与装配层
//
// 这里不写业务逻辑，只做四件事：
//   1. 装配共享状态（加载配置、建索引、启动 sweeper、死亡守卫）
//   2. 创建 McpServer 并显式注册 4 个元工具（网关对外暴露的清单一目了然）
//   3. 连接 stdio 传输，启动后台体检与 eager 预热
//   4. 分发 `import` CLI 子命令
//
// 各元工具的实现与注册函数在 meta-tools/，工具定位辅助在 meta-tools/locate-tool.ts，
// 共享状态唯一归属在 meta-tools/runtime.ts。

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getValidCachedServers, loadMetadataCache } from "./cache-manager.js";
import { runImportCommand } from "./cli/import-command.js";
import {
  getMcpAdapterHome,
  loadConfig,
  takeConfigMigrationNotes,
} from "./config-manager.js";
import { McpLifecycleManager } from "./lifecycle.js";
import { setConfigRef, writeLog } from "./logger.js";
import {
  startBackgroundBootstrapIfNeeded,
  warmupEagerServersInBackground,
} from "./meta-tools/bootstrap.js";
import {
  registerDescribeTool,
  registerListTools,
} from "./meta-tools/catalog-tools.js";
import { registerExecuteTool } from "./meta-tools/execute-tool.js";
import {
  config,
  searchIndex,
  serverManager,
  setConfig,
} from "./meta-tools/runtime.js";
import { registerSearchTools } from "./meta-tools/search-tools.js";
import { GATEWAY_VERSION } from "./version.js";

// ---- 共享状态 ----

const mcpServer = new McpServer(
  {
    name: "mcp-adapter",
    version: GATEWAY_VERSION,
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

let lifecycleManager: McpLifecycleManager;

// ---- 网关对外暴露的全部元工具（清单） ----

registerSearchTools(mcpServer);
registerDescribeTool(mcpServer);
registerListTools(mcpServer);
registerExecuteTool(mcpServer);

// ---- 启动 ----

async function initialize() {
  writeLog(
    `[@lancernix/mcp-adapter] 正在从 ${getMcpAdapterHome()} 启动冷装载...\n`,
  );

  try {
    setConfig(loadConfig());
    setConfigRef(() => config);
    for (const note of takeConfigMigrationNotes()) {
      writeLog(`[Config-Migration] ${note}\n`);
    }
  } catch (err) {
    writeLog(
      `[Error] 无法启动网关，config.json 加载失败: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }

  const initialCache = loadMetadataCache();
  const validCachedServers = getValidCachedServers(config, initialCache);
  searchIndex.buildIndex(config.mcpServers, validCachedServers);

  lifecycleManager = new McpLifecycleManager(serverManager, config);
  lifecycleManager.startSweeper(30000);

  setupParentDeathWatch();
}

// ---- 退出 ----

let shutdownInProgress = false;

async function shutdownAndExit(reason: string) {
  if (shutdownInProgress) return;
  shutdownInProgress = true;

  // stdin 的两个事件与两个信号都要摘掉：守卫能保证不重复执行，但监听器留着
  // 会让 Node 保持事件循环存活，进程退出得更慢
  process.stdin.removeAllListeners("close");
  process.stdin.removeAllListeners("end");
  process.removeAllListeners("SIGINT");
  process.removeAllListeners("SIGTERM");

  writeLog(`[Shutdown] ${reason}\n`);

  lifecycleManager?.stopSweeper();
  const configuredCloseTimeoutMs = config?.settings?.closeTimeoutMs ?? 10000;
  const closeTimeoutMs =
    configuredCloseTimeoutMs <= 0 ? 10000 : configuredCloseTimeoutMs;
  await serverManager.shutdownAll(closeTimeoutMs, true);
  process.exit(0);
}

function setupParentDeathWatch() {
  // 宿主（Claude Code 等）正常退出时是**关闭 stdio 管道**，不发信号。
  // 对端发来 FIN 后，process.stdin 先触发 "end"（流结束），流被销毁后再触发
  // "close"。实测两者都会来，所以单监听 close 也能退出；这里两个都监听，
  // 是为了让清理在 "end" 那一刻就启动、不必等到流销毁，同时防止将来某个
  // Node 版本或 stdio 配置下 close 延迟/不来时彻底收不到退出信号。
  // shutdownAndExit 有重入守卫，两个事件都到也只会执行一次。
  const onParentGone = () => {
    void shutdownAndExit("检测到父进程管道已断开");
  };
  process.stdin.on("end", onParentGone);
  process.stdin.on("close", onParentGone);

  process.on("SIGINT", () => {
    void shutdownAndExit("收到 SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdownAndExit("收到 SIGTERM");
  });
}

// ---- 入口 ----

async function main() {
  const args = process.argv.slice(2);

  if (args[0] === "import") {
    runImportCommand(args);
    return;
  }

  await initialize();

  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);

  writeLog(
    "[mcp-adapter] 网关 Server 已经就绪，打通 Stdio Stdin/Stdout 通道。\n",
  );

  startBackgroundBootstrapIfNeeded();
  warmupEagerServersInBackground(lifecycleManager);
}

main().catch((err) => {
  writeLog(`[Fatal] 网关发生致命异常崩溃: ${err.message}\n`);
  process.exit(1);
});
