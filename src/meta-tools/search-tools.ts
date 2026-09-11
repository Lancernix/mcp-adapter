// search-tools.ts - search_tools 元工具：自然语言检索所有底层工具
//
// 工具的 name / description / schema / handler 是一个完整契约单元，同文件维护。
// 注册函数由 index.ts 装配时显式调用（不允许 import 副作用注册）。

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getValidCachedServers, loadMetadataCache } from "../cache-manager.js";
import { resolveServerHint } from "../config-manager.js";
import type { ToolSearchResult } from "../search-index.js";
import { findServersInText, normalizeForSearch } from "../search-utils.js";
import type { JsonSchema, ServerConfig } from "../types.js";
import {
  bootstrapStatus,
  config,
  disabledServerText,
  ensureServerMetadata,
  isServerDisabled,
  searchIndex,
} from "./runtime.js";

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

export function registerSearchTools(mcpServer: McpServer): void {
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
      // 高置信 hint 的 metadata 刷新失败时置位：此时已为该服务付出过一次完整的
      // 刷新尝试（可能耗满 connectTimeoutMs），后面的"从 query 识别服务"不应再
      // 对同一个服务重复尝试，否则一次搜索可能要等两次连接超时
      let hintRefreshFailed = false;

      if (targetServerInput) {
        const resolved = resolveServerHint(
          targetServerInput,
          config.mcpServers,
        );
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

          const hinted = resolved.resolvedServer;
          const ok = await ensureServerMetadata(hinted);
          if (!ok) {
            // 刷新失败不等于搜索失败：这个服务当前拉不起来，但其它服务可能就有
            // 用户要的东西。直接报错会把整条工具链在这里断掉，什么都不给；
            // 降级为全局搜索并把原因讲清楚，让调用方自己判断结果是否可用。
            hintRefreshFailed = true;
            serverHintNote =
              `已识别 server "${hinted}"，但该服务当前无法访问（启动失败、网络不通或认证错误），已降级为全局搜索。` +
              `如果你确实只想要该服务的结果，请先确认它能正常启动后再试。`;
          } else {
            targetServer = hinted;
            serverHintNote = `服务提示 "${targetServerInput}" 已解析为 server "${targetServer}"，已在该服务范围内搜索。`;
          }
        } else {
          // 中低置信或无法匹配时，将 hint 拼回 query 作为搜索关键词
          effectiveQuery = `${targetServerInput} ${query}`;

          // low 置信且唯一 candidate：刷新其 metadata 但不 scoped
          if (
            resolved.confidence === "low" &&
            resolved.candidates.length === 1
          ) {
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
      if (!targetServer && !hintRefreshFailed) {
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
            const startupCheckEnabled =
              config.settings?.startupMetadataCheck ?? true;
            if (!startupCheckEnabled) {
              text +=
                "\n\n当前 metadata cache 为空，且已关闭启动期 metadata 体检（startupMetadataCheck: false）。请使用带 server 参数的 search_tools、list_tools 或 describe_tool 手动触发对应服务的 metadata 刷新。";
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
}
