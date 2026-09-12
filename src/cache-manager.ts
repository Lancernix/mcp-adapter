// cache-manager.ts - Cache management for @lancernix/mcp-adapter

import { createHash } from "node:crypto";
import fs from "node:fs";
import { ensureDirs, getCachePath } from "./config-manager.js";
import type {
  AdapterConfig,
  CachedTool,
  MetadataCache,
  ServerCacheEntry,
  ServerConfig,
} from "./types.js";

export const CACHE_VERSION = 1;
export const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 天

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readCacheFromDisk(cachePath: string): MetadataCache | null {
  try {
    // 修正已有 cache 文件的权限，确保不含 world/group 可读。
    // chmod 只改 ctime 不改 mtime，不会把下面的快照判断打穿。
    try {
      fs.chmodSync(cachePath, 0o600);
    } catch {}

    const raw = fs.readFileSync(cachePath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;

    if (
      isPlainObject(parsed) &&
      parsed.version === CACHE_VERSION &&
      isPlainObject(parsed.servers)
    ) {
      return parsed as unknown as MetadataCache;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 进程内快照：用 mtime + size 判断磁盘上的文件是否还是上次解析的那一份。
 *
 * 为什么需要它：`loadMetadataCache()` 的调用点很多，其中 execute_tool 每次调用
 * 都会经由 locateTool 读一次。cache.json 里有全部工具的完整 inputSchema，
 * 规模到几百 KB 时，readFileSync + JSON.parse 的开销远大于 statSync。
 *
 * 为什么不用"读一次永久缓存"：多个 adapter 进程可能共享同一个工作区（多客户端
 * 指向同一个 MCP_ADAPTER_HOME），必须能看见别的进程写入的新内容。
 *
 * 已知边界：理论上如果文件系统 mtime 精度只有 1 秒，且外部进程恰好在这一秒内
 * 写出了**字节长度完全相同**的新内容，这里会多用一个旧快照，直到文件再次变化。
 * 现代文件系统（APFS / ext4）mtime 是纳秒级，实际不可达；且代价只是短暂使用
 * 略旧的工具目录，不影响正确性。本进程自身的写入会立刻让快照失效，是精确的。
 *
 * 另一个契约变化：命中快照时返回的是**同一个对象引用**，多个调用方共享它。
 * 调用方必须只读，不得修改返回值（当前所有调用点都只读）。
 */
let cacheSnapshot: {
  path: string;
  mtimeMs: number;
  size: number;
  cache: MetadataCache | null;
} | null = null;

export function loadMetadataCache(): MetadataCache | null {
  const cachePath = getCachePath();

  let stat: fs.Stats;
  try {
    stat = fs.statSync(cachePath);
  } catch {
    // 文件不存在或不可访问：视为无缓存，并且不能让旧快照继续生效
    cacheSnapshot = null;
    return null;
  }

  if (
    cacheSnapshot &&
    cacheSnapshot.path === cachePath &&
    cacheSnapshot.mtimeMs === stat.mtimeMs &&
    cacheSnapshot.size === stat.size
  ) {
    return cacheSnapshot.cache;
  }

  const cache = readCacheFromDisk(cachePath);
  cacheSnapshot = {
    path: cachePath,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    cache,
  };
  return cache;
}

/** 写盘之后必须调用，保证本进程下一次读取一定拿到最新内容 */
function invalidateCacheSnapshot(): void {
  cacheSnapshot = null;
}

/**
 * 原子、安全写缓存：使用 temp 文件 + fs.renameSync
 * 内部串行化写操作，防止并发刷新导致 lost update。
 */
let cacheWriteQueue: Promise<void> = Promise.resolve();

function doSaveMetadataCache(cache: MetadataCache): void {
  const cachePath = getCachePath();
  ensureDirs();

  const merged: MetadataCache = { version: CACHE_VERSION, servers: {} };
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
    } catch {}
    // 与 rename 之间没有 await，所以不存在"已落盘但仍读到旧快照"的窗口
    invalidateCacheSnapshot();
  } catch (err) {
    if (fs.existsSync(tmpPath)) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {}
    }
    throw new Error(
      `原子保存 cache.json 失败: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export function saveMetadataCache(cache: MetadataCache): Promise<void> {
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
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined || typeof value !== "object") {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? "undefined" : serialized;
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

// adapter 元数据字段——不影响底层 server 暴露什么工具，哈希计算时排除
// （includeTools/excludeTools 是 adapter 侧的可见性过滤，调整它不应触发重新发现）
const META_KEYS = new Set([
  "aliases",
  "lifecycle",
  "disabled",
  "idleTimeout",
  "refreshOnStartup",
  "connectTimeoutMs",
  "requestTimeoutMs",
  "closeTimeoutMs",
  "includeTools",
  "excludeTools",
]);

/**
 * 计算哈希指纹：遍历 ServerConfig 所有字段，仅排除 adapter 元数据。
 * 黑名单策略确保新增连接相关字段（如 type、caCert）自动纳入，无需手动维护白名单。
 */
export function computeServerHash(definition: ServerConfig): string {
  const identity: Record<string, unknown> = {};
  for (const key of Object.keys(definition) as (keyof ServerConfig)[]) {
    if (META_KEYS.has(key)) continue;
    identity[key] = definition[key];
  }
  const normalized = stableStringify(identity);
  return createHash("sha256").update(normalized).digest("hex");
}

function isValidCacheEntry(entry: unknown): entry is ServerCacheEntry {
  return (
    !!entry &&
    typeof entry === "object" &&
    typeof (entry as ServerCacheEntry).configHash === "string" &&
    typeof (entry as ServerCacheEntry).cachedAt === "number" &&
    Array.isArray((entry as ServerCacheEntry).tools)
  );
}

/**
 * 验证当前服务器缓存条目是否在 1.结构、2.指纹、3.生存期上完好有效
 */
export function isServerCacheValid(
  entry: ServerCacheEntry | undefined,
  definition: ServerConfig,
  maxAgeMs: number = CACHE_MAX_AGE_MS,
): boolean {
  if (!isValidCacheEntry(entry)) return false;
  if (entry.configHash !== computeServerHash(definition)) return false;
  if (maxAgeMs > 0 && Date.now() - entry.cachedAt > maxAgeMs) return false;
  return true;
}

/**
 * 从全量缓存中过滤出 configHash 有效、TTL 未过期、且未被 disabled 的 server 缓存条目。
 * 确保 search_tools / describe_tool / locateTool 只使用当前配置对应的有效缓存。
 * 同时按服务级的 includeTools/excludeTools 对工具列表做可见性过滤。
 */
export function getValidCachedServers(
  config: AdapterConfig,
  cache: MetadataCache | null,
): Record<string, ServerCacheEntry> {
  if (!cache?.servers) return {};

  const result: Record<string, ServerCacheEntry> = {};
  const ttlDays = config.settings?.cacheTtlDays ?? 7;
  const maxAgeMs = ttlDays * 24 * 60 * 60 * 1000;

  for (const [serverName, serverConfig] of Object.entries(config.mcpServers)) {
    if (serverConfig.disabled) continue;

    const entry = cache.servers[serverName];
    if (isServerCacheValid(entry, serverConfig, maxAgeMs)) {
      const tools = filterServerTools(entry.tools, serverConfig);
      result[serverName] = tools === entry.tools ? entry : { ...entry, tools };
    }
  }

  return result;
}

const GLOB_REGEXP_CACHE = new Map<string, RegExp>();

/** 支持通配符 * 和 ? 的简单 glob → RegExp；无通配符时即为精确匹配 */
export function toolPatternToRegExp(pattern: string): RegExp {
  const cached = GLOB_REGEXP_CACHE.get(pattern);
  if (cached) return cached;
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  const regexp = new RegExp(`^${source}$`);
  GLOB_REGEXP_CACHE.set(pattern, regexp);
  return regexp;
}

function matchesToolPattern(toolName: string, patterns: string[]): boolean {
  return patterns.some(
    (p) => p === toolName || toolPatternToRegExp(p).test(toolName),
  );
}

/**
 * 按服务的 includeTools/excludeTools 过滤工具列表（exclude 在 include 之后应用）。
 * 未配置任何过滤时原样返回同一数组引用。
 */
export function filterServerTools(
  tools: CachedTool[],
  cfg: Pick<ServerConfig, "includeTools" | "excludeTools">,
): CachedTool[] {
  const include = cfg.includeTools?.filter((p) => p.length > 0) ?? [];
  const exclude = cfg.excludeTools?.filter((p) => p.length > 0) ?? [];
  if (include.length === 0 && exclude.length === 0) return tools;

  return tools.filter((t) => {
    if (include.length > 0 && !matchesToolPattern(t.name, include))
      return false;
    if (exclude.length > 0 && matchesToolPattern(t.name, exclude)) return false;
    return true;
  });
}
