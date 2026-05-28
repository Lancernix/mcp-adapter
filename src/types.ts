// types.ts - Core types for @lancernix/mcp-adapter

export type LifecycleMode = "lazy" | "eager" | "keep-alive";

export interface ServerConfig {
  type?: "stdio" | "http" | "sse"; // 连接方式，默认 stdio
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  aliases?: string[];
  lifecycle?: LifecycleMode;
  idleTimeout?: number; // 单位：分钟
  disabled?: boolean;
  refreshOnStartup?: boolean; // 启动时强制刷新缓存（适用于在线 server，工具可能随时变化）
  // 单服务超时覆盖（毫秒）
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  closeTimeoutMs?: number;
}

export interface GlobalSettings {
  idleTimeout?: number; // 默认：10 分钟
  cacheTtlDays?: number; // 默认：7 天
  toolSearchLimit?: number; // 默认：10 个，search_tools 单次最大 20
  metadataBootstrap?: "background" | "off"; // 默认：background
  debug?: boolean; // 默认：false，开启后写日志到 logs/mcp-adapter.log
  connectTimeoutMs?: number; // 默认：60000
  requestTimeoutMs?: number; // 默认：60000
  closeTimeoutMs?: number; // 默认：10000
}

export interface AdapterConfig {
  version: number;
  settings?: GlobalSettings;
  mcpServers: Record<string, ServerConfig>;
}

export interface ConnectOptions {
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  closeTimeoutMs?: number;
}

export interface BootstrapStatus {
  running: boolean;
  startedAt?: number;
  finishedAt?: number;
  total: number;
  completed: number;
  current?: string;
  errors: Array<{ server: string; message: string }>;
}

// JSON Schema 为递归嵌套结构，使用 Record<string, unknown> 表达任意 JSON 对象
export type JsonSchema = Record<string, unknown>;

export interface CachedTool {
  name: string;
  description?: string;
  inputSchema?: JsonSchema;
}

export interface ServerCacheEntry {
  configHash: string;
  cachedAt: number;
  tools: CachedTool[];
}

export interface MetadataCache {
  version: number;
  servers: Record<string, ServerCacheEntry>;
}

export interface ToolSearchDoc {
  server: string;
  serverAliases: string[];
  name: string;
  qualifiedName: string;
  description?: string;
  inputSchema?: JsonSchema;
}
