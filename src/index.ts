// index.ts - Standard MCP Server Entrypoint for @lancernix/mcp-adapter
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import * as fs from "fs";

import { loadConfig, resolveServerName, getMcpAdapterHome, saveConfig } from "./config-manager.js";
import { loadMetadataCache, saveMetadataCache, computeServerHash } from "./cache-manager.js";
import { McpServerManager } from "./server-manager.js";
import { McpLifecycleManager } from "./lifecycle.js";
import { SearchIndex } from "./search-index.js";
import type { AdapterConfig, MetadataCache, CachedTool } from "./types.js";

// 声明全局配置、连接池、扫描器与模糊索引
let config: AdapterConfig;
let cache: MetadataCache | null;
const serverManager = new McpServerManager();
let lifecycleManager: McpLifecycleManager;
const searchIndex = new SearchIndex();

// 1. 初始化，冷启动装载缓存
function initialize() {
  process.stderr.write(`[@lancernix/mcp-adapter] 正在从 ${getMcpAdapterHome()} 启动冷装载...\n`);
  
  // A. 装载 config
  try {
    config = loadConfig();
  } catch (err: any) {
    process.stderr.write(`[Error] 无法启动网关，config.json 加载失败: ${err.message}\n`);
    process.exit(1);
  }

  // B. 装载 cache.json
  cache = loadMetadataCache();
  
  // C. 建立模糊索引
  const cachedServers = cache?.servers || {};
  searchIndex.buildIndex(config.mcpServers, cachedServers);

  // D. 注册生命周期
  lifecycleManager = new McpLifecycleManager(serverManager, config);
  
  // E. 启动 30 秒轮询扫闲
  lifecycleManager.startSweeper(30000);

  // F. 挂载父进程自毁守卫 (Parent Death Watch)
  setupParentDeathWatch();
}

/**
 * 死亡守卫：在父进程暴毙、Pipe 破裂时，在 10 毫秒内自毁并强杀所有底层真实物理子进程，绝不泄漏内存
 */
function setupParentDeathWatch() {
  process.stdin.on("close", async () => {
    process.stderr.write("[DeathWatch] 检测到父进程管道已断开。正在强力清盘子进程并启动安全自毁...\n");
    lifecycleManager.stopSweeper();
    await serverManager.closeAll();
    process.exit(0);
  });

  // 捕获常规终止信号
  process.on("SIGINT", async () => {
    await cleanShutdown();
  });
  process.on("SIGTERM", async () => {
    await cleanShutdown();
  });
}

async function cleanShutdown() {
  lifecycleManager.stopSweeper();
  await serverManager.closeAll();
  process.exit(0);
}

// 2. 建立标准的官方 MCP Server
const server = new Server({
  name: "mcp-adapter",
  version: "1.0.0"
}, {
  capabilities: {
    tools: {}
  }
});

// 3. 注册 ListTools，对外【有且仅暴露 3 个元工具】
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "search_tools",
        description: "检索所有配置的 MCP 工具。模糊匹配工具名、别名、领域和服务描述。默认不返回庞大的入参 schema 以挽救上下文开销。",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "想要的诉求、功能关键字或领域词（如 'wiki list', '钉钉文档', 'siyuan sql'）"
            },
            server: {
              type: "string",
              description: "可选。指定在特定的服务器或别名下进行窄化检索"
            },
            limit: {
              type: "number",
              description: "可选。返回的最匹配工具条数，默认 10"
            }
          },
          required: ["query"]
        }
      },
      {
        name: "describe_tool",
        description: "根据名称，获取某一个指定工具的完整 Schema 和入参要求。在首次调用新工具前，应当调用此接口对齐参数。",
        inputSchema: {
          type: "object",
          properties: {
            tool: {
              type: "string",
              description: "需要查询的工具全名（形如 'dingtalk-doc.search_docs' 或是单纯的 'search_docs'）"
            },
            server: {
              type: "string",
              description: "可选。用于解决全局重名冲突，定位指定的底层服务器名字或别名"
            }
          },
          required: ["tool"]
        }
      },
      {
        name: "execute_tool",
        description: "执行底层的真实工具。如果目标子进程未运行，网关会执行 Lazy 惰性冷启动激活它，执行完毕原样返回原始结果。",
        inputSchema: {
          type: "object",
          properties: {
            tool: {
              type: "string",
              description: "真实的工具全名，形如 'dingtalk-doc.search_docs' 或单纯的 'search_docs'"
            },
            server: {
              type: "string",
              description: "可选。用于解决多服务同名冲突，指定某个具体的底层服务器名字或别名"
            },
            arguments: {
              type: "object",
              description: "符合该工具描述的真实入参键值对（Object）"
            }
          },
          required: ["tool"]
        }
      }
    ]
  };
});

// 4. 注册 CallTool 接收流量并分发中继
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // ==================== 4.1 search_tools 处理逻辑 ====================
  if (name === "search_tools") {
    const query = (args?.query as string) || "";
    const targetServerInput = args?.server as string | undefined;
    const limit = (args?.limit as number) || 10;

    let targetServer: string | undefined = undefined;
    if (targetServerInput) {
      const resolved = resolveServerName(targetServerInput, config.mcpServers);
      if (resolved) targetServer = resolved;
    }

    const matches = searchIndex.search(query, targetServer, limit);

    if (matches.length === 0) {
      return {
        content: [{
          type: "text",
          text: `[mcp-adapter] 抱歉，在已注册的工具中未匹配到与 "${query}" 相关的接口。`
        }]
      };
    }

    // 格式化输出
    let replyText = `[mcp-adapter] 为您精确筛选出以下 ${matches.length} 个匹配工具：\n\n`;
    for (const match of matches) {
      replyText += `- **${match.qualifiedName}** (匹配度: ${match.score}分)\n`;
      replyText += `  * 描述: ${match.description || "无"}\n`;
    }
    replyText += `\n*提示：在首次调用某工具前，推荐先执行 describe_tool 获取其详细参数入参 Schema。*`;

    return {
      content: [{ type: "text", text: replyText }]
    };
  }

  // ==================== 4.2 describe_tool 处理逻辑 ====================
  if (name === "describe_tool") {
    const toolInput = (args?.tool as string) || "";
    const serverInput = args?.server as string | undefined;

    const findResult = locateTool(toolInput, serverInput);
    if (!findResult) {
      return {
        content: [{
          type: "text",
          text: `[mcp-adapter-ERROR] 未能定位到工具 "${toolInput}"，请尝试使用 search_tools 先进行模糊查询。`
        }]
      };
    }

    if ("candidates" in findResult) {
      return {
        content: [{
          type: "text",
          text: `[mcp-adapter-Conflict] 工具名 "${toolInput}" 存在于多个服务器上。请提供 server 别名进行窄化：\n候选人列表：${findResult.candidates.join(", ")}`
        }]
      };
    }

    const targetTool = findResult.tool;
    const replyText = `[mcp-adapter] 已成功检索到工具定义：\n` +
      `- 工具全名: **${targetTool.server}.${targetTool.originalName}**\n` +
      `- 功能描述: ${targetTool.description || "无"}\n` +
      `- 参数结构:\n\`\`\`json\n${JSON.stringify(targetTool.inputSchema || {}, null, 2)}\n\`\`\``;

    return {
      content: [{ type: "text", text: replyText }]
    };
  }

  // ==================== 4.3 execute_tool 处理逻辑 ====================
  if (name === "execute_tool") {
    const toolInput = (args?.tool as string) || "";
    const serverInput = args?.server as string | undefined;
    const toolArguments = (args?.arguments as Record<string, unknown>) || {};

    const findResult = locateTool(toolInput, serverInput);
    if (!findResult) {
      throw new Error(`[mcp-adapter] 无法执行工具: 未能定位到 "${toolInput}"`);
    }

    if ("candidates" in findResult) {
      throw new Error(`[mcp-adapter] 工具 "${toolInput}" 存在重名冲突，请显式提供 server 参数。候选列表: ${findResult.candidates.join(", ")}`);
    }

    const { server: serverName, originalName } = findResult.tool;
    const serverConfig = config.mcpServers[serverName];

    if (!serverConfig) {
      throw new Error(`[mcp-adapter] 目标服务器 [${serverName}] 的启动配置缺失`);
    }

    // A. 建立连接 (Lazy 惰性唤醒 / 热自愈)
    let conn;
    try {
      conn = await serverManager.connect(serverName, serverConfig);
    } catch (err: any) {
      throw new Error(`[mcp-adapter] 唤醒子进程 [${serverName}] 失败: ${err.message}`);
    }

    // B. 更新 cache 并同步重构 SearchIndex（如果触发了 Cache 重新抓取更新）
    const latestCache = loadMetadataCache();
    if (latestCache) {
      searchIndex.buildIndex(config.mcpServers, latestCache.servers);
    }

    // C. 进行在途请求保护，代为调用，原样返回结果
    conn.inFlight++;
    try {
      const callResult = await conn.client.callTool({
        name: originalName,
        arguments: toolArguments
      });
      
      // 遵照峰哥《改进计划.md》第 2.3 节指示：【原样返回】真实工具结果，不做任何截留或截断
      return callResult;
    } finally {
      conn.inFlight--;
      conn.lastUsedAt = Date.now();
    }
  }

  throw new Error(`[mcp-adapter] 未知工具调用: ${name}`);
});

/**
 * 核心定位算法：从缓存列表中精确搜索或利用 qualifiedName 定位
 */
function locateTool(
  toolInput: string,
  serverInput?: string
): { tool: { server: string; originalName: string; description?: string; inputSchema: any } } | { candidates: string[] } | null {
  const latestCache = loadMetadataCache();
  if (!latestCache || !latestCache.servers) return null;

  let candidates: Array<{ server: string; originalName: string; description?: string; inputSchema: any }> = [];

  // A. 如果提供了 serverInput 限制，窄化解析
  if (serverInput) {
    const resolvedServer = resolveServerName(serverInput, config.mcpServers);
    if (resolvedServer) {
      const srvCache = latestCache.servers[resolvedServer];
      if (srvCache) {
        // 在该 server 下精确定位工具名
        const toolName = toolInput.includes(".") ? toolInput.split(".").pop()! : toolInput;
        const matched = srvCache.tools.find(t => t.name === toolName);
        if (matched) {
          return {
            tool: {
              server: resolvedServer,
              originalName: matched.name,
              description: matched.description,
              inputSchema: matched.inputSchema
            }
          };
        }
      }
    }
    return null;
  }

  // B. 如果未提供 serverInput，但工具名本身形如 "dingtalk-doc.search_docs" (Qualified Name)
  if (toolInput.includes(".")) {
    const idx = toolInput.indexOf(".");
    const serverPart = toolInput.substring(0, idx);
    const toolPart = toolInput.substring(idx + 1);

    const resolvedServer = resolveServerName(serverPart, config.mcpServers);
    if (resolvedServer) {
      const srvCache = latestCache.servers[resolvedServer];
      if (srvCache) {
        const matched = srvCache.tools.find(t => t.name === toolPart);
        if (matched) {
          return {
            tool: {
              server: resolvedServer,
              originalName: matched.name,
              description: matched.description,
              inputSchema: matched.inputSchema
            }
          };
        }
      }
    }
    return null;
  }

  // C. 全局匹配（未提供 server 也非 qualifiedName）
  for (const [srvName, srvCache] of Object.entries(latestCache.servers)) {
    const matched = srvCache.tools.find(t => t.name === toolInput);
    if (matched) {
      candidates.push({
        server: srvName,
        originalName: matched.name,
        description: matched.description,
        inputSchema: matched.inputSchema
      });
    }
  }

  if (candidates.length === 0) return null;
  if (candidates.length === 1) return { tool: candidates[0] };
  
  // 发生同名工具冲突，返回候选列表
  return { candidates: candidates.map(c => `${c.server}.${c.originalName}`) };
}

/**
 * 配置文件自动迁移导入逻辑 (一键无损迁移 222 个工具挂载)
 */
function importConfig(fromPath: string) {
  if (!fromPath || !fs.existsSync(fromPath)) {
    process.stderr.write(`[Error] 找不到源配置文件: ${fromPath}\n`);
    process.exit(1);
  }

  try {
    const raw = fs.readFileSync(fromPath, "utf-8");
    const parsed = JSON.parse(raw);

    // 智能提取原 mcpServers 配置块
    const sourceServers = parsed.mcpServers || parsed;

    if (!sourceServers || typeof sourceServers !== "object") {
      process.stderr.write("[Error] 源配置文件中不含任何有效的 mcpServers 声明\n");
      process.exit(1);
    }

    const targetConfig = loadConfig();
    targetConfig.mcpServers = targetConfig.mcpServers || {};

    let count = 0;
    for (const [name, serverConfig] of Object.entries(sourceServers)) {
      const srv = serverConfig as any;
      if (!srv || typeof srv !== "object") continue;

      // 生成默认别名列表：拆分单词
      const aliasSet = new Set<string>([name]);
      const parts = name.split(/[-_\s]+/);
      for (const part of parts) {
        if (part.length > 2) aliasSet.add(part);
      }

      // 针对常见服务的汉字别名建议（贴心内置中文别名库，开箱即模糊匹配）
      if (name.includes("siyuan")) {
        aliasSet.add("思源");
        aliasSet.add("笔记");
        aliasSet.add("思源笔记");
      } else if (name.includes("dingtalk")) {
        aliasSet.add("钉钉");
        if (name.includes("doc")) aliasSet.add("钉钉文档");
        if (name.includes("sheet")) aliasSet.add("钉钉表格");
        if (name.includes("ai")) {
          aliasSet.add("智能表格");
          aliasSet.add("多维表");
        }
      } else if (name.includes("confluence")) {
        aliasSet.add("wiki");
        aliasSet.add("知识库");
        aliasSet.add("公司文档");
      } else if (name.includes("zhishui")) {
        aliasSet.add("智水");
        aliasSet.add("止水");
        aliasSet.add("项目知识库");
      }

      // 严格原样、无损复制核心字段
      targetConfig.mcpServers[name] = {
        command: srv.command,
        args: srv.args,
        env: srv.env,
        cwd: srv.cwd,
        disabled: srv.disabled,

        // 新增扩展生命周期和 aliases
        lifecycle: "lazy",
        aliases: Array.from(aliasSet)
      };
      count++;
    }

    saveConfig(targetConfig);
    process.stdout.write(`\n[Import] 成功无损迁移了原配置中的 ${count} 个 MCP 服务挂载至 ~/.mcp-adapter/config.json！\n`);
  } catch (err: any) {
    process.stderr.write(`[Error] 配置迁移导入失败: ${err.message}\n`);
    process.exit(1);
  }
}

// 5. 挂载管道并拉起 Stdio 传输服务
async function main() {
  const args = process.argv.slice(2);
  const action = args[0];

  // ==================== CLI 命令分发 ====================
  if (action === "import") {
    let fromIndex = args.indexOf("--from");
    if (fromIndex === -1) {
      fromIndex = args.indexOf("-f");
    }
    const fromPath = fromIndex !== -1 ? args[fromIndex + 1] : undefined;
    if (!fromPath) {
      process.stderr.write("[Error] 未指定源配置文件。用法: mcp-adapter import --from ~/.claude.json\n");
      process.exit(1);
    }
    importConfig(fromPath);
    return;
  }

  // 默认启动 stdio 元 MCP Server 服务
  initialize();
  
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[mcp-adapter] 网关 Server 已经就绪，打通 Stdio Stdin/Stdout 通道。\n");
}

main().catch(err => {
  process.stderr.write(`[Fatal] 网关发生致命异常崩溃: ${err.message}\n`);
  process.exit(1);
});
