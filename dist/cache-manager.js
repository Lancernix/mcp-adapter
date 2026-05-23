// cache-manager.ts - Cache management for @lancernix/mcp-adapter
import * as fs from "fs";
import { createHash } from "crypto";
import { getCachePath, getMcpAdapterHome } from "./config-manager.js";
export const CACHE_VERSION = 1;
export const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 天
export function loadMetadataCache() {
    const cachePath = getCachePath();
    if (!fs.existsSync(cachePath)) {
        return null;
    }
    try {
        const raw = fs.readFileSync(cachePath, "utf-8");
        const parsed = JSON.parse(raw);
        if (parsed && parsed.version === CACHE_VERSION && parsed.servers) {
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
 */
export function saveMetadataCache(cache) {
    const cachePath = getCachePath();
    const home = getMcpAdapterHome();
    if (!fs.existsSync(home)) {
        fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    }
    let merged = { version: CACHE_VERSION, servers: {} };
    const existing = loadMetadataCache();
    if (existing) {
        merged.servers = { ...existing.servers };
    }
    // 合并最新的 server cache 记录
    merged.servers = { ...merged.servers, ...cache.servers };
    const tmpPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
    try {
        fs.writeFileSync(tmpPath, JSON.stringify(merged, null, 2), { encoding: "utf-8", mode: 0o600 });
        fs.renameSync(tmpPath, cachePath);
    }
    catch (err) {
        if (fs.existsSync(tmpPath)) {
            try {
                fs.unlinkSync(tmpPath);
            }
            catch { }
        }
        throw new Error(`原子保存 cache.json 失败: ${err.message}`);
    }
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
        return `[${value.map(v => stableStringify(v)).join(",")}]`;
    }
    const obj = value;
    const keys = Object.keys(obj).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}
/**
 * 计算哈希指纹，仅对可能改变工具定义的字段求和
 */
export function computeServerHash(definition) {
    const identity = {
        command: definition.command,
        args: definition.args,
        env: definition.env,
        cwd: definition.cwd,
        url: definition.url,
        headers: definition.headers
    };
    const normalized = stableStringify(identity);
    return createHash("sha256").update(normalized).digest("hex");
}
/**
 * 验证当前服务器缓存条目是否在 1.指纹、2.生存期、3.版本上完好有效
 */
export function isServerCacheValid(entry, definition, maxAgeMs = CACHE_MAX_AGE_MS) {
    if (!entry)
        return false;
    if (entry.configHash !== computeServerHash(definition))
        return false;
    if (!entry.cachedAt || typeof entry.cachedAt !== "number")
        return false;
    if (maxAgeMs > 0 && Date.now() - entry.cachedAt > maxAgeMs)
        return false;
    return true;
}
