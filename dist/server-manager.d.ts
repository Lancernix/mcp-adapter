import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ServerConfig } from "./types.js";
export interface ServerConnection {
    client: Client;
    transport: StdioClientTransport;
    status: "connected" | "closed" | "connecting";
    lastUsedAt: number;
    inFlight: number;
}
export declare class McpServerManager {
    private connections;
    private connectPromises;
    /**
     * 建立对指定子进程的惰性 MCP 连接 (JIT Cold Start)
     */
    connect(name: string, config: ServerConfig): Promise<ServerConnection>;
    private createConnection;
    /**
     * 检查该服务是否处于闲置状态，允许 kill
     */
    isIdle(name: string, idleTimeoutMs: number): boolean;
    /**
     * 优雅关闭真实连接和物理子进程
     */
    close(name: string): Promise<void>;
    /**
     * 销毁全量底层物理子进程 (在父进程即将关停、退出时被死亡守卫强力调用)
     */
    closeAll(): Promise<void>;
    getConnectionState(name: string): ServerConnection | undefined;
}
