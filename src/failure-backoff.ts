// failure-backoff.ts - 连接失败后的冷却期控制
// 思路借鉴 nicobailon/pi-mcp-adapter 的 failure-backoff：服务连接失败后进入短暂冷却，
// 冷却期内拒绝立即重试，避免每次调用都重新付出完整的连接超时等待。

/**
 * 记录各 server 最近一次连接失败的时间戳，并在冷却窗口内提供快速失败判断。
 * 时间由调用方注入以便测试；真实路径使用 Date.now()。
 */
export class FailureBackoff {
  private failedAt = new Map<string, number>();

  recordFailure(name: string, now: number = Date.now()): void {
    this.failedAt.set(name, now);
  }

  clear(name: string): void {
    this.failedAt.delete(name);
  }

  /**
   * 若该 server 处于冷却窗口内，返回剩余毫秒数；否则返回 null。
   * windowMs <= 0 表示冷却机制关闭。
   */
  remainingMs(
    name: string,
    windowMs: number,
    now: number = Date.now(),
  ): number | null {
    if (windowMs <= 0) return null;
    const failedAt = this.failedAt.get(name);
    if (failedAt === undefined) return null;
    const elapsed = now - failedAt;
    if (elapsed < 0 || elapsed >= windowMs) return null;
    return windowMs - elapsed;
  }
}
