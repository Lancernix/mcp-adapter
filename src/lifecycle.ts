// lifecycle.ts - Idle connection timeout sweeper
import type { McpServerManager } from "./server-manager.js";
import type { AdapterConfig } from "./types.js";

export class McpLifecycleManager {
  private serverManager: McpServerManager;
  private config: AdapterConfig;
  private timer: NodeJS.Timeout | null = null;
  private isSweeping = false;

  constructor(serverManager: McpServerManager, config: AdapterConfig) {
    this.serverManager = serverManager;
    this.config = config;
  }

  /**
   * 启动闲置连接扫描器（Idle Timeout Sweeper）
   */
  startSweeper(intervalMs: number = 30000): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
    
    this.timer = setInterval(() => {
      this.sweepIdleConnections();
    }, intervalMs);
    
    // 允许 Node 进程在只有 sweeper 活跃时正常退出，不强制常驻挂起
    this.timer.unref();
    process.stderr.write(`[Lifecycle] 闲置连接扫描器已挂载并启动。(轮询周期: ${intervalMs / 1000} 秒)\n`);
  }

  /**
   * 停止扫描
   */
  stopSweeper(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async sweepIdleConnections(): Promise<void> {
    if (this.isSweeping) return;
    this.isSweeping = true;

    try {
      const servers = this.config.mcpServers || {};
      const globalIdleMinutes = this.config.settings?.idleTimeout ?? 10;

      for (const serverName of Object.keys(servers)) {
        const srvConfig = servers[serverName];
        
        // 只有 lazy 模式需要做超时杀进程
        const mode = srvConfig.lifecycle || "lazy";
        if (mode !== "lazy") continue;

        // 计算该 server 的具体超时限制（支持每台 server 单独重写，否则取全局默认）
        const timeoutMinutes = srvConfig.idleTimeout ?? globalIdleMinutes;
        const timeoutMs = timeoutMinutes * 60 * 1000;

        // 如果该 server 已经在闲置中，则平滑杀死释放内存
        if (this.serverManager.isIdle(serverName, timeoutMs)) {
          process.stderr.write(`[Lifecycle] 检查发现真实 MCP 服务 [${serverName}] 已闲置超过 ${timeoutMinutes} 分钟。正在执行自动降温释放...\n`);
          await this.serverManager.close(serverName).catch((err) => {
            process.stderr.write(`[Lifecycle-Error] 平滑销毁 [${serverName}] 失败: ${err.message}\n`);
          });
        }
      }
    } finally {
      this.isSweeping = false;
    }
  }
}
