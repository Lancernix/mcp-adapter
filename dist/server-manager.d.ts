import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ConnectOptions, ServerConfig } from "./types.js";
export interface ServerConnection {
    client: Client;
    transport: Transport;
    status: "connected" | "closed" | "connecting";
    lastUsedAt: number;
    inFlight: number;
}
export interface ConnectResult {
    conn: ServerConnection;
    createdByThisCall: boolean;
    reusedExisting: boolean;
    reusedPending: boolean;
}
export declare class McpServerManager {
    private connections;
    private connectPromises;
    private metadataRefreshPromises;
    private closePromises;
    private pendingResources;
    private shuttingDown;
    /**
     * 建立对指定子进程的惰性 MCP 连接 (JIT Cold Start)
     */
    connect(name: string, config: ServerConfig, options?: ConnectOptions): Promise<ServerConnection>;
    /**
     * 建立连接并返回来源信息，区分新建/复用已有/复用 pending。
     */
    connectWithMeta(name: string, config: ServerConfig, options?: ConnectOptions): Promise<ConnectResult>;
    private createConnection;
    /**
     * 根据 config.type 选择对应的 MCP 传输实现
     */
    private buildTransport;
    /**
     * 检查该服务是否处于闲置状态，允许 kill
     */
    isIdle(name: string, idleTimeoutMs: number): boolean;
    /**
     * 优雅关闭真实连接和物理子进程。
     * 对同一 server 的并发 close 调用会去重，复用同一个 promise。
     */
    close(name: string, closeTimeoutMs?: number, force?: boolean): Promise<void>;
    private doClose;
    /**
     * 销毁全量底层物理子进程（仅在进程退出时由死亡守卫强力调用）。
     * 调用后 ServerManager 永久拒绝新建连接，不可恢复。
     */
    shutdownAll(closeTimeoutMs?: number, force?: boolean): Promise<void>;
    isConnected(name: string): boolean;
    /**
     * 刷新指定服务的 metadata 缓存。
     * 默认仅在缓存失效时刷新；forceRefresh=true 时跳过缓存有效性检查并强制刷新。
     * 若 closeIfCreated 为 true 且连接是本次新建的，刷新后自动关闭；否则连接保留。
     * 返回 true 表示执行了刷新，false 表示缓存有效无需刷新。
     *
     * 同一 server 的并发 refresh 采用 first caller wins 语义。
     * 后续调用复用首个 promise，不会重新应用自己的 options。
     */
    refreshMetadataIfNeeded(name: string, config: ServerConfig, options?: {
        cacheTtlDays?: number;
        requestTimeoutMs?: number;
        connectTimeoutMs?: number;
        closeTimeoutMs?: number;
        closeIfCreated?: boolean;
        forceRefresh?: boolean;
    }): Promise<boolean>;
    /**
     * 执行实际 metadata 刷新：检查缓存 → 连接 → listTools → 写缓存。
     * 不设去重逻辑，由外层 refreshMetadataIfNeeded 保证串行化。
     */
    private doRefreshMetadataIfNeeded;
}
