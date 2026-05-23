// types.ts - Core types for @lancernix/mcp-adapter

export type LifecycleMode = "lazy" | "eager" | "keep-alive";

export interface ServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string; // 留作未来拓展 HTTP/SSE
  headers?: Record<string, string>; // 留作未来拓展
  aliases?: string[];
  lifecycle?: LifecycleMode;
  idleTimeout?: number; // 单位：分钟
  disabled?: boolean;
}

export interface GlobalSettings {
  idleTimeout?: number;     // 默认：10 分钟
  cacheTtlDays?: number;    // 默认：7 天
  toolSearchLimit?: number; // 默认：10 个
  enableFuseSearch?: boolean; // 默认：true
}

export interface AdapterConfig {
  version: number;
  settings?: GlobalSettings;
  mcpServers: Record<string, ServerConfig>;
}

// MCP SDK 内置的工具结构声明
export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: any; // JSON Schema
}

export interface CachedTool {
  name: string;
  description?: string;
  inputSchema?: any;
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
  searchText: string;
}
