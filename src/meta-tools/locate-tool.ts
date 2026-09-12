// locate-tool.ts - 工具名定位（describe_tool / execute_tool 共享）
//
// 全部是无状态纯函数：从"输入字符串 + server 提示"解析出目标 server 与工具名，
// 再到有效缓存里查找匹配。读 config 走 runtime 的 live binding。

import { getValidCachedServers, loadMetadataCache } from "../cache-manager.js";
import { resolveServerName } from "../config-manager.js";
import type { JsonSchema } from "../types.js";
import { config } from "./runtime.js";

export function parseQualifiedToolInput(
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

export function resolveServerFromToolInput(
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

export function locateTool(
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
