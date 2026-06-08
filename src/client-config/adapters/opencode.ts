import os from "node:os";
import path from "node:path";
import type { ServerConfig } from "../../types.js";
import { isRecord } from "../common.js";
import type { ClientConfigAdapter, NormalizeResult } from "../types.js";

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") return undefined;
    result[key] = item;
  }
  return result;
}

function normalizeLocalServer(raw: Record<string, unknown>): NormalizeResult {
  const command = raw.command;
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    !command.every((item) => typeof item === "string")
  ) {
    return {
      ok: false,
      reason: "OpenCode local MCP requires command as a non-empty string array",
    };
  }

  const env = stringRecord(raw.environment);
  if (raw.environment !== undefined && !env) {
    return {
      ok: false,
      reason: "OpenCode local MCP environment must be a string map",
    };
  }

  const server: ServerConfig = {
    type: "stdio",
    command: command[0],
    args: command.slice(1),
  };

  if (env) server.env = env;
  if (raw.enabled === false) server.disabled = true;

  return { ok: true, server };
}

function normalizeRemoteServer(raw: Record<string, unknown>): NormalizeResult {
  if (typeof raw.url !== "string" || raw.url.length === 0) {
    return { ok: false, reason: "OpenCode remote MCP requires url" };
  }

  if (raw.oauth !== undefined && raw.oauth !== false) {
    return {
      ok: false,
      reason: "OpenCode OAuth remote MCP cannot be migrated automatically",
    };
  }

  const headers = stringRecord(raw.headers);
  if (raw.headers !== undefined && !headers) {
    return {
      ok: false,
      reason: "OpenCode remote MCP headers must be a string map",
    };
  }

  const server: ServerConfig = {
    type: "http",
    url: raw.url,
  };

  if (headers) server.headers = headers;
  if (raw.enabled === false) server.disabled = true;

  return { ok: true, server };
}

export const opencodeAdapter: ClientConfigAdapter = {
  name: "opencode",
  displayName: "OpenCode",
  defaultConfigPaths() {
    const paths: string[] = [];
    if (process.env.OPENCODE_CONFIG) paths.push(process.env.OPENCODE_CONFIG);
    paths.push(path.join(os.homedir(), ".config", "opencode", "opencode.json"));
    return paths;
  },
  detect(config: unknown): boolean {
    return isRecord(config) && isRecord(config.mcp);
  },
  extractServers(config: unknown): Record<string, unknown> {
    if (!isRecord(config) || !isRecord(config.mcp)) return {};
    return config.mcp;
  },
  normalizeServer(_name: string, raw: unknown): NormalizeResult {
    if (!isRecord(raw))
      return { ok: false, reason: "OpenCode MCP entry must be an object" };
    if (raw.type === "local") return normalizeLocalServer(raw);
    if (raw.type === "remote") return normalizeRemoteServer(raw);
    return { ok: false, reason: "OpenCode MCP type must be local or remote" };
  },
  buildAdapterEntry({ adapterHomeEnv }: { adapterHomeEnv: string }): unknown {
    return {
      type: "local",
      command: ["npx", "-y", "@lancernix/mcp-adapter@latest"],
      environment: {
        MCP_ADAPTER_HOME: adapterHomeEnv,
      },
    };
  },
  installAdapterEntry(
    config: Record<string, unknown>,
    entry: unknown,
  ): Record<string, unknown> {
    return {
      ...config,
      mcp: {
        "mcp-adapter": entry,
      },
    };
  },
  describeInstallTarget(): string {
    return `mcp["mcp-adapter"]`;
  },
};
