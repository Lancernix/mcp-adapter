#!/usr/bin/env node
// index.ts - Standard MCP Server Entrypoint for @lancernix/mcp-adapter
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  getValidCachedServers,
  isServerCacheValid,
  loadMetadataCache,
} from "./cache-manager.js";
import {
  getConfigPath,
  getMcpAdapterHome,
  loadConfig,
  resolveServerHint,
  resolveServerName,
  saveConfig,
} from "./config-manager.js";
import { ServerConfigSchema } from "./config-schema.js";
import { McpLifecycleManager } from "./lifecycle.js";
import { setConfigRef, writeLog } from "./logger.js";
import type { ToolSearchResult } from "./search-index.js";
import { SearchIndex } from "./search-index.js";
import { findServersInText, normalizeForSearch } from "./search-utils.js";
import type { ServerConnection } from "./server-manager.js";
import { McpServerManager } from "./server-manager.js";
import { TimeoutError, withTimeout } from "./timeout.js";
import type {
  AdapterConfig,
  BootstrapStatus,
  ConnectOptions,
  JsonSchema,
  ServerConfig,
} from "./types.js";

// ---- zod schema ----

const SearchToolsArgsSchema = z.object({
  query: z.string().min(1, "query 不能为空"),
  server: z
    .string()
    .optional()
    .describe(
      "可选目标服务提示（hint）。可填写用户提到的服务名、中文名、别名或近似名称，例如：钉钉文档、dingtalk、siyuan。不要求精确 server key。若无法高置信匹配，会自动回退全局搜索。",
    ),
  limit: z.coerce.number().int().min(1).max(20).optional(),
});

const DescribeToolArgsSchema = z.object({
  tool: z.string().min(1, "tool 不能为空"),
  server: z.string().optional(),
});

const ExecuteToolArgsSchema = z.object({
  tool: z.string().min(1, "tool 不能为空"),
  server: z.string().optional(),
  arguments: z.record(z.string(), z.unknown()).optional().default({}),
});

const ListToolsArgsSchema = z.object({
  server: z.string().min(1, "server 不能为空"),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

// ---- 全局状态 ----

let config: AdapterConfig;
const serverManager = new McpServerManager();
let lifecycleManager: McpLifecycleManager;
const searchIndex = new SearchIndex();

const bootstrapStatus: BootstrapStatus = {
  running: false,
  total: 0,
  completed: 0,
  errors: [],
};
let bootstrapStarted = false;

// ---- 启动 ----

async function initialize() {
  writeLog(
    `[@lancernix/mcp-adapter] 正在从 ${getMcpAdapterHome()} 启动冷装载...\n`,
  );

  try {
    config = loadConfig();
    setConfigRef(() => config);
  } catch (err) {
    writeLog(
      `[Error] 无法启动网关，config.json 加载失败: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }

  const initialCache = loadMetadataCache();
  const validCachedServers = getValidCachedServers(config, initialCache);
  searchIndex.buildIndex(config.mcpServers, validCachedServers);

  lifecycleManager = new McpLifecycleManager(serverManager, config);
  lifecycleManager.startSweeper(30000);

  setupParentDeathWatch();
}

// ---- 退出 ----

let shutdownInProgress = false;

async function shutdownAndExit(reason: string) {
  if (shutdownInProgress) return;
  shutdownInProgress = true;

  process.stdin.removeAllListeners("close");
  process.removeAllListeners("SIGINT");
  process.removeAllListeners("SIGTERM");

  writeLog(`[Shutdown] ${reason}\n`);

  lifecycleManager?.stopSweeper();
  const configuredCloseTimeoutMs = config?.settings?.closeTimeoutMs ?? 10000;
  const closeTimeoutMs =
    configuredCloseTimeoutMs <= 0 ? 10000 : configuredCloseTimeoutMs;
  await serverManager.shutdownAll(closeTimeoutMs, true);
  process.exit(0);
}

function setupParentDeathWatch() {
  process.stdin.on("close", () => {
    void shutdownAndExit("检测到父进程管道已断开");
  });

  process.on("SIGINT", () => {
    void shutdownAndExit("收到 SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdownAndExit("收到 SIGTERM");
  });
}

// ---- Bootstrap ----

function getServersNeedingMetadataRefresh(): Array<[string, ServerConfig]> {
  const latestCache = loadMetadataCache();
  const ttlDays = config.settings?.cacheTtlDays ?? 7;
  const maxAgeMs = ttlDays * 24 * 60 * 60 * 1000;

  const result: Array<[string, ServerConfig]> = [];

  for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
    if (serverConfig.disabled) continue;

    // refreshOnStartup: 每次启动都强制刷新（适用于在线 server）
    if (serverConfig.refreshOnStartup) {
      result.push([name, serverConfig]);
      continue;
    }

    const entry = latestCache?.servers?.[name];
    if (!isServerCacheValid(entry, serverConfig, maxAgeMs)) {
      result.push([name, serverConfig]);
    }
  }

  return result;
}

function startBackgroundBootstrapIfNeeded(): void {
  if (bootstrapStarted) return;

  const mode = config.settings?.metadataBootstrap ?? "background";
  if (mode === "off") return;

  const missingServers = getServersNeedingMetadataRefresh();
  if (missingServers.length === 0) {
    writeLog("[Bootstrap] 所有服务 metadata 缓存均有效，无需后台刷新。\n");
    return;
  }

  bootstrapStarted = true;

  setTimeout(() => {
    bootstrapServersSequentially(missingServers).catch((err) => {
      bootstrapStatus.running = false;
      bootstrapStatus.finishedAt = Date.now();
      writeLog(
        `[Bootstrap-Fatal] 后台 metadata 初始化异常中止: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    });
  }, 0);
}

async function bootstrapServersSequentially(
  servers: Array<[string, ServerConfig]>,
): Promise<void> {
  bootstrapStatus.running = true;
  bootstrapStatus.startedAt = Date.now();
  bootstrapStatus.finishedAt = undefined;
  bootstrapStatus.total = servers.length;
  bootstrapStatus.completed = 0;
  bootstrapStatus.errors = [];

  writeLog(
    `[Bootstrap] 后台 metadata 初始化开始，共 ${servers.length} 个服务待刷新。\n`,
  );

  for (const [name, srvConfig] of servers) {
    bootstrapStatus.current = name;

    try {
      writeLog(`[Bootstrap] 正在刷新 [${name}]...\n`);

      const refreshed = await serverManager.refreshMetadataIfNeeded(
        name,
        srvConfig,
        {
          cacheTtlDays: config.settings?.cacheTtlDays,
          connectTimeoutMs: config.settings?.connectTimeoutMs,
          requestTimeoutMs: config.settings?.requestTimeoutMs,
          closeTimeoutMs: config.settings?.closeTimeoutMs,
          closeIfCreated: true,
          forceRefresh: srvConfig.refreshOnStartup === true,
        },
      );

      const freshCache = loadMetadataCache();
      const validCachedServers = getValidCachedServers(config, freshCache);
      searchIndex.buildIndex(config.mcpServers, validCachedServers);

      if (refreshed && !validCachedServers[name]) {
        throw new Error(
          `刷新后未得到有效 metadata cache，server "${name}" 缓存写入可能失败`,
        );
      }

      const toolCount = validCachedServers[name]?.tools?.length ?? 0;
      const statusText = refreshed
        ? `发现 ${toolCount} 个工具`
        : "缓存有效，跳过";
      writeLog(`[Bootstrap] ✓ [${name}] metadata 刷新完成，${statusText}。\n`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      bootstrapStatus.errors.push({ server: name, message });
      writeLog(`[Bootstrap-Warning] 刷新 [${name}] 失败: ${message}\n`);
    } finally {
      bootstrapStatus.completed++;
      bootstrapStatus.current = undefined;
    }
  }

  bootstrapStatus.running = false;
  bootstrapStatus.finishedAt = Date.now();

  const latestCache = loadMetadataCache();
  const validCachedServers = getValidCachedServers(config, latestCache);
  searchIndex.buildIndex(config.mcpServers, validCachedServers);

  const successCount =
    bootstrapStatus.completed - bootstrapStatus.errors.length;
  writeLog(
    `[Bootstrap] 后台 metadata 初始化完成。成功: ${successCount}，失败: ${bootstrapStatus.errors.length}\n`,
  );
}

// ---- 辅助函数 ----

function findServersMentionedInQueryFromConfig(
  query: string,
  servers: Record<string, ServerConfig>,
): string[] {
  const names: string[] = [];
  const nameToServers = new Map<string, Set<string>>();

  for (const [serverName, srvConfig] of Object.entries(servers)) {
    if (srvConfig.disabled) continue;

    for (const name of [serverName, ...(srvConfig.aliases || [])]) {
      names.push(name);
      const key = normalizeForSearch(name);
      const set = nameToServers.get(key) ?? new Set<string>();
      set.add(serverName);
      nameToServers.set(key, set);
    }
  }

  const matchedNames = findServersInText(query, names);
  const result = new Set<string>();

  for (const matched of matchedNames) {
    const serversForName = nameToServers.get(normalizeForSearch(matched));
    if (serversForName) {
      for (const serverName of serversForName) {
        result.add(serverName);
      }
    }
  }

  return Array.from(result);
}

async function ensureServerMetadata(serverName: string): Promise<boolean> {
  const serverConfig = config.mcpServers[serverName];
  if (!serverConfig || serverConfig.disabled) return false;

  try {
    await serverManager.refreshMetadataIfNeeded(serverName, serverConfig, {
      cacheTtlDays: config.settings?.cacheTtlDays,
      connectTimeoutMs: config.settings?.connectTimeoutMs,
      requestTimeoutMs: config.settings?.requestTimeoutMs,
      closeTimeoutMs: config.settings?.closeTimeoutMs,
      closeIfCreated: true,
    });

    const refreshedCache = loadMetadataCache();
    const validCachedServers = getValidCachedServers(config, refreshedCache);
    searchIndex.buildIndex(config.mcpServers, validCachedServers);

    return !!validCachedServers[serverName];
  } catch (err) {
    writeLog(
      `[Metadata] 刷新 ${serverName} 工具元数据失败: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return false;
  }
}

type ExecuteErrorType =
  | "tool_not_found"
  | "missing_param"
  | "type_error"
  | "business";

function classifyError(err: Error): ExecuteErrorType {
  const msg = err.message.toLowerCase();
  if (
    msg.includes("not found") ||
    msg.includes("unknown tool") ||
    msg.includes("tool not found") ||
    msg.includes("未能定位") ||
    msg.includes("工具不存在") ||
    msg.includes("未找到工具") ||
    msg.includes("找不到工具")
  ) {
    return "tool_not_found";
  }
  if (
    msg.includes("required") ||
    msg.includes("missing") ||
    msg.includes("cannot be empty") ||
    msg.includes("缺少") ||
    msg.includes("必填") ||
    msg.includes("不能为空") ||
    msg.includes("不得为空")
  ) {
    return "missing_param";
  }
  if (
    msg.includes("invalid type") ||
    msg.includes("type mismatch") ||
    msg.includes("expected") ||
    msg.includes("类型错误") ||
    msg.includes("类型不匹配") ||
    msg.includes("应为") ||
    msg.includes("必须是")
  ) {
    return "type_error";
  }
  return "business";
}

const MAX_SCHEMA_CHARS = 8000;

function stringifySchemaForSearch(schema: JsonSchema | undefined): string {
  const fallback = schema ?? { type: "object", properties: {} };
  const text = JSON.stringify(fallback, null, 2);
  if (text.length <= MAX_SCHEMA_CHARS) return text;
  return `${text.slice(0, MAX_SCHEMA_CHARS)}\n... schema 已截断，请使用 describe_tool 查看完整 inputSchema`;
}

function buildExecutionAdvice(match: ToolSearchResult): string {
  if (match.matchKind === "server_browse") {
    return "这是服务浏览兜底结果，请先调用 describe_tool 确认具体功能后再执行。";
  }

  if (match.matchKind === "token_fallback" && match.score < 50) {
    return "关键词兜底结果，建议先调用 describe_tool 确认参数定义。";
  }

  if (
    (match.matchKind === "hybrid" || match.matchKind === "bm25") &&
    match.score >= 70
  ) {
    return "高置信匹配，参数明确时可直接 execute_tool。";
  }

  if (match.matchKind === "fuzzy" && match.score >= 65) {
    return "较高置信匹配，执行前请确认 inputSchema。";
  }

  return "中低置信匹配，建议先调用 describe_tool 确认后再执行。";
}

function buildSearchTitle(
  matches: ToolSearchResult[],
  targetServer?: string,
): string {
  const hasServerBrowse = matches.some((m) => m.matchKind === "server_browse");
  const hasTokenFallback = matches.some(
    (m) => m.matchKind === "token_fallback",
  );

  if (hasServerBrowse) {
    return targetServer
      ? `[mcp-adapter] 已识别到服务 ${targetServer}，但功能关键词未强匹配。` +
          `以下返回 ${matches.length} 个该服务下的工具候选作为浏览兜底：\n\n`
      : `[mcp-adapter] 功能关键词未强匹配，以下返回 ${matches.length} 个候选工具作为浏览兜底：\n\n`;
  }

  if (hasTokenFallback) {
    return `[mcp-adapter] 以下返回 ${matches.length} 个关键词兜底候选工具：\n\n`;
  }

  return `[mcp-adapter] 为您筛选出以下 ${matches.length} 个匹配工具：\n\n`;
}

function isServerDisabled(serverName: string): boolean {
  return config.mcpServers[serverName]?.disabled === true;
}

function disabledServerText(serverName: string): string {
  return `[mcp-adapter-ERROR] server "${serverName}" 已被 disabled，无法搜索、描述或调用。请在 config.json 中取消 disabled 后重试。`;
}

// ---- MCP Server 注册 ----

const mcpServer = new McpServer(
  {
    name: "mcp-adapter",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// ---- search_tools ----

mcpServer.registerTool(
  "search_tools",
  {
    description:
      "检索所有配置的 MCP 工具。推荐优先使用此工具。模糊匹配工具名、服务名、别名和描述正文。" +
      "搜索结果已包含完整 inputSchema，足以直接调用 execute_tool，无需再调 describe_tool。" +
      "query 应保留用户请求中的关键名词、动作和目标系统名（如 'postgres schema'、'钉钉文档 搜索'），不要只填 get/list/search/query 等泛词。" +
      "server 是可选的服务提示（hint），可填写自然语言服务名、中文名或别名，不要求是精确的 server key；无法高置信匹配时将自动回退全局搜索。" +
      "低置信结果建议先调 describe_tool 确认参数定义后再执行。" +
      "已知工具名需看完整参数定义时使用 describe_tool。",
    inputSchema: SearchToolsArgsSchema,
  },
  async ({ query, server: targetServerInput, limit }) => {
    let targetServer: string | undefined;
    let serverHintNote: string | undefined;
    let effectiveQuery = query;
    let lowCandidateRefreshFailed: string | undefined;

    if (targetServerInput) {
      const resolved = resolveServerHint(targetServerInput, config.mcpServers);
      if (resolved.confidence === "high" && resolved.resolvedServer) {
        if (isServerDisabled(resolved.resolvedServer)) {
          return {
            content: [
              {
                type: "text",
                text: disabledServerText(resolved.resolvedServer),
              },
            ],
          };
        }

        targetServer = resolved.resolvedServer;
        const ok = await ensureServerMetadata(targetServer);
        if (!ok) {
          return {
            content: [
              {
                type: "text",
                text: `[mcp-adapter-ERROR] 已识别 server "${targetServer}"，但刷新 metadata 失败。请检查该 MCP 服务是否可启动、网络是否可达、认证信息是否正确。`,
              },
            ],
          };
        }
        serverHintNote = `服务提示 "${targetServerInput}" 已解析为 server "${targetServer}"，已在该服务范围内搜索。`;
      } else {
        // 中低置信或无法匹配时，将 hint 拼回 query 作为搜索关键词
        effectiveQuery = `${targetServerInput} ${query}`;

        // low 置信且唯一 candidate：刷新其 metadata 但不 scoped
        if (resolved.confidence === "low" && resolved.candidates.length === 1) {
          const candidate = resolved.candidates[0];
          const ok = await ensureServerMetadata(candidate);
          if (!ok) {
            lowCandidateRefreshFailed = `低置信候选 server "${candidate}" metadata 刷新失败，搜索可能不完整。`;
          }
        }

        if (resolved.confidence === "medium") {
          serverHintNote = `服务提示 "${targetServerInput}" 存在歧义（${resolved.reason}），已将其作为搜索关键词参与全局搜索。`;
        } else if (resolved.confidence === "low") {
          serverHintNote = `服务提示 "${targetServerInput}" 未能高置信匹配（${resolved.reason}），已将其作为搜索关键词参与全局搜索。`;
        } else {
          serverHintNote = `服务提示 "${targetServerInput}" 未匹配到已配置服务，已将其作为搜索关键词参与全局搜索。`;
        }
      }
    }

    // query 命中唯一 alias 时同步刷新
    let inferredServer: string | undefined;
    let inferredServerMetadataOk: boolean | undefined;
    if (!targetServer) {
      const mentionedServers = findServersMentionedInQueryFromConfig(
        query,
        config.mcpServers,
      );
      if (mentionedServers.length === 1) {
        inferredServer = mentionedServers[0];
        targetServer = inferredServer;
        inferredServerMetadataOk = await ensureServerMetadata(targetServer);
      }
    }

    const effectiveLimit = Math.min(
      limit ?? config.settings?.toolSearchLimit ?? 10,
      20,
    );
    const matches = searchIndex.search(
      effectiveQuery,
      targetServer,
      effectiveLimit,
    );

    if (matches.length === 0 && targetServer) {
      // 已识别 server 但功能关键词无强匹配 → fallback 到 server 工具候选
      const browseMatches = searchIndex.browseServer(
        targetServer,
        effectiveLimit,
      );
      if (browseMatches.length > 0) {
        const grouped = new Map<string, ToolSearchResult[]>();
        for (const m of browseMatches) {
          const list = grouped.get(m.server) || [];
          list.push(m);
          grouped.set(m.server, list);
        }

        let replyText = `[mcp-adapter] 已识别到服务 ${targetServer}，但功能关键词未强匹配。以下为该服务下的候选工具兜底结果：\n\n`;
        for (const [srv, tools] of grouped) {
          replyText += `### ${srv} (${tools.length} tools)\n`;
          for (const match of tools) {
            replyText += `- **${match.qualifiedName}** (服务浏览兜底)\n`;
            replyText += `  描述: ${match.description || "无"}\n`;

            if (match.matchReasons?.length) {
              replyText += `  匹配依据: ${match.matchReasons.join("；")}\n`;
            }

            replyText += "  inputSchema:\n";
            replyText += "```json\n";
            replyText += `${stringifySchemaForSearch(match.inputSchema)}\n`;
            replyText += "```\n\n";
          }
        }

        replyText +=
          "如果以上候选仍不满意，请使用 list_tools 查看该服务全部工具名，再用 describe_tool 确认具体工具。";

        return {
          content: [{ type: "text", text: replyText }],
        };
      }
    }

    if (matches.length === 0) {
      let text = serverHintNote ? `${serverHintNote}\n\n` : "";
      text += `[mcp-adapter] 暂未匹配到与 query="${query}" 相关的接口。`;
      if (targetServerInput) {
        text += `\n服务提示: "${targetServerInput}"。`;
      }
      if (effectiveQuery !== query) {
        text += `\n实际搜索组合查询: "${effectiveQuery}"。`;
      }

      if (bootstrapStatus.running) {
        text += `\n\n当前工具索引正在后台初始化：${bootstrapStatus.completed}/${bootstrapStatus.total} 已完成`;
        if (bootstrapStatus.current) {
          text += `，正在处理：${bootstrapStatus.current}`;
        }
        text += "。\n请稍后重试，或提供更明确的 server 参数。";
      } else {
        const validCache = getValidCachedServers(config, loadMetadataCache());
        if (Object.keys(validCache).length === 0) {
          const bootstrapMode =
            config.settings?.metadataBootstrap ?? "background";
          if (bootstrapMode === "off") {
            text +=
              "\n\n当前 metadata cache 为空，且 metadataBootstrap=off。请使用带 server 参数的 search_tools、list_tools 或 describe_tool 手动触发对应服务的 metadata 刷新。";
          } else {
            text +=
              "\n\n当前 metadata cache 为空。adapter 会在后台初始化，请稍后重试。";
          }
        } else {
          const availableServers = Object.entries(config.mcpServers)
            .filter(([, cfg]) => !cfg.disabled)
            .map(([name, cfg]) =>
              cfg.aliases?.length
                ? `- ${name} (aliases: ${cfg.aliases.join(", ")})`
                : `- ${name}`,
            )
            .join("\n");

          if (availableServers) {
            text += `\n\n可用 server 列表：\n${availableServers}\n\n如果你知道目标服务，请使用 list_tools server="服务名" 查看该服务全部工具。`;
          }
        }
      }

      if (inferredServer && inferredServerMetadataOk === false) {
        text += `\n\n已根据 query 识别到 server "${inferredServer}"，但 metadata 刷新失败。请检查该服务是否可启动、网络/认证是否正常，或显式传入 server 参数重试。`;
      }

      if (lowCandidateRefreshFailed) {
        text += `\n\n${lowCandidateRefreshFailed}`;
      }

      return {
        content: [{ type: "text", text }],
      };
    }

    // 按 server 分组
    const grouped = new Map<string, ToolSearchResult[]>();
    for (const m of matches) {
      const list = grouped.get(m.server) || [];
      list.push(m);
      grouped.set(m.server, list);
    }

    let replyText = serverHintNote ? `${serverHintNote}\n\n` : "";
    replyText += buildSearchTitle(matches, targetServer);
    for (const [srv, tools] of grouped) {
      replyText += `### ${srv} (${tools.length} matches)\n`;
      for (const match of tools) {
        replyText += `- **${match.qualifiedName}** (${match.score}分`;
        if (
          match.matchKind !== "fuzzy" &&
          match.matchKind !== "hybrid" &&
          match.matchKind !== "bm25"
        ) {
          const kindLabel =
            match.matchKind === "token_fallback"
              ? "关键词兜底"
              : "服务浏览兜底";
          replyText += `, ${kindLabel}`;
        }
        if (match.matchKind === "hybrid") {
          replyText += ", 混合匹配";
        }
        if (match.matchKind === "bm25") {
          replyText += ", BM25匹配";
        }
        replyText += ")\n";
        replyText += `  描述: ${match.description || "无"}\n`;

        if (match.matchReasons?.length) {
          replyText += `  匹配依据: ${match.matchReasons.join("；")}\n`;
        }

        replyText += `  执行建议: ${buildExecutionAdvice(match)}\n`;

        replyText += "  inputSchema:\n";
        replyText += "```json\n";
        replyText += `${stringifySchemaForSearch(match.inputSchema)}\n`;
        replyText += "```\n\n";
      }
    }

    return {
      content: [{ type: "text", text: replyText }],
    };
  },
);

// ---- describe_tool ----

mcpServer.registerTool(
  "describe_tool",
  {
    description:
      "获取单个工具的完整定义和 inputSchema。用于已知具体工具名后确认参数，" +
      "尤其适合从 list_tools 返回的工具名中选择疑似工具后调用。" +
      "日常工具发现推荐优先使用 search_tools，因为 search_tools 已返回完整 inputSchema，通常可直接 execute_tool。",
    inputSchema: DescribeToolArgsSchema,
  },
  async ({ tool: toolInput, server: serverInput }) => {
    // 从输入中提前解析目标 server 并刷新 metadata
    let resolvedServer: string | null = null;

    if (serverInput) {
      resolvedServer = resolveServerName(serverInput, config.mcpServers);
      if (!resolvedServer) {
        return {
          content: [
            {
              type: "text",
              text: `[mcp-adapter-ERROR] 未找到 server "${serverInput}"。请检查服务名或 aliases。`,
            },
          ],
        };
      }
    } else if (toolInput.includes(".")) {
      const parsed = parseQualifiedToolInput(toolInput);
      if (parsed) {
        resolvedServer = parsed.server;
      } else {
        const idx = toolInput.indexOf(".");
        resolvedServer = resolveServerName(
          toolInput.substring(0, idx),
          config.mcpServers,
        );
      }
    }

    if (resolvedServer) {
      if (isServerDisabled(resolvedServer)) {
        return {
          content: [{ type: "text", text: disabledServerText(resolvedServer) }],
        };
      }

      const ok = await ensureServerMetadata(resolvedServer);
      if (!ok) {
        return {
          content: [
            {
              type: "text",
              text: `[mcp-adapter-ERROR] 已找到 server "${resolvedServer}"，但 metadata 不可用。请检查该 MCP 服务是否可启动、网络是否可达。`,
            },
          ],
        };
      }
    }

    const findResult = locateTool(toolInput, serverInput);

    if (!findResult) {
      return {
        content: [
          {
            type: "text",
            text: `[mcp-adapter-ERROR] 未能定位到工具 "${toolInput}"，请尝试使用 search_tools 先进行模糊查询。`,
          },
        ],
      };
    }

    if ("candidates" in findResult) {
      return {
        content: [
          {
            type: "text",
            text: `[mcp-adapter-Conflict] 工具名 "${toolInput}" 存在于多个服务器上。请提供 server 参数进行窄化：\n候选工具列表：${findResult.candidates.join(", ")}`,
          },
        ],
      };
    }

    const targetTool = findResult.tool;
    const replyText =
      `[mcp-adapter] 已成功检索到工具定义：\n` +
      `- 工具全名: **${targetTool.server}.${targetTool.originalName}**\n` +
      `- 功能描述: ${targetTool.description || "无"}\n` +
      `- 参数结构:\n\`\`\`json\n${JSON.stringify(targetTool.inputSchema || {}, null, 2)}\n\`\`\``;

    return {
      content: [{ type: "text", text: replyText }],
    };
  },
);

// ---- list_tools ----

mcpServer.registerTool(
  "list_tools",
  {
    description:
      "列出指定 MCP Server 的全部工具名称。仅返回工具名，不返回描述和参数 Schema。" +
      "用于 search_tools 结果不理想时的目录式兜底浏览。看到疑似工具名后，再调用 describe_tool 获取完整 schema。",
    inputSchema: ListToolsArgsSchema,
  },
  async ({ server: serverInput, limit }) => {
    const resolved = resolveServerName(serverInput, config.mcpServers);
    if (!resolved) {
      return {
        content: [
          {
            type: "text",
            text: `[mcp-adapter-ERROR] 未找到 server "${serverInput}"。请检查服务名或 aliases。`,
          },
        ],
      };
    }

    if (isServerDisabled(resolved)) {
      return {
        content: [{ type: "text", text: disabledServerText(resolved) }],
      };
    }

    const ok = await ensureServerMetadata(resolved);
    if (!ok) {
      return {
        content: [
          {
            type: "text",
            text: `[mcp-adapter-ERROR] 已找到 server "${resolved}"，但 metadata 不可用。请检查该服务是否可启动、网络是否可达。`,
          },
        ],
      };
    }

    const validServers = getValidCachedServers(config, loadMetadataCache());
    const entry = validServers[resolved];
    const tools = entry?.tools || [];
    const MAX_LIST_TOOLS = 500;
    const effectiveLimit = Math.min(limit ?? MAX_LIST_TOOLS, MAX_LIST_TOOLS);
    const sliced = tools.slice(0, effectiveLimit);

    let replyText = `[mcp-adapter] ${resolved} 共有 ${tools.length} 个工具，以下返回 ${sliced.length} 个工具名：\n\n`;
    sliced.forEach((t, idx) => {
      replyText += `${idx + 1}. ${t.name}\n`;
    });

    if (tools.length > sliced.length) {
      if (limit) {
        replyText += `\n该 server 共有 ${tools.length} 个工具，当前按 limit=${effectiveLimit} 仅返回前 ${sliced.length} 个。\n`;
      } else {
        replyText += `\n该 server 共有 ${tools.length} 个工具，超过最大返回数量 ${MAX_LIST_TOOLS}，当前仅返回前 ${sliced.length} 个。请使用 search_tools 缩小范围。\n`;
      }
    }

    replyText +=
      `\n仅返回工具名，不包含描述和参数。` +
      `如果某个工具名看起来相关，请调用 describe_tool 获取完整 schema。`;

    return {
      content: [{ type: "text", text: replyText }],
    };
  },
);

// ---- execute_tool ----

mcpServer.registerTool(
  "execute_tool",
  {
    description:
      "执行底层的真实工具。如果目标子进程未运行，网关会执行 Lazy 惰性冷启动激活它，执行完毕原样返回原始结果。",
    inputSchema: ExecuteToolArgsSchema,
  },
  async ({
    tool: toolInput,
    server: serverInput,
    arguments: toolArguments,
  }) => {
    const findResult = locateTool(toolInput, serverInput);
    let serverName: string;
    let originalName: string;
    let cacheHit = false;

    if (findResult && !("candidates" in findResult)) {
      serverName = findResult.tool.server;
      originalName = findResult.tool.originalName;
      cacheHit = true;
    } else if (findResult && "candidates" in findResult) {
      throw new Error(
        `[mcp-adapter] 工具 "${toolInput}" 存在重名冲突，请显式提供 server 参数。候选列表: ${findResult.candidates.join(", ")}`,
      );
    } else {
      const resolved = resolveServerFromToolInput(toolInput, serverInput);
      if (!resolved) {
        throw new Error(
          `[mcp-adapter] 未能定位到工具 "${toolInput}"，请使用 search_tools 重新搜索。`,
        );
      }
      serverName = resolved.server;
      originalName = resolved.tool;
    }

    const serverConfig = config.mcpServers[serverName];
    if (!serverConfig) {
      throw new Error(
        `[mcp-adapter] 目标服务器 [${serverName}] 的启动配置缺失`,
      );
    }
    if (serverConfig.disabled) {
      throw new Error(disabledServerText(serverName));
    }

    let conn: ServerConnection;
    const startTime = Date.now();
    try {
      const options: ConnectOptions = {
        connectTimeoutMs:
          serverConfig.connectTimeoutMs ?? config.settings?.connectTimeoutMs,
        requestTimeoutMs:
          serverConfig.requestTimeoutMs ?? config.settings?.requestTimeoutMs,
        closeTimeoutMs:
          serverConfig.closeTimeoutMs ?? config.settings?.closeTimeoutMs,
      };
      conn = await serverManager.connect(serverName, serverConfig, options);
    } catch (err) {
      throw new Error(
        `[mcp-adapter] 唤醒子进程 [${serverName}] 失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    conn.inFlight++;
    const closeTimeoutMs =
      serverConfig.closeTimeoutMs ?? config.settings?.closeTimeoutMs ?? 10000;

    let shouldDropConnection = false;

    try {
      const requestTimeoutMs =
        serverConfig.requestTimeoutMs ??
        config.settings?.requestTimeoutMs ??
        60000;

      const rawResult = await withTimeout(
        conn.client.callTool({
          name: originalName,
          arguments: toolArguments,
        }),
        requestTimeoutMs,
        `执行工具 [${serverName}.${originalName}] 超时，超过 ${requestTimeoutMs}ms`,
      );
      return rawResult as CallToolResult;
    } catch (err) {
      if (err instanceof TimeoutError) {
        shouldDropConnection = true;
      }

      const errorType = classifyError(
        err instanceof Error ? err : new Error(String(err)),
      );
      const rawMsg = err instanceof Error ? err.message : String(err);

      let userMsg: string;
      switch (errorType) {
        case "tool_not_found":
          userMsg = `[mcp-adapter] 工具 "${originalName}" 在 server "${serverName}" 中不存在，请使用 search_tools 重新搜索。`;
          break;
        case "missing_param":
          userMsg = `[mcp-adapter] 调用 "${serverName}.${originalName}" 缺少必填参数，请补充后重试。原始错误: ${rawMsg}`;
          break;
        case "type_error":
          userMsg = `[mcp-adapter] 调用 "${serverName}.${originalName}" 参数类型错误，请检查后重试。原始错误: ${rawMsg}`;
          break;
        default:
          userMsg = rawMsg;
      }

      throw new Error(userMsg);
    } finally {
      conn.inFlight = Math.max(0, conn.inFlight - 1);
      conn.lastUsedAt = Date.now();

      if (shouldDropConnection) {
        await serverManager
          .close(serverName, closeTimeoutMs, true)
          .catch(() => {});
      }

      writeLog(
        `[HitRate] ${serverName}.${originalName} | cache=${cacheHit ? "hit" : "miss"} | ${Date.now() - startTime}ms\n`,
      );
    }
  },
);

// ---- 工具定位 ----

function parseQualifiedToolInput(
  input: string,
): { server: string; tool: string } | null {
  const text = input.trim();
  const lowerText = text.toLowerCase();

  // 收集所有候选前缀：server key + aliases
  const candidates: Array<{ name: string; server: string }> = [];
  for (const [serverName, cfg] of Object.entries(config.mcpServers)) {
    candidates.push({ name: serverName, server: serverName });
    for (const alias of cfg.aliases || []) {
      candidates.push({ name: alias, server: serverName });
    }
  }
  candidates.sort((a, b) => b.name.length - a.name.length);

  for (const { name, server } of candidates) {
    const prefix = `${name}.`;
    if (lowerText.startsWith(prefix.toLowerCase())) {
      return { server, tool: text.slice(prefix.length) };
    }
  }

  return null;
}

function stripQualifiedPrefixForServer(
  toolInput: string,
  serverName: string,
): string {
  const text = toolInput.trim();
  const cfg = config.mcpServers[serverName];
  const prefixes = [serverName, ...(cfg?.aliases || [])]
    .map((x) => `${x}.`)
    .sort((a, b) => b.length - a.length);

  const lower = text.toLowerCase();
  for (const prefix of prefixes) {
    if (lower.startsWith(prefix.toLowerCase())) {
      return text.slice(prefix.length);
    }
  }
  return text;
}

function resolveServerFromToolInput(
  toolInput: string,
  serverInput?: string,
): { server: string; tool: string } | null {
  // A. 显式 server 参数优先
  if (serverInput) {
    const srv = resolveServerName(serverInput, config.mcpServers);
    if (srv) {
      return {
        server: srv,
        tool: stripQualifiedPrefixForServer(toolInput, srv),
      };
    }
  }

  // B. 包含 "." → 尝试按 qualifiedName 解析（长前缀匹配）
  if (toolInput.includes(".")) {
    const parsed = parseQualifiedToolInput(toolInput);
    if (parsed) {
      return parsed;
    }

    // fallback: 首个 "." 分割（兼容旧行为）
    const idx = toolInput.indexOf(".");
    const serverPart = toolInput.substring(0, idx);
    const toolPart = toolInput.substring(idx + 1);

    const srv = resolveServerName(serverPart, config.mcpServers);
    if (srv) {
      return { server: srv, tool: toolPart };
    }
  }

  return null;
}

function locateTool(
  toolInput: string,
  serverInput?: string,
):
  | {
      tool: {
        server: string;
        originalName: string;
        description?: string;
        inputSchema?: JsonSchema;
      };
    }
  | { candidates: string[] }
  | null {
  const validServers = getValidCachedServers(config, loadMetadataCache());

  // A. 显式 server 参数优先
  if (serverInput) {
    const srvName = resolveServerName(serverInput, config.mcpServers);
    if (srvName && validServers[srvName]) {
      const toolName = stripQualifiedPrefixForServer(toolInput, srvName);
      const matched = validServers[srvName].tools.find(
        (t) => t.name === toolName,
      );
      if (matched) {
        return {
          tool: {
            server: srvName,
            originalName: matched.name,
            description: matched.description,
            inputSchema: matched.inputSchema,
          },
        };
      }
    }
    // server 参数有效但工具名在该 server 下不存在 → 提前返回 null
    if (srvName) {
      return null;
    }
  }

  // B. "server.tool" 格式（长前缀匹配）
  if (toolInput.includes(".")) {
    const parsed = parseQualifiedToolInput(toolInput);
    if (parsed && validServers[parsed.server]) {
      const srvName = parsed.server;
      const toolPart = parsed.tool;
      const matched = validServers[srvName].tools.find(
        (t) => t.name === toolPart,
      );
      if (matched) {
        return {
          tool: {
            server: srvName,
            originalName: matched.name,
            description: matched.description,
            inputSchema: matched.inputSchema,
          },
        };
      }
    }

    // fallback: 首个 "." 分割
    const idx = toolInput.indexOf(".");
    const serverPart = toolInput.substring(0, idx);
    const toolPart = toolInput.substring(idx + 1);

    const srvName = resolveServerName(serverPart, config.mcpServers);
    if (srvName && validServers[srvName]) {
      const matched = validServers[srvName].tools.find(
        (t) => t.name === toolPart,
      );
      if (matched) {
        return {
          tool: {
            server: srvName,
            originalName: matched.name,
            description: matched.description,
            inputSchema: matched.inputSchema,
          },
        };
      }
    }
    // 如果 "server.tool" 格式解析出的 server 不存在，继续尝试作为纯工具名搜索
  }

  // C. 全局匹配 + 重名检测
  const candidates: Array<{
    server: string;
    originalName: string;
    description?: string;
    inputSchema?: JsonSchema;
  }> = [];

  for (const [srvName, srvCache] of Object.entries(validServers)) {
    const matched = srvCache.tools.find((t) => t.name === toolInput);
    if (matched) {
      candidates.push({
        server: srvName,
        originalName: matched.name,
        description: matched.description,
        inputSchema: matched.inputSchema,
      });
    }
  }

  if (candidates.length === 0) return null;
  if (candidates.length === 1) return { tool: candidates[0] };
  return { candidates: candidates.map((c) => `${c.server}.${c.originalName}`) };
}

// ---- CLI import ----

function importConfig(fromPath: string, dryRun = false) {
  if (!fromPath || !fs.existsSync(fromPath)) {
    writeLog(`[Error] 找不到源配置文件: ${fromPath}\n`);
    process.exit(1);
  }

  try {
    const raw = fs.readFileSync(fromPath, "utf-8");
    const parsed = JSON.parse(raw);

    const sourceServers = parsed.mcpServers;

    if (!sourceServers || typeof sourceServers !== "object") {
      writeLog("[Error] 源配置文件中未找到顶层 mcpServers。请确认文件格式。\n");
      process.exit(1);
    }

    const targetConfig = loadConfig();
    targetConfig.mcpServers = targetConfig.mcpServers || {};

    let count = 0;
    const preview: string[] = [];

    for (const [name, serverConfig] of Object.entries(sourceServers)) {
      if (!serverConfig || typeof serverConfig !== "object") continue;

      const parsedServer = ServerConfigSchema.safeParse(serverConfig);
      if (!parsedServer.success) {
        preview.push(
          `  - ${name} [跳过：配置格式非法] ${parsedServer.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; ")}`,
        );
        continue;
      }

      const srv = parsedServer.data;

      const aliasSet = new Set<string>([name]);
      const parts = name.split(/[-_\s]+/);
      for (const part of parts) {
        if (part.length > 2) aliasSet.add(part);
      }

      const existingAliases = Array.isArray(srv.aliases) ? srv.aliases : [];

      const imported: ServerConfig = {
        ...srv,
        lifecycle: srv.lifecycle ?? "lazy",
        aliases: Array.from(new Set([...existingAliases, ...aliasSet])),
      };

      targetConfig.mcpServers[name] = imported;
      preview.push(
        `  - ${name} (${imported.type ?? "stdio"})${imported.disabled ? " [已禁用]" : ""} aliases: [${imported.aliases?.join(", ")}]`,
      );
      count++;
    }

    if (dryRun) {
      process.stdout.write(
        `\n[Import-DryRun] 以下 ${count} 个服务将被导入至 ${getConfigPath()}：\n\n${preview.join("\n")}\n\n注意：此为预览，尚未实际写入配置。\n`,
      );
      process.exit(0);
    }

    saveConfig(targetConfig);
    writeLog(
      `\n[Import] 成功无损迁移了原配置中的 ${count} 个 MCP 服务挂载至 ${getConfigPath()}！\n`,
    );
  } catch (err) {
    writeLog(
      `[Import-Error] 迁移失败: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }
}

// ---- 入口 ----

async function main() {
  const args = process.argv.slice(2);

  if (args[0] === "import") {
    const fromIdx = args.indexOf("--from");
    let fromPath = fromIdx !== -1 ? args[fromIdx + 1] : undefined;
    const dryRun = args.includes("--dry-run");

    if (!fromPath) {
      const home = os.homedir();
      // 尝试常见的默认路径
      const candidates = [
        path.join(home, ".claude", "settings.json"),
        path.join(home, ".claude.json"),
      ];
      for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
          fromPath = candidate;
          break;
        }
      }
    }

    if (!fromPath || !fs.existsSync(fromPath)) {
      writeLog(
        "[Error] 未找到源配置文件。用法: mcp-adapter import [--from <path>] [--dry-run]\n" +
          "默认从 ~/.claude.json 读取，也可通过 --from 指定其他路径。\n",
      );
      process.exit(1);
    }

    importConfig(fromPath, dryRun);
    return;
  }

  await initialize();

  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);

  writeLog(
    "[mcp-adapter] 网关 Server 已经就绪，打通 Stdio Stdin/Stdout 通道。\n",
  );

  startBackgroundBootstrapIfNeeded();
}

main().catch((err) => {
  writeLog(`[Fatal] 网关发生致命异常崩溃: ${err.message}\n`);
  process.exit(1);
});
