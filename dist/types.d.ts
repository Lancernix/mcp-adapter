export type LifecycleMode = "lazy" | "eager" | "keep-alive";
export interface ServerConfig {
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
    url?: string;
    headers?: Record<string, string>;
    aliases?: string[];
    lifecycle?: LifecycleMode;
    idleTimeout?: number;
    disabled?: boolean;
}
export interface GlobalSettings {
    idleTimeout?: number;
    cacheTtlDays?: number;
    toolSearchLimit?: number;
    enableFuseSearch?: boolean;
}
export interface AdapterConfig {
    version: number;
    settings?: GlobalSettings;
    mcpServers: Record<string, ServerConfig>;
}
export interface McpTool {
    name: string;
    description?: string;
    inputSchema?: any;
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
