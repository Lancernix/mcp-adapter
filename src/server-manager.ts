// server-manager.ts - Standard MCP client and process lifetime controller
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ServerConfig, McpTool } from "./types.js";
import { computeServerHash, saveMetadataCache } from "./cache-manager.js";

export interface ServerConnection {
  client: Client;
  transport: StdioClientTransport;
  status: "connected" | "closed" | "connecting";
  lastUsedAt: number;
  inFlight: number;
}

export class McpServerManager {
  private connections = new Map<string, ServerConnection>();
  private connectPromises = new Map<string, Promise<ServerConnection>>();

  /**
   * 建立对指定子进程的惰性 MCP 连接 (JIT Cold Start)
   */
  async connect(name: string, config: ServerConfig): Promise<ServerConnection> {
    // 1. 并发去重，如果已有连接 Promise，直接复用
    if (this.connectPromises.has(name)) {
      return this.connectPromises.get(name)!;
    }

    // 2. 如果已经连接成功，且进程正常，直接返回
    const existing = this.connections.get(name);
    if (existing && existing.status === "connected") {
      existing.lastUsedAt = Date.now();
      return existing;
    }

    const promise = this.createConnection(name, config);
    this.connectPromises.set(name, promise);

    try {
      const conn = await promise;
      this.connections.set(name, conn);
      return conn;
    } finally {
      this.connectPromises.delete(name);
    }
  }

  private async createConnection(name: string, config: ServerConfig): Promise<ServerConnection> {
    if (!config.command) {
      throw new Error(`[ServerManager] 服务 [${name}] 的配置中缺失 command 属性`);
    }

    const command = config.command;
    const args = config.args || [];
    const env = {
      ...process.env,
      ...(config.env || {})
    } as Record<string, string>;
    
    // 如果没有显式配置 cwd，则默认使用当前 adapter 运行时的 cwd
    const cwd = config.cwd || process.cwd();

    process.stderr.write(`[ServerManager] 正在惰性唤醒真实的子进程 [${name}]: ${command} ${args.join(" ")}\n`);

    const transport = new StdioClientTransport({
      command,
      args,
      env,
      cwd
    });

    const client = new Client({
      name: `mcp-adapter-client-for-${name}`,
      version: "1.0.0"
    }, {
      capabilities: {}
    });

    try {
      // 1. 建立管道
      await client.connect(transport);

      // 2. 发起标准的 MCP initialize 握手
      // 注：根据官方规范，连接建立后，SDK 会自动协商协议并完成 initialized 阶段
      
      // 3. 抓取最新的 tools 列表并顺带更新 cache.json (自愈更新)
      let tools: McpTool[] = [];
      try {
        const response = await client.listTools();
        tools = response.tools || [];
        
        // 自动提取最新的 Schema 并持久化到 Cache 中
        const currentHash = computeServerHash(config);
        saveMetadataCache({
          version: 1,
          servers: {
            [name]: {
              configHash: currentHash,
              cachedAt: Date.now(),
              tools: tools.map(t => ({
                name: t.name,
                description: t.description,
                inputSchema: t.inputSchema
              }))
            }
          }
        });
      } catch (err: any) {
        process.stderr.write(`[ServerManager-Warning] 抓取 [${name}] 工具定义失败，继续保持旧缓存运行: ${err.message}\n`);
      }

      return {
        client,
        transport,
        status: "connected",
        lastUsedAt: Date.now(),
        inFlight: 0
      };
    } catch (err: any) {
      // 捕获异常，彻底释放句柄并关闭进程，防止泄漏僵尸
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
      throw new Error(`连接底层真实 MCP 服务 [${name}] 失败: ${err.message}`);
    }
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
   * 优雅关闭真实连接和物理子进程
   */
  async close(name: string): Promise<void> {
    const conn = this.connections.get(name);
    if (!conn) return;

    process.stderr.write(`[ServerManager] 正在优雅销毁子进程 [${name}] 的 MCP 连接...\n`);
    conn.status = "closed";
    
    try {
      await conn.client.close();
    } catch {}
    try {
      await conn.transport.close();
    } catch {}

    this.connections.delete(name);
  }

  /**
   * 销毁全量底层物理子进程 (在父进程即将关停、退出时被死亡守卫强力调用)
   */
  async closeAll(): Promise<void> {
    const keys = Array.from(this.connections.keys());
    for (const key of keys) {
      await this.close(key).catch(() => {});
    }
  }

  getConnectionState(name: string): ServerConnection | undefined {
    return this.connections.get(name);
  }
}
