import type { McpServerManager } from "./server-manager.js";
import type { AdapterConfig } from "./types.js";
export declare class McpLifecycleManager {
    private serverManager;
    private config;
    private timer;
    private isSweeping;
    constructor(serverManager: McpServerManager, config: AdapterConfig);
    /**
     * 启动闲置连接扫描器（Idle Timeout Sweeper）
     */
    startSweeper(intervalMs?: number): void;
    /**
     * 停止扫描
     */
    stopSweeper(): void;
    private sweepIdleConnections;
}
