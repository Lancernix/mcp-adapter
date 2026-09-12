// catalog-tools.ts - describe_tool 与 list_tools 元工具：按服务浏览工具目录
//
// 两者都是"读缓存的目录式查询"：describe 返回单个工具的完整 inputSchema，
// list 只返回工具名。schema 与 handler 同文件维护，注册由 index.ts 显式调用。

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getValidCachedServers, loadMetadataCache } from "../cache-manager.js";
import { resolveServerName } from "../config-manager.js";
import { locateTool, parseQualifiedToolInput } from "./locate-tool.js";
import {
  config,
  disabledServerText,
  ensureServerMetadata,
  isServerDisabled,
} from "./runtime.js";

const DescribeToolArgsSchema = z.object({
  tool: z.string().min(1, "tool 不能为空"),
  server: z.string().optional(),
});

const ListToolsArgsSchema = z.object({
  server: z.string().min(1, "server 不能为空"),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export function registerDescribeTool(mcpServer: McpServer): void {
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
            content: [
              { type: "text", text: disabledServerText(resolvedServer) },
            ],
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
}

export function registerListTools(mcpServer: McpServer): void {
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
}
