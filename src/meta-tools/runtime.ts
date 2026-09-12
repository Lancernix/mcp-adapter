// runtime.ts - 网关的进程级共享状态与元工具公共辅助
//
// config / serverManager / searchIndex / bootstrapStatus 的唯一归属。
// 各 meta-tools 模块从这里取共享状态；index.ts 只负责在 initialize 时装配。
//
// `config` 用 `export let` 导出：ESM 的 live binding 保证所有模块读到的是
// 同一份最新值，setConfig 只能在本模块内调用（装配层 initialize 时调用一次）。

import { getValidCachedServers, loadMetadataCache } from "../cache-manager.js";
import { writeLog } from "../logger.js";
import { SearchIndex } from "../search-index.js";
import { McpServerManager } from "../server-manager.js";
import type { AdapterConfig, BootstrapStatus } from "../types.js";

export let config: AdapterConfig;

/** 只在进程装配阶段调用一次（index.ts 的 initialize） */
export function setConfig(next: AdapterConfig): void {
  config = next;
}

export const serverManager = new McpServerManager();
export const searchIndex = new SearchIndex();

export const bootstrapStatus: BootstrapStatus = {
  running: false,
  total: 0,
  completed: 0,
  errors: [],
};

export function isServerDisabled(serverName: string): boolean {
  return config.mcpServers[serverName]?.disabled === true;
}

export function disabledServerText(serverName: string): string {
  return `[mcp-adapter-ERROR] server "${serverName}" 已被 disabled，无法搜索、描述或调用。请在 config.json 中取消 disabled 后重试。`;
}

/**
 * 确保指定服务的工具元数据可用（缓存有效则短路，失效则刷新并重建索引）。
 * search / list / describe 三个元工具共享的唯一刷新入口。
 */
export async function ensureServerMetadata(
  serverName: string,
): Promise<boolean> {
  const serverConfig = config.mcpServers[serverName];
  if (!serverConfig || serverConfig.disabled) return false;

  try {
    // refreshMetadataIfNeeded 内部先做有效性三校验（结构 / configHash / TTL），
    // 缓存有效就返回 false —— 既不连子进程，也不写 cache.json。
    const refreshed = await serverManager.refreshMetadataIfNeeded(
      serverName,
      serverConfig,
      {
        cacheTtlDays: config.settings?.cacheTtlDays,
        connectTimeoutMs: config.settings?.connectTimeoutMs,
        requestTimeoutMs: config.settings?.requestTimeoutMs,
        closeTimeoutMs: config.settings?.closeTimeoutMs,
        failureBackoffMs: config.settings?.failureBackoffMs,
        closeIfCreated: true,
      },
    );

    // 没有真的刷新，就什么都不用做：索引在启动时建过一次，之后每次真正刷新
    // 都会跟着重建，此刻它一定是最新的。返回 true 的语义也对得上 ——
    // refreshMetadataIfNeeded 只有在 isServerCacheValid 通过时才返回 false，
    // 而上面已经排除了 disabled 的情况，所以该服务必然在有效缓存里。
    //
    // 这一步同时消除了并发放大：同一 server 的并发检索只会有一个真正执行刷新，
    // 于是也只有一个会重建索引（metadataRefreshPromises 去重的是刷新，不是重建）。
    if (!refreshed) return true;

    const refreshedCache = loadMetadataCache();
    const validCachedServers = getValidCachedServers(config, refreshedCache);
    searchIndex.buildIndex(config.mcpServers, validCachedServers);

    return !!validCachedServers[serverName];
  } catch (err) {
    writeLog(
      `[Metadata] 刷新 ${serverName} 工具元数据失败: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return false;
  }
}
