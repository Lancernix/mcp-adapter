// lifecycle.ts - Idle connection timeout sweeper

import { writeLog } from "./logger.js";
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
      void this.sweepNow();
    }, intervalMs);

    // 允许 Node 进程在只有 sweeper 活跃时正常退出，不强制常驻挂起
    this.timer.unref();
    writeLog(
      `[Lifecycle] 闲置连接扫描器已挂载并启动。(轮询周期: ${intervalMs / 1000} 秒)\n`,
    );
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

  /**
   * 预热 eager 服务：启动时主动建连，避免首次调用承担冷启动延迟。
   * eager 连接不会被 sweeper 回收（见 sweepNow 的 mode 判断），因此可以放心预热；
   * 失败只记日志、不阻塞启动，也不写入失败冷却。
   *
   * 返回预热成功的 server 列表（便于测试断言）。
   */
  async warmupEagerServers(): Promise<string[]> {
    const servers = this.config.mcpServers ?? {};
    const eager = Object.entries(servers).filter(
      ([, cfg]) => !cfg.disabled && (cfg.lifecycle ?? "lazy") === "eager",
    );

    if (eager.length === 0) return [];

    writeLog(`[Lifecycle] 正在预热 ${eager.length} 个 eager 服务...\n`);

    const settleAll = await Promise.allSettled(
      eager.map(([name, cfg]) =>
        this.serverManager.connect(name, cfg, {
          connectTimeoutMs:
            cfg.connectTimeoutMs ?? this.config.settings?.connectTimeoutMs,
          closeTimeoutMs:
            cfg.closeTimeoutMs ?? this.config.settings?.closeTimeoutMs,
          failureBackoffMs: this.config.settings?.failureBackoffMs,
          // 预热失败属于启动期瞬时失败，不应污染前台冷却窗口
          recordFailureBackoff: false,
        }),
      ),
    );

    const warmed: string[] = [];

    settleAll.forEach((result, index) => {
      const name = eager[index][0];
      if (result.status === "fulfilled") {
        warmed.push(name);
        writeLog(`[Lifecycle] ✓ eager 服务 [${name}] 预热完成\n`);
      } else {
        const message =
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason);
        writeLog(
          `[Lifecycle-Warning] eager 服务 [${name}] 预热失败: ${message}\n`,
        );
      }
    });

    return warmed;
  }

  /**
   * 执行一轮闲置回收。定时器与测试共用同一入口。
   */
  async sweepNow(): Promise<void> {
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

        // <=0 表示显式禁用闲置回收。必须在这里短路：否则 timeoutMs 会变成 0，
        // `Date.now() - lastUsedAt > 0` 恒真，等于每轮扫描都把连接杀一遍。
        if (timeoutMinutes <= 0) continue;

        const timeoutMs = timeoutMinutes * 60 * 1000;

        // 如果该 server 已经在闲置中，则平滑杀死释放内存
        if (this.serverManager.isIdle(serverName, timeoutMs)) {
          writeLog(
            `[Lifecycle] 检查发现真实 MCP 服务 [${serverName}] 已闲置超过 ${timeoutMinutes} 分钟。正在执行自动降温释放...\n`,
          );
          const closeTimeoutMs =
            srvConfig.closeTimeoutMs ??
            this.config.settings?.closeTimeoutMs ??
            10000;

          await this.serverManager
            .close(serverName, closeTimeoutMs)
            .catch((err) => {
              writeLog(
                `[Lifecycle-Error] 平滑销毁 [${serverName}] 失败: ${err.message}\n`,
              );
            });
        }
      }
    } finally {
      this.isSweeping = false;
    }
  }
}
