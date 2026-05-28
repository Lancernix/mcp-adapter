import type { AdapterConfig, MetadataCache, ServerCacheEntry, ServerConfig } from "./types.js";
export declare const CACHE_VERSION = 1;
export declare const CACHE_MAX_AGE_MS: number;
export declare function loadMetadataCache(): MetadataCache | null;
export declare function saveMetadataCache(cache: MetadataCache): Promise<void>;
/**
 * 稳定、确定性的 JSON 序列化，忽略对象键无序产生的干扰，保障哈希指纹唯一稳定
 */
export declare function stableStringify(value: unknown): string;
/**
 * 计算哈希指纹：遍历 ServerConfig 所有字段，仅排除 adapter 元数据。
 * 黑名单策略确保新增连接相关字段（如 type、caCert）自动纳入，无需手动维护白名单。
 */
export declare function computeServerHash(definition: ServerConfig): string;
/**
 * 验证当前服务器缓存条目是否在 1.结构、2.指纹、3.生存期上完好有效
 */
export declare function isServerCacheValid(entry: ServerCacheEntry | undefined, definition: ServerConfig, maxAgeMs?: number): boolean;
/**
 * 从全量缓存中过滤出 configHash 有效、TTL 未过期、且未被 disabled 的 server 缓存条目。
 * 确保 search_tools / describe_tool / locateTool 只使用当前配置对应的有效缓存。
 */
export declare function getValidCachedServers(config: AdapterConfig, cache: MetadataCache | null): Record<string, ServerCacheEntry>;
