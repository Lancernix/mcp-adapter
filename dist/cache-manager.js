// cache-manager.ts - Cache management for @lancernix/mcp-adapter
import { createHash } from "node:crypto";
import fs from "node:fs";
import { ensureDirs, getCachePath } from "./config-manager.js";
export const CACHE_VERSION = 1;
export const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 天
function isPlainObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
}
export function loadMetadataCache() {
    const cachePath = getCachePath();
    if (!fs.existsSync(cachePath)) {
        return null;
    }
    try {
        // 修正已有 cache 文件的权限，确保不含 world/group 可读
        try {
            fs.chmodSync(cachePath, 0o600);
        }
        catch { }
        const raw = fs.readFileSync(cachePath, "utf-8");
        const parsed = JSON.parse(raw);
        if (isPlainObject(parsed) &&
            parsed.version === CACHE_VERSION &&
            isPlainObject(parsed.servers)) {
            return parsed;
        }
        return null;
    }
    catch {
        return null;
    }
}
/**
 * 原子、安全写缓存：使用 temp 文件 + fs.renameSync
 * 内部串行化写操作，防止并发刷新导致 lost update。
 */
let cacheWriteQueue = Promise.resolve();
function doSaveMetadataCache(cache) {
    const cachePath = getCachePath();
    ensureDirs();
    const merged = { version: CACHE_VERSION, servers: {} };
    const existing = loadMetadataCache();
    if (existing) {
        merged.servers = { ...existing.servers };
    }
    // 合并最新的 server cache 记录
    merged.servers = { ...merged.servers, ...cache.servers };
    const tmpPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
    try {
        fs.writeFileSync(tmpPath, JSON.stringify(merged, null, 2), {
            encoding: "utf-8",
            mode: 0o600,
        });
        fs.renameSync(tmpPath, cachePath);
        try {
            fs.chmodSync(cachePath, 0o600);
        }
        catch { }
    }
    catch (err) {
        if (fs.existsSync(tmpPath)) {
            try {
                fs.unlinkSync(tmpPath);
            }
            catch { }
        }
        throw new Error(`原子保存 cache.json 失败: ${err instanceof Error ? err.message : String(err)}`);
    }
}
export function saveMetadataCache(cache) {
    const writeTask = cacheWriteQueue
        .catch(() => {
        // 吞掉上一轮错误，避免队列永久 rejected
    })
        .then(() => doSaveMetadataCache(cache));
    cacheWriteQueue = writeTask.catch(() => {
        // 保持队列链路健康；错误仍由 writeTask 返回给当前调用方
    });
    return writeTask;
}
/**
 * 稳定、确定性的 JSON 序列化，忽略对象键无序产生的干扰，保障哈希指纹唯一稳定
 */
export function stableStringify(value) {
    if (value === null || value === undefined || typeof value !== "object") {
        const serialized = JSON.stringify(value);
        return serialized === undefined ? "undefined" : serialized;
    }
    if (Array.isArray(value)) {
        return `[${value.map((v) => stableStringify(v)).join(",")}]`;
    }
    const obj = value;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}
// adapter 元数据字段——不影响底层 server 暴露什么工具，哈希计算时排除
const META_KEYS = new Set([
    "aliases",
    "lifecycle",
    "disabled",
    "idleTimeout",
    "refreshOnStartup",
    "connectTimeoutMs",
    "requestTimeoutMs",
    "closeTimeoutMs",
]);
/**
 * 计算哈希指纹：遍历 ServerConfig 所有字段，仅排除 adapter 元数据。
 * 黑名单策略确保新增连接相关字段（如 type、caCert）自动纳入，无需手动维护白名单。
 */
export function computeServerHash(definition) {
    const identity = {};
    for (const key of Object.keys(definition)) {
        if (META_KEYS.has(key))
            continue;
        identity[key] = definition[key];
    }
    const normalized = stableStringify(identity);
    return createHash("sha256").update(normalized).digest("hex");
}
function isValidCacheEntry(entry) {
    return (!!entry &&
        typeof entry === "object" &&
        typeof entry.configHash === "string" &&
        typeof entry.cachedAt === "number" &&
        Array.isArray(entry.tools));
}
/**
 * 验证当前服务器缓存条目是否在 1.结构、2.指纹、3.生存期上完好有效
 */
export function isServerCacheValid(entry, definition, maxAgeMs = CACHE_MAX_AGE_MS) {
    if (!isValidCacheEntry(entry))
        return false;
    if (entry.configHash !== computeServerHash(definition))
        return false;
    if (maxAgeMs > 0 && Date.now() - entry.cachedAt > maxAgeMs)
        return false;
    return true;
}
/**
 * 从全量缓存中过滤出 configHash 有效、TTL 未过期、且未被 disabled 的 server 缓存条目。
 * 确保 search_tools / describe_tool / locateTool 只使用当前配置对应的有效缓存。
 */
export function getValidCachedServers(config, cache) {
    if (!cache?.servers)
        return {};
    const result = {};
    const ttlDays = config.settings?.cacheTtlDays ?? 7;
    const maxAgeMs = ttlDays * 24 * 60 * 60 * 1000;
    for (const [serverName, serverConfig] of Object.entries(config.mcpServers)) {
        if (serverConfig.disabled)
            continue;
        const entry = cache.servers[serverName];
        if (isServerCacheValid(entry, serverConfig, maxAgeMs)) {
            result[serverName] = entry;
        }
    }
    return result;
}
