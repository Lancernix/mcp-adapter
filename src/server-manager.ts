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
import { writeLog } from "./logger.js";
import { TimeoutError, withTimeout } from "./timeout.js";
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

export class McpServerManager {
  private connections = new Map<string, ServerConnection>();
  private connectPromises = new Map<string, Promise<ServerConnection>>();
  private metadataRefreshPromises = new Map<string, Promise<boolean>>();
  private closePromises = new Map<string, Promise<void>>();
  private pendingResources = new Map<
    string,
    { client: Client; transport: Transport }
  >();
  private shuttingDown = false;

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

    // 3. 如果已经连接成功，且进程正常，直接返回
    const existing = this.connections.get(name);
    if (existing && existing.status === "connected") {
      existing.lastUsedAt = Date.now();
      return {
        conn: existing,
        createdByThisCall: false,
        reusedExisting: true,
        reusedPending: false,
      };
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
        version: "1.0.0",
      },
      {
        capabilities: {},
      },
    );

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

      return {
        client,
        transport,
        status: "connected",
        lastUsedAt: Date.now(),
        inFlight: 0,
      };
    } catch (err) {
      this.pendingResources.delete(name);

      // 捕获异常，彻底释放句柄并关闭进程，防止泄漏僵尸
      const cleanupTimeoutMs =
        config.closeTimeoutMs ?? options?.closeTimeoutMs ?? 10000;

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
          headers: config.headers ?? {},
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
      env: buildChildEnv(env),
      cwd: resolveCwd(config.cwd),
    });
  }

  /**
   * 检查该服务是否处于闲置状态，允许 kill
   */
  isIdle(name: string, idleTimeoutMs: number): boolean {
    const conn = this.connections.get(name);
    if (!conn || conn.status !== "connected") return false;
    if (conn.inFlight > 0) return false; // 在途请求保护
    return Date.now() - conn.lastUsedAt > idleTimeoutMs;
  }

  /**
   * 优雅关闭真实连接和物理子进程。
   * 对同一 server 的并发 close 调用会去重，复用同一个 promise。
   */
  async close(
    name: string,
    closeTimeoutMs: number = 10000,
    force: boolean = false,
  ): Promise<void> {
    const existingClose = this.closePromises.get(name);
    if (existingClose) return existingClose;

    const promise = this.doClose(name, closeTimeoutMs, force);
    this.closePromises.set(name, promise);

    try {
      await promise;
    } finally {
      this.closePromises.delete(name);
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

    writeLog(`[ServerManager] 正在优雅销毁子进程 [${name}] 的 MCP 连接...\n`);
    conn.status = "closed";

    await withTimeout(
      conn.client.close().catch(() => {}),
      closeTimeoutMs,
      `关闭 MCP client [${name}] 超时`,
    ).catch(() => {});

    await withTimeout(
      conn.transport.close().catch(() => {}),
      closeTimeoutMs,
      `关闭 MCP transport [${name}] 超时`,
    ).catch(() => {});

    this.connections.delete(name);
  }

  /**
   * 销毁全量底层物理子进程（仅在进程退出时由死亡守卫强力调用）。
   * 调用后 ServerManager 永久拒绝新建连接，不可恢复。
   */
  async shutdownAll(
    closeTimeoutMs: number = 10000,
    force: boolean = true,
  ): Promise<void> {
    this.shuttingDown = true;

    // 先清理正在建连中但尚未完成的资源（防止僵尸进程泄漏）
    for (const [name, res] of this.pendingResources.entries()) {
      await withTimeout(
        res.client.close().catch(() => {}),
        closeTimeoutMs,
        `关闭 pending MCP client [${name}] 超时`,
      ).catch(() => {});
      await withTimeout(
        res.transport.close().catch(() => {}),
        closeTimeoutMs,
        `关闭 pending MCP transport [${name}] 超时`,
      ).catch(() => {});
      this.pendingResources.delete(name);
    }

    // 等待所有尚未 settle 的 connect promise，防止后续插入新连接
    const pendingConnects = Array.from(this.connectPromises.entries());
    for (const [name, promise] of pendingConnects) {
      await withTimeout(
        promise.catch(() => undefined),
        closeTimeoutMs,
        `等待 pending connect [${name}] 结束超时`,
      ).catch(() => {});
    }

    const keys = Array.from(this.connections.keys());
    for (const key of keys) {
      await this.close(key, closeTimeoutMs, force).catch(() => {});
    }
  }

  isConnected(name: string): boolean {
    const conn = this.connections.get(name);
    return !!conn && conn.status === "connected";
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
    });

    const conn = result.conn;
    const requestTimeoutMs =
      config.requestTimeoutMs ?? options?.requestTimeoutMs ?? 60000;

    conn.inFlight++;
    conn.lastUsedAt = Date.now();

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
      conn.inFlight = Math.max(0, conn.inFlight - 1);
      conn.lastUsedAt = Date.now();

      if (shouldDropConnection) {
        await this.close(
          name,
          config.closeTimeoutMs ?? options?.closeTimeoutMs ?? 10000,
          true,
        ).catch(() => {});
      } else if (options?.closeIfCreated && result.createdByThisCall) {
        await this.close(
          name,
          config.closeTimeoutMs ?? options?.closeTimeoutMs ?? 10000,
        ).catch(() => {});
      }
    }
  }
}
