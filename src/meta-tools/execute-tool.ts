// execute-tool.ts - execute_tool 元工具：唤醒目标服务并执行真实工具
//
// 包含错误分类（连接断开 / 参数缺失 / 类型错误 / 工具不存在 / 业务失败），
// 分类结果决定给模型的处置引导。schema 与 handler 同文件维护。

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { filterServerTools } from "../cache-manager.js";
import { writeLog } from "../logger.js";
import type { ServerConnection } from "../server-manager.js";
import { TimeoutError, withTimeout } from "../timeout.js";
import type { ConnectOptions } from "../types.js";
import { locateTool, resolveServerFromToolInput } from "./locate-tool.js";
import { config, disabledServerText, serverManager } from "./runtime.js";

const ExecuteToolArgsSchema = z.object({
  tool: z.string().min(1, "tool 不能为空"),
  server: z.string().optional(),
  arguments: z.record(z.string(), z.unknown()).optional().default({}),
});

type ExecuteErrorType =
  | "tool_not_found"
  | "missing_param"
  | "type_error"
  | "connection_lost"
  | "business";

/** 提取错误对象上的机器可读错误码（McpError.code 或 Node 网络错误的 errno 字符串） */
function errorCodeOf(err: unknown): string | number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" || typeof code === "number"
    ? code
    : undefined;
}

function classifyError(err: Error): ExecuteErrorType {
  const msg = err.message.toLowerCase();

  // 连接层错误优先判定：这类错误的引导文案和"业务失败"完全不同，
  // 而且绝不能落到参数类错误分支上去。
  //
  // 判定以**错误码**为主而不是靠匹配错误文本：底层工具完全可能返回一句
  // 带 "connection closed" 的业务错误（比如数据库连接池报错），
  // 按文本匹配会把业务失败误判成网关侧断连，给出错误的处置建议。
  const code = errorCodeOf(err);
  if (code === ErrorCode.ConnectionClosed) return "connection_lost";
  if (code === "ECONNRESET" || code === "EPIPE") return "connection_lost";
  // SDK 在 transport 已释放时抛的是这个字面量错误，做全等匹配避免误伤业务文案
  if (msg === "not connected") return "connection_lost";

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

export function registerExecuteTool(mcpServer: McpServer): void {
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
        // 无缓存兜底路径同样尊重 includeTools/excludeTools：被排除的工具不可执行
        const targetCfg = config.mcpServers[resolved.server];
        if (
          targetCfg &&
          filterServerTools([{ name: resolved.tool }], targetCfg).length === 0
        ) {
          throw new Error(
            `[mcp-adapter] 工具 "${resolved.tool}" 已被服务 [${resolved.server}] 的 includeTools/excludeTools 配置排除，无法执行。如需恢复请调整 config.json 中的过滤配置。`,
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
          failureBackoffMs: config.settings?.failureBackoffMs,
        };
        conn = await serverManager.connect(serverName, serverConfig, options);
      } catch (err) {
        throw new Error(
          `[mcp-adapter] 唤醒子进程 [${serverName}] 失败: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      serverManager.retain(conn);
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
          case "connection_lost":
            // 网关不自动重试：无法判断这次调用是否已经在底层产生了副作用，
            // 替模型重试可能让非幂等操作执行两次。是否重试交给发起方决定。
            userMsg =
              `[mcp-adapter] 与 [${serverName}] 的连接已断开（可能是子进程崩溃、被系统回收或网络中断），该连接已被回收。` +
              `原始错误: ${rawMsg}。` +
              `如果这次操作是幂等的（查询/读取类），直接重新调用一次即可，网关会自动冷启动新连接；` +
              `如果可能已产生副作用（写入/提交/删除类），请先确认执行结果再决定是否重试。`;
            break;
          default:
            userMsg = rawMsg;
        }

        throw new Error(userMsg);
      } finally {
        if (shouldDropConnection) {
          // 超时说明这条连接可能已经损坏：标记退役让它不再被复用，
          // 但不在途请求结束前不做物理关闭。直接 force close 会让 SDK 把
          // 同一 server 上所有 pending 请求一起 reject，误杀无关的并发调用。
          serverManager.retire(serverName, conn);
        }

        await serverManager.release(conn, closeTimeoutMs);

        writeLog(
          `[HitRate] ${serverName}.${originalName} | cache=${cacheHit ? "hit" : "miss"} | ${Date.now() - startTime}ms\n`,
        );
      }
    },
  );
}
