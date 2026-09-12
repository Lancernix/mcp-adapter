// server-manager.ts - Standard MCP client and process lifetime controller
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  computeServerHash,
  isServerCacheValid,
  loadMetadataCache,
  saveMetadataCache,
} from "./cache-manager.js";
import { buildChildEnv, resolveCwd } from "./config-manager.js";
import { FailureBackoff } from "./failure-backoff.js";
import { writeLog } from "./logger.js";
import { TimeoutError, withTimeout } from "./timeout.js";
import type { ConnectOptions, ServerConfig } from "./types.js";
import { GATEWAY_VERSION } from "./version.js";

export const DEFAULT_CLOSE_TIMEOUT_MS = 10000;

/**
 * **进程退出路径**上物理关闭子进程的最小超时预算。
 *
 * SDK 的 StdioClientTransport.close() 是一条升级链：
 * stdin.end() → 等 2s → SIGTERM → 等 2s → SIGKILL，最坏约 4s 才会真正杀死子进程。
 * withTimeout 不会取消底层 promise，所以在进程存活期间放弃等待是安全的——
 * SDK 的升级链会在后台继续走完。但退出路径不一样：shutdownAll 之后紧接着
 * process.exit，一旦提前放弃，SIGKILL 就永远发不出去，子进程变成孤儿。
 *
 * 因此只在 shutdownAll 应用这个下限，常规关闭路径仍尊重用户配置的 closeTimeoutMs，
 * 避免"底层 server 卡死导致超时"时还要额外阻塞数秒才把错误返回给模型。
 */
export const MIN_CLOSE_TIMEOUT_MS = 6000;

export interface ServerConnection {
  /** 所属 server key，便于按身份定位与日志 */
  name: string;
  client: Client;
  transport: Transport;
  status: "connected" | "connecting" | "closing" | "closed";
  lastUsedAt: number;
  inFlight: number;
  /** 已标记退役：不再被复用，等待在途请求排空后物理关闭 */
  retiring: boolean;
}

export interface ConnectResult {
  conn: ServerConnection;
  createdByThisCall: boolean;
  reusedExisting: boolean;
  reusedPending: boolean;
}

/**
 * 组装 HTTP/SSE 请求头：显式 headers 优先；配置了 bearerTokenEnv 且未显式
 * 声明 Authorization 时，从环境变量读取 token 注入 Bearer 头，
 * 避免明文 token 写入 config.json。
 */
export function resolveHttpHeaders(
  name: string,
  config: ServerConfig,
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const headers: Record<string, string> = { ...(config.headers ?? {}) };
  const hasAuthHeader = Object.keys(headers).some(
    (key) => key.toLowerCase() === "authorization",
  );
  if (config.bearerTokenEnv && !hasAuthHeader) {
    const token = env[config.bearerTokenEnv];
    if (!token) {
      throw new Error(
        `[ServerManager] 服务 [${name}] 配置了 bearerTokenEnv("${config.bearerTokenEnv}")，` +
          `但当前环境变量未设置或为空`,
      );
    }
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

export class McpServerManager {
  private connections = new Map<string, ServerConnection>();
  private connectPromises = new Map<string, Promise<ServerConnection>>();
  private metadataRefreshPromises = new Map<string, Promise<boolean>>();
  private closePromises = new Map<string, Promise<void>>();
  private pendingResources = new Map<
    string,
    { client: Client; transport: Transport }
  >();
  /**
   * 已退役但仍持有引用计数的连接。它们不在 connections 中，因此不会被复用、
   * 也不会被 sweeper 重复计数；最后一个使用者 release 时物理关闭，
   * shutdownAll 时兜底回收，避免成为孤儿进程。
   */
  private retired = new Set<ServerConnection>();
  private shuttingDown = false;
  private failureBackoff = new FailureBackoff();

  /**
   * 建立对指定子进程的惰性 MCP 连接 (JIT Cold Start)
   */
  async connect(
    name: string,
    config: ServerConfig,
    options?: ConnectOptions,
  ): Promise<ServerConnection> {
    const result = await this.connectWithMeta(name, config, options);
    return result.conn;
  }

  /**
   * 建立连接并返回来源信息，区分新建/复用已有/复用 pending。
   *
   * 注意：本方法只负责让连接"可用"，不代持引用计数。真正要发起请求的调用方
   * 必须在拿到 conn 后立刻 retain()，并在结束时 release()，否则 sweeper 与
   * 退役关闭无法感知在途请求。
   */
  async connectWithMeta(
    name: string,
    config: ServerConfig,
    options?: ConnectOptions,
  ): Promise<ConnectResult> {
    if (this.shuttingDown) {
      throw new Error(`[ServerManager] 正在关闭，拒绝为 [${name}] 新建连接`);
    }

    // 1. 如果正在关闭该 server，等待关闭完成后再决定是否新建
    const closing = this.closePromises.get(name);
    if (closing) {
      await closing.catch(() => {});
    }

    // 2. 并发去重，如果已有连接 Promise，直接复用
    const pending = this.connectPromises.get(name);
    if (pending) {
      const conn = await pending;
      conn.lastUsedAt = Date.now();
      return {
        conn,
        createdByThisCall: false,
        reusedExisting: false,
        reusedPending: true,
      };
    }

    // 3. 如果已经连接成功，且未退役，直接返回
    const existing = this.connections.get(name);
    if (existing && existing.status === "connected" && !existing.retiring) {
      existing.lastUsedAt = Date.now();
      return {
        conn: existing,
        createdByThisCall: false,
        reusedExisting: true,
        reusedPending: false,
      };
    }

    // 4. 失败冷却检查：最近一次连接失败且仍在冷却窗口内时快速失败，
    //    避免每次调用都重新付出完整的连接超时等待（已连接/在建连的情况不受影响）
    const backoffMs = options?.failureBackoffMs ?? 60000;
    const backoffRemaining = this.failureBackoff.remainingMs(name, backoffMs);
    if (backoffRemaining !== null) {
      throw new Error(
        `[ServerManager] 服务 [${name}] 最近一次连接失败，正在冷却（剩余 ${Math.ceil(backoffRemaining / 1000)}s）。` +
          `可稍后重试；若确认已修复，可将 settings.failureBackoffMs 设为 0 关闭冷却后重试`,
      );
    }

    const promise = this.createConnection(name, config, options);
    this.connectPromises.set(name, promise);

    try {
      const conn = await promise;
      this.connections.set(name, conn);
      return {
        conn,
        createdByThisCall: true,
        reusedExisting: false,
        reusedPending: false,
      };
    } finally {
      this.connectPromises.delete(name);
    }
  }

  private async createConnection(
    name: string,
    config: ServerConfig,
    options?: ConnectOptions,
  ): Promise<ServerConnection> {
    const transport = this.buildTransport(name, config);

    const client = new Client(
      {
        name: `mcp-adapter-client-for-${name}`,
        version: GATEWAY_VERSION,
      },
      {
        capabilities: {},
      },
    );

    // 子进程崩溃 / 异常退出时，SDK 通过 transport.onclose → Protocol._onclose
    // → client.onclose 冒泡出来。必须在这里主动把死连接摘出连接池，否则下一次
    // 调用会复用一条 _transport 已为 undefined 的连接，直接报 "Not connected"；
    // 而 FailureBackoff 只记录建连失败，于是每次调用都撞同一具尸体，
    // 只能等 sweeper 按 idleTimeout（默认 10 分钟）兜底。
    //
    // 注意：SDK 明确说明 onclose 在主动调用 client.close() 时同样会触发，
    // 因此必须按 client 身份比对，避免误删刚重建的新连接。
    client.onclose = () => {
      this.handleConnectionClosed(name, client);
    };
    client.onerror = (error: Error) => {
      writeLog(
        `[ServerManager] 服务 [${name}] 底层通信错误: ${error.message}\n`,
      );
    };

    this.pendingResources.set(name, { client, transport });

    const connectTimeoutMs =
      config.connectTimeoutMs ?? options?.connectTimeoutMs ?? 60000;

    try {
      await withTimeout(
        client.connect(transport),
        connectTimeoutMs,
        `连接底层真实 MCP 服务 [${name}] 超时，超过 ${connectTimeoutMs}ms`,
      );

      this.pendingResources.delete(name);

      this.failureBackoff.clear(name);

      return {
        name,
        client,
        transport,
        status: "connected",
        lastUsedAt: Date.now(),
        inFlight: 0,
        retiring: false,
      };
    } catch (err) {
      this.pendingResources.delete(name);
      if (options?.recordFailureBackoff !== false) {
        this.failureBackoff.recordFailure(name);
      }

      // 捕获异常，彻底释放句柄并关闭进程，防止泄漏僵尸
      const cleanupTimeoutMs =
        config.closeTimeoutMs ??
        options?.closeTimeoutMs ??
        DEFAULT_CLOSE_TIMEOUT_MS;

      await withTimeout(
        client.close().catch(() => {}),
        cleanupTimeoutMs,
        `连接失败后关闭 client [${name}] 超时`,
      ).catch(() => {});

      await withTimeout(
        transport.close().catch(() => {}),
        cleanupTimeoutMs,
        `连接失败后关闭 transport [${name}] 超时`,
      ).catch(() => {});

      throw new Error(
        `连接底层真实 MCP 服务 [${name}] 失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * 底层连接断开（子进程崩溃 / 管道断开）时的收口：
   * 按 client 身份把连接从"连接池"或"退役集合"中摘除，让下一次请求重建。
   */
  private handleConnectionClosed(name: string, client: Client): void {
    const current = this.connections.get(name);
    if (current && current.client === client) {
      current.status = "closed";
      this.connections.delete(name);
      writeLog(
        `[ServerManager] 服务 [${name}] 的底层连接已断开，已从连接池摘除（下次调用将重新冷启动）\n`,
      );
      return;
    }

    for (const conn of this.retired) {
      if (conn.client === client) {
        conn.status = "closed";
        this.retired.delete(conn);
        return;
      }
    }
  }

  /**
   * 根据 config.type 选择对应的 MCP 传输实现
   */
  private buildTransport(name: string, config: ServerConfig): Transport {
    if (config.type === "http" || config.type === "sse") {
      if (!config.url) {
        throw new Error(
          `[ServerManager] 服务 [${name}] 使用 HTTP/SSE 传输但未配置 url`,
        );
      }
      const TransportClass =
        config.type === "sse"
          ? SSEClientTransport
          : StreamableHTTPClientTransport;

      return new TransportClass(new URL(config.url), {
        requestInit: {
          headers: resolveHttpHeaders(name, config),
        },
      });
    }

    // 默认 stdio
    if (!config.command) {
      throw new Error(
        `[ServerManager] 服务 [${name}] 的配置中缺失 command 属性`,
      );
    }

    writeLog(
      `[ServerManager] 正在惰性唤醒真实的子进程 [${name}]: ${config.command} (${config.args?.length ?? 0} args)\n`,
    );

    const args = Array.isArray(config.args) ? config.args : [];
    const env =
      config.env && typeof config.env === "object" && !Array.isArray(config.env)
        ? config.env
        : undefined;

    return new StdioClientTransport({
      command: config.command,
      args,
      env: buildChildEnv(env, config.inheritEnv !== false),
      cwd: resolveCwd(config.cwd),
    });
  }

  /**
   * 占用一次引用：调用方拿到 conn 后立刻调用，表示"这条连接正在被我使用"。
   * inFlight > 0 时连接不会被 sweeper 回收，也不会在退役后被物理关闭。
   */
  retain(conn: ServerConnection): void {
    conn.inFlight++;
    conn.lastUsedAt = Date.now();
  }

  /**
   * 释放一次引用。若该连接已退役且引用归零，则在此刻物理关闭，
   * 让"不再复用坏连接"与"不误杀在途请求"两个目标同时成立。
   */
  async release(
    conn: ServerConnection,
    closeTimeoutMs: number = DEFAULT_CLOSE_TIMEOUT_MS,
  ): Promise<void> {
    conn.inFlight = Math.max(0, conn.inFlight - 1);
    conn.lastUsedAt = Date.now();

    if (!conn.retiring || conn.inFlight > 0) return;

    this.retired.delete(conn);
    await this.closeConnection(conn, closeTimeoutMs, `${conn.name}（已退役）`);
  }

  /**
   * 标记连接退役：立即从连接池摘除（后续请求会重建新连接），
   * 但不在途请求结束前不做物理关闭 —— 直接 force close 会让 SDK 把所有
   * pending 请求以 Connection closed 一并 reject，误杀无关的并发调用。
   */
  retire(name: string, conn?: ServerConnection): void {
    const target = conn ?? this.connections.get(name);
    if (!target || target.retiring) return;

    target.retiring = true;
    target.status = "closing";

    if (this.connections.get(name) === target) {
      this.connections.delete(name);
    }
    this.retired.add(target);

    writeLog(
      `[ServerManager] 服务 [${name}] 的连接已标记退役，不再复用（在途 ${target.inFlight} 个请求将在结束后关闭）\n`,
    );
  }

  /**
   * 检查该服务是否处于闲置状态，允许 kill。
   * now 由调用方注入以便测试，真实路径使用 Date.now()。
   */
  isIdle(
    name: string,
    idleTimeoutMs: number,
    now: number = Date.now(),
  ): boolean {
    const conn = this.connections.get(name);
    if (!conn || conn.status !== "connected") return false;
    if (conn.inFlight > 0) return false; // 在途请求保护
    return now - conn.lastUsedAt > idleTimeoutMs;
  }

  /**
   * 优雅关闭真实连接和物理子进程。
   * 对同一 server 的并发 close 调用会去重，复用同一个 promise；
   * 但 force=true 的调用不参与去重 —— 否则"因 inFlight>0 被跳过"的普通关闭
   * 会吞掉紧随其后的强制关闭请求。
   */
  async close(
    name: string,
    closeTimeoutMs: number = DEFAULT_CLOSE_TIMEOUT_MS,
    force: boolean = false,
  ): Promise<void> {
    if (!force) {
      const existingClose = this.closePromises.get(name);
      if (existingClose) return existingClose;
    }

    const promise = this.doClose(name, closeTimeoutMs, force);
    this.closePromises.set(name, promise);

    try {
      await promise;
    } finally {
      if (this.closePromises.get(name) === promise) {
        this.closePromises.delete(name);
      }
    }
  }

  private async doClose(
    name: string,
    closeTimeoutMs: number,
    force: boolean,
  ): Promise<void> {
    const conn = this.connections.get(name);
    if (!conn) return;

    if (conn.inFlight > 0 && !force) {
      writeLog(
        `[ServerManager] 跳过关闭 [${name}]，当前仍有 ${conn.inFlight} 个请求执行中。\n`,
      );
      return;
    }

    // 先从池中摘除，避免关闭过程中被新请求复用
    this.connections.delete(name);

    await this.closeConnection(conn, closeTimeoutMs, name);
  }

  /**
   * 物理关闭一条具体连接。按对象身份操作，因此在连接池被同名新连接覆盖后
   * 依然能正确关闭旧连接（这是 release() 路径能安全工作的前提）。
   *
   * closeTimeoutMs 直接生效——常规路径下即便提前放弃等待，SDK 的
   * SIGTERM→SIGKILL 升级链也会在后台继续跑完，不会留下孤儿。
   * 只有退出路径需要保底预算，由 shutdownAll 负责抬高。
   */
  private async closeConnection(
    conn: ServerConnection,
    closeTimeoutMs: number,
    label: string,
  ): Promise<void> {
    if (conn.status === "closed") return;

    conn.status = "closed";
    this.retired.delete(conn);

    writeLog(`[ServerManager] 正在优雅销毁 [${label}] 的 MCP 连接...\n`);

    await withTimeout(
      conn.client.close().catch(() => {}),
      closeTimeoutMs,
      `关闭 MCP client [${label}] 超时`,
    ).catch(() => {});

    await withTimeout(
      conn.transport.close().catch(() => {}),
      closeTimeoutMs,
      `关闭 MCP transport [${label}] 超时`,
    ).catch(() => {});
  }

  /**
   * 销毁全量底层物理子进程（仅在进程退出时由死亡守卫强力调用）。
   * 调用后 ServerManager 永久拒绝新建连接，不可恢复。
   *
   * 顺序不可调换：
   *   ①熔断新建 → ②清半连接 pendingResources → ③等在途建连 settle
   *   → ④回收已退役连接 → ⑤关闭稳定连接池
   */
  async shutdownAll(
    closeTimeoutMs: number = DEFAULT_CLOSE_TIMEOUT_MS,
    force: boolean = true,
  ): Promise<void> {
    this.shuttingDown = true;

    // 进程马上要 exit(0)：物理关闭必须保底预算，否则 withTimeout 会在 SDK
    // 发出 SIGKILL 之前放弃，而随后进程就消失了，子进程只能靠 stdin EOF 自救
    const budgetMs = Math.max(closeTimeoutMs, MIN_CLOSE_TIMEOUT_MS);

    // ① 清理正在建连中但尚未完成的资源（防止僵尸进程泄漏）
    for (const [name, res] of Array.from(this.pendingResources.entries())) {
      this.pendingResources.delete(name);
      await withTimeout(
        res.client.close().catch(() => {}),
        budgetMs,
        `关闭 pending MCP client [${name}] 超时`,
      ).catch(() => {});
      await withTimeout(
        res.transport.close().catch(() => {}),
        budgetMs,
        `关闭 pending MCP transport [${name}] 超时`,
      ).catch(() => {});
    }

    // ② 等待所有尚未 settle 的 connect promise，防止后续插入新连接
    const pendingConnects = Array.from(this.connectPromises.entries());
    for (const [name, promise] of pendingConnects) {
      await withTimeout(
        promise.catch(() => undefined),
        budgetMs,
        `等待 pending connect [${name}] 结束超时`,
      ).catch(() => {});
    }

    // ③ 回收已退役、仍在等待在途请求排空的连接（退出时强制收口）
    for (const conn of Array.from(this.retired)) {
      this.retired.delete(conn);
      await this.closeConnection(conn, budgetMs, `${conn.name}（已退役）`);
    }

    // ④ 关闭稳定连接池
    for (const key of Array.from(this.connections.keys())) {
      await this.close(key, budgetMs, force).catch(() => {});
    }
  }

  isConnected(name: string): boolean {
    const conn = this.connections.get(name);
    return !!conn && conn.status === "connected";
  }

  /** 仅用于测试与诊断：当前连接池与退役集合的快照 */
  inspect(name: string): {
    connected: boolean;
    inFlight: number;
    retiring: boolean;
    retiredCount: number;
  } {
    const conn = this.connections.get(name);
    return {
      connected: !!conn && conn.status === "connected",
      inFlight: conn?.inFlight ?? 0,
      retiring: conn?.retiring ?? false,
      retiredCount: this.retired.size,
    };
  }

  /**
   * 刷新指定服务的 metadata 缓存。
   * 默认仅在缓存失效时刷新；forceRefresh=true 时跳过缓存有效性检查并强制刷新。
   * 若 closeIfCreated 为 true 且连接是本次新建的，刷新后自动关闭；否则连接保留。
   * 返回 true 表示执行了刷新，false 表示缓存有效无需刷新。
   *
   * 同一 server 的并发 refresh 采用 first caller wins 语义。
   * 后续调用复用首个 promise，不会重新应用自己的 options。
   */
  async refreshMetadataIfNeeded(
    name: string,
    config: ServerConfig,
    options?: {
      cacheTtlDays?: number;
      requestTimeoutMs?: number;
      connectTimeoutMs?: number;
      closeTimeoutMs?: number;
      failureBackoffMs?: number;
      recordFailureBackoff?: boolean;
      closeIfCreated?: boolean;
      forceRefresh?: boolean;
    },
  ): Promise<boolean> {
    const pending = this.metadataRefreshPromises.get(name);
    if (pending) return pending;

    const promise = this.doRefreshMetadataIfNeeded(name, config, options);
    this.metadataRefreshPromises.set(name, promise);

    try {
      return await promise;
    } finally {
      this.metadataRefreshPromises.delete(name);
    }
  }

  /**
   * 执行实际 metadata 刷新：检查缓存 → 连接 → listTools → 写缓存。
   * 不设去重逻辑，由外层 refreshMetadataIfNeeded 保证串行化。
   */
  private async doRefreshMetadataIfNeeded(
    name: string,
    config: ServerConfig,
    options?: {
      cacheTtlDays?: number;
      requestTimeoutMs?: number;
      connectTimeoutMs?: number;
      closeTimeoutMs?: number;
      failureBackoffMs?: number;
      recordFailureBackoff?: boolean;
      closeIfCreated?: boolean;
      forceRefresh?: boolean;
    },
  ): Promise<boolean> {
    const cache = loadMetadataCache();
    const cachedEntry = cache?.servers?.[name];
    const maxAgeMs = (options?.cacheTtlDays ?? 7) * 24 * 60 * 60 * 1000;

    if (
      !options?.forceRefresh &&
      isServerCacheValid(cachedEntry, config, maxAgeMs)
    ) {
      writeLog(`[Metadata] [${name}] 缓存有效，跳过刷新\n`);
      return false;
    }

    const result = await this.connectWithMeta(name, config, {
      connectTimeoutMs: options?.connectTimeoutMs,
      closeTimeoutMs: options?.closeTimeoutMs,
      failureBackoffMs: options?.failureBackoffMs,
      recordFailureBackoff: options?.recordFailureBackoff,
    });

    const conn = result.conn;
    const requestTimeoutMs =
      config.requestTimeoutMs ?? options?.requestTimeoutMs ?? 60000;
    const closeTimeoutMs =
      config.closeTimeoutMs ??
      options?.closeTimeoutMs ??
      DEFAULT_CLOSE_TIMEOUT_MS;

    // 先建立引用，再进入 try，保证 retain 与 finally 的 release 严格配对
    this.retain(conn);

    let shouldDropConnection = false;

    try {
      const response = await withTimeout(
        conn.client.listTools(),
        requestTimeoutMs,
        `获取 [${name}] 工具列表超时，超过 ${requestTimeoutMs}ms`,
      );

      const tools = response.tools || [];

      await saveMetadataCache({
        version: 1,
        servers: {
          [name]: {
            configHash: computeServerHash(config),
            cachedAt: Date.now(),
            tools: tools.map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
            })),
          },
        },
      });

      return true;
    } catch (err) {
      if (err instanceof TimeoutError) {
        shouldDropConnection = true;
      }
      throw err;
    } finally {
      if (shouldDropConnection) {
        // 超时说明这条连接可能已经坏了：标记退役而不是立刻掐断，
        // 让同 server 上其他在途请求先跑完
        this.retire(name, conn);
      }

      await this.release(conn, closeTimeoutMs);

      if (
        !shouldDropConnection &&
        options?.closeIfCreated &&
        result.createdByThisCall
      ) {
        this.scheduleCloseIfUnused(name, conn, closeTimeoutMs);
      }
    }
  }

  /**
   * 延迟一个宏任务再判断"这条连接是否真的没人要了"。
   *
   * 直接同步 close 会与"刚复用该连接、但还没来得及 retain 的调用方"竞态：
   * retain 发生在 await 之后，中间存在微任务窗口，doClose 会看到 inFlight === 0
   * 而把连接关掉。推迟到宏任务时，所有已排队的微任务续体都已执行完毕，
   * inFlight 的状态才是可信的。
   */
  private scheduleCloseIfUnused(
    name: string,
    conn: ServerConnection,
    closeTimeoutMs: number,
  ): void {
    const timer = setTimeout(() => {
      void this.closeIfUnused(name, conn, closeTimeoutMs);
    }, 0);
    timer.unref?.();
  }

  private async closeIfUnused(
    name: string,
    conn: ServerConnection,
    closeTimeoutMs: number,
  ): Promise<void> {
    // 按对象身份比对：延迟到宏任务之后，连接池里可能已经换成另一条新连接，
    // 用 name 查表会误关别人的连接
    if (this.connections.get(name) !== conn) return;
    if (conn.status !== "connected") return;
    if (conn.inFlight > 0) {
      writeLog(
        `[Metadata] [${name}] 刷新后连接已被复用（在途 ${conn.inFlight}），保留连接\n`,
      );
      return;
    }
    await this.close(name, closeTimeoutMs).catch(() => {});
  }
}
