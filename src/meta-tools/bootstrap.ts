// bootstrap.ts - 启动期 metadata 体检与 eager 服务预热
//
// 都不阻塞网关就绪：体检把失效缓存的工具目录"一个一个冒出来"，
// 预热把 eager 服务的冷启动延迟从首次真实调用提前到启动阶段。

import {
  getValidCachedServers,
  isServerCacheValid,
  loadMetadataCache,
} from "../cache-manager.js";
import type { McpLifecycleManager } from "../lifecycle.js";
import { writeLog } from "../logger.js";
import type { ServerConfig } from "../types.js";
import {
  bootstrapStatus,
  config,
  searchIndex,
  serverManager,
} from "./runtime.js";

let bootstrapStarted = false;

function getServersNeedingMetadataRefresh(): Array<[string, ServerConfig]> {
  const latestCache = loadMetadataCache();
  const ttlDays = config.settings?.cacheTtlDays ?? 7;
  const maxAgeMs = ttlDays * 24 * 60 * 60 * 1000;

  const result: Array<[string, ServerConfig]> = [];

  for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
    if (serverConfig.disabled) continue;

    // refreshOnStartup: 每次启动都强制刷新（适用于在线 server）
    if (serverConfig.refreshOnStartup) {
      result.push([name, serverConfig]);
      continue;
    }

    const entry = latestCache?.servers?.[name];
    if (!isServerCacheValid(entry, serverConfig, maxAgeMs)) {
      result.push([name, serverConfig]);
    }
  }

  return result;
}

export function startBackgroundBootstrapIfNeeded(): void {
  if (bootstrapStarted) return;

  const startupCheckEnabled = config.settings?.startupMetadataCheck ?? true;
  const candidates = getServersNeedingMetadataRefresh();
  const forcedServers = candidates.filter(
    ([, cfg]) => cfg.refreshOnStartup === true,
  );

  // startupMetadataCheck=false 只应关闭"按 TTL 兜底刷新"，不应连带吞掉显式的
  // refreshOnStartup 声明。否则两个配置项组合时强制刷新会静默失效。
  const missingServers = startupCheckEnabled ? candidates : forcedServers;

  if (!startupCheckEnabled) {
    writeLog(
      "[Bootstrap] 已关闭启动期 metadata 体检（startupMetadataCheck: false）" +
        (forcedServers.length > 0
          ? `，仅刷新显式声明 refreshOnStartup 的 ${forcedServers.length} 个服务。\n`
          : "，缓存将在按需检索发现失效时才刷新。\n"),
    );
  }

  if (missingServers.length === 0) {
    if (startupCheckEnabled) {
      writeLog(
        "[Bootstrap] 全部服务 metadata 缓存有效，本次体检无需刷新任何服务。\n",
      );
    }
    return;
  }

  // 把"体检了谁、谁被强制重拉"打成一行，方便直接对照 config.json 排查
  const pendingNames = missingServers.map(([name]) => name);
  const forcedNames = forcedServers.map(([name]) => name);
  writeLog(
    `[Bootstrap] 启动期 metadata 体检开始：${pendingNames.length} 个服务待刷新 —— ${pendingNames.join(", ")}\n`,
  );
  if (forcedNames.length > 0) {
    writeLog(
      `[Bootstrap] 其中 ${forcedNames.length} 个服务声明了 refreshOnStartup，将跳过 configHash/TTL 检查、无条件重新拉取工具列表：${forcedNames.join(", ")}\n`,
    );
  }

  bootstrapStarted = true;

  setTimeout(() => {
    bootstrapServersSequentially(missingServers).catch((err) => {
      bootstrapStatus.running = false;
      bootstrapStatus.finishedAt = Date.now();
      writeLog(
        `[Bootstrap-Fatal] 后台 metadata 初始化异常中止: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    });
  }, 0);
}

/**
 * 后台预热 lifecycle=eager 的服务：主动建连，把冷启动延迟从"首次真实调用"
 * 提前到"启动阶段"。与 metadata bootstrap 一样不阻塞网关就绪。
 */
export function warmupEagerServersInBackground(
  lifecycle: McpLifecycleManager | undefined,
): void {
  setTimeout(() => {
    lifecycle?.warmupEagerServers().catch((err) => {
      writeLog(
        `[Lifecycle-Warning] eager 预热流程异常: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    });
  }, 0);
}

async function bootstrapServersSequentially(
  servers: Array<[string, ServerConfig]>,
): Promise<void> {
  bootstrapStatus.running = true;
  bootstrapStatus.startedAt = Date.now();
  bootstrapStatus.finishedAt = undefined;
  bootstrapStatus.total = servers.length;
  bootstrapStatus.completed = 0;
  bootstrapStatus.errors = [];

  writeLog(
    `[Bootstrap] 后台 metadata 初始化开始，共 ${servers.length} 个服务待刷新。\n`,
  );

  for (const [name, srvConfig] of servers) {
    bootstrapStatus.current = name;

    try {
      writeLog(
        `[Bootstrap] 正在刷新 [${name}]（${
          srvConfig.refreshOnStartup === true
            ? "refreshOnStartup 强制重拉"
            : "缓存缺失或已失效"
        }）...\n`,
      );

      const refreshed = await serverManager.refreshMetadataIfNeeded(
        name,
        srvConfig,
        {
          cacheTtlDays: config.settings?.cacheTtlDays,
          connectTimeoutMs: config.settings?.connectTimeoutMs,
          requestTimeoutMs: config.settings?.requestTimeoutMs,
          closeTimeoutMs: config.settings?.closeTimeoutMs,
          failureBackoffMs: config.settings?.failureBackoffMs,
          // 后台 bootstrap 的瞬时失败（如 npx 冷启动下载慢）不记录冷却，
          // 否则会把前台对该服务的 search/execute 拒之门外长达一个冷却窗口
          recordFailureBackoff: false,
          closeIfCreated: true,
          forceRefresh: srvConfig.refreshOnStartup === true,
        },
      );

      const freshCache = loadMetadataCache();
      const validCachedServers = getValidCachedServers(config, freshCache);
      searchIndex.buildIndex(config.mcpServers, validCachedServers);

      if (refreshed && !validCachedServers[name]) {
        throw new Error(
          `刷新后未得到有效 metadata cache，server "${name}" 缓存写入可能失败`,
        );
      }

      const toolCount = validCachedServers[name]?.tools?.length ?? 0;
      const statusText = refreshed
        ? `发现 ${toolCount} 个工具`
        : "缓存有效，跳过";
      writeLog(`[Bootstrap] ✓ [${name}] metadata 刷新完成，${statusText}。\n`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      bootstrapStatus.errors.push({ server: name, message });
      writeLog(`[Bootstrap-Warning] 刷新 [${name}] 失败: ${message}\n`);
    } finally {
      bootstrapStatus.completed++;
      bootstrapStatus.current = undefined;
    }
  }

  bootstrapStatus.running = false;
  bootstrapStatus.finishedAt = Date.now();

  const latestCache = loadMetadataCache();
  const validCachedServers = getValidCachedServers(config, latestCache);
  searchIndex.buildIndex(config.mcpServers, validCachedServers);

  const successCount =
    bootstrapStatus.completed - bootstrapStatus.errors.length;
  writeLog(
    `[Bootstrap] 后台 metadata 初始化完成。成功: ${successCount}，失败: ${bootstrapStatus.errors.length}\n`,
  );
}
