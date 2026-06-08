import os from "node:os";
import path from "node:path";
import { ServerConfigSchema } from "../../config-schema.js";
import { isRecord } from "../common.js";
import type { ClientConfigAdapter, NormalizeResult } from "../types.js";

export const claudeAdapter: ClientConfigAdapter = {
  name: "claude",
  displayName: "Claude Code",
  defaultConfigPaths() {
    return [path.join(os.homedir(), ".claude.json")];
  },
  detect(config: unknown): boolean {
    return isRecord(config) && isRecord(config.mcpServers);
  },
  extractServers(config: unknown): Record<string, unknown> {
    if (!isRecord(config) || !isRecord(config.mcpServers)) return {};
    return config.mcpServers;
  },
  normalizeServer(_name: string, raw: unknown): NormalizeResult {
    const parsed = ServerConfigSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        reason: parsed.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; "),
      };
    }
    return { ok: true, server: parsed.data };
  },
  buildAdapterEntry({ adapterHomeEnv }: { adapterHomeEnv: string }): unknown {
    return {
      command: "npx",
      args: ["-y", "@lancernix/mcp-adapter@latest"],
      env: {
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
      mcpServers: {
        "mcp-adapter": entry,
      },
    };
  },
  describeInstallTarget(): string {
    return `mcpServers["mcp-adapter"]`;
  },
};
