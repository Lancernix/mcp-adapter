export type LifecycleMode = "lazy" | "eager" | "keep-alive";
export interface ServerConfig {
    type?: "stdio" | "http" | "sse";
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
    refreshOnStartup?: boolean;
    connectTimeoutMs?: number;
    requestTimeoutMs?: number;
    closeTimeoutMs?: number;
}
export interface GlobalSettings {
    idleTimeout?: number;
    cacheTtlDays?: number;
    toolSearchLimit?: number;
    metadataBootstrap?: "background" | "off";
    debug?: boolean;
    connectTimeoutMs?: number;
    requestTimeoutMs?: number;
    closeTimeoutMs?: number;
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
    errors: Array<{
        server: string;
        message: string;
    }>;
}
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
