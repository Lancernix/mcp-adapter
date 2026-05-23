import type { MetadataCache, ServerCacheEntry, ServerConfig } from "./types.js";
export declare const CACHE_VERSION = 1;
export declare const CACHE_MAX_AGE_MS: number;
export declare function loadMetadataCache(): MetadataCache | null;
/**
 * 原子、安全写缓存：使用 temp 文件 + fs.renameSync
 */
export declare function saveMetadataCache(cache: MetadataCache): void;
/**
 * 稳定、确定性的 JSON 序列化，忽略对象键无序产生的干扰，保障哈希指纹唯一稳定
 */
export declare function stableStringify(value: unknown): string;
/**
 * 计算哈希指纹，仅对可能改变工具定义的字段求和
 */
export declare function computeServerHash(definition: ServerConfig): string;
/**
 * 验证当前服务器缓存条目是否在 1.指纹、2.生存期、3.版本上完好有效
 */
export declare function isServerCacheValid(entry: ServerCacheEntry | undefined, definition: ServerConfig, maxAgeMs?: number): boolean;
