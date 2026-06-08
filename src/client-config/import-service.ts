import { getConfigPath, loadConfig, saveConfig } from "../config-manager.js";
import type { ServerConfig } from "../types.js";
import {
  getDefaultAdapterHome,
  readJsonLike,
  resolveUserPath,
  writeJsonAtomic,
} from "./common.js";
import {
  CLIENT_CONFIG_ADAPTERS,
  getClientConfigAdapter,
  isKnownClientName,
} from "./index.js";
import type {
  ClientConfigAdapter,
  ClientName,
  ImportedServer,
  ImportPlan,
  SkippedServer,
} from "./types.js";

export type DetectedClientConfig = {
  client: ClientConfigAdapter;
  path: string;
};

function normalizeClientName(input: string): ClientName {
  const normalized = input.trim().toLowerCase();
  if (!isKnownClientName(normalized)) {
    throw new Error(
      `未知 client: ${input}。当前支持: ${CLIENT_CONFIG_ADAPTERS.map((adapter) => adapter.name).join(", ")}`,
    );
  }
  return normalized;
}

function isLikelyMcpAdapterSelf(name: string, raw: unknown): boolean {
  return name === "mcp-adapter" || JSON.stringify(raw).includes("mcp-adapter");
}

function withImportDefaults(name: string, server: ServerConfig): ServerConfig {
  const aliasSet = new Set<string>([name]);
  for (const part of name.split(/[-_\s]+/)) {
    if (part.length > 2) aliasSet.add(part);
  }

  const existingAliases = Array.isArray(server.aliases) ? server.aliases : [];
  return {
    ...server,
    lifecycle: server.lifecycle ?? "lazy",
    aliases: Array.from(new Set([...existingAliases, ...aliasSet])),
  };
}

function previewJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function detectClientConfigs(): DetectedClientConfig[] {
  const detected: DetectedClientConfig[] = [];

  for (const client of CLIENT_CONFIG_ADAPTERS) {
    for (const candidatePath of client.defaultConfigPaths()) {
      try {
        const resolvedPath = resolveUserPath(candidatePath);
        const config = readJsonLike(resolvedPath);
        if (client.detect(config)) {
          detected.push({ client, path: resolvedPath });
        }
      } catch {}
    }
  }

  return detected;
}

export function inferClientFromDefaultPath(
  fromPath: string,
): DetectedClientConfig | undefined {
  const resolvedFromPath = resolveUserPath(fromPath);
  for (const client of CLIENT_CONFIG_ADAPTERS) {
    for (const candidatePath of client.defaultConfigPaths()) {
      if (resolveUserPath(candidatePath) === resolvedFromPath) {
        return { client, path: resolvedFromPath };
      }
    }
  }
  return undefined;
}

export function getDefaultConfigForClient(
  clientName: string,
): string | undefined {
  const client = getClientConfigAdapter(normalizeClientName(clientName));
  if (!client) return undefined;

  for (const candidatePath of client.defaultConfigPaths()) {
    try {
      const resolvedPath = resolveUserPath(candidatePath);
      const config = readJsonLike(resolvedPath);
      if (client.detect(config)) return resolvedPath;
    } catch {}
  }

  return undefined;
}

export function createImportPlan(options: {
  clientName: string;
  fromPath: string;
}): ImportPlan {
  const clientName = normalizeClientName(options.clientName);
  const client = getClientConfigAdapter(clientName);
  if (!client) throw new Error(`未知 client: ${clientName}`);

  const sourcePath = resolveUserPath(options.fromPath);
  const clientConfigBefore = readJsonLike(sourcePath);
  if (!client.detect(clientConfigBefore)) {
    throw new Error(
      `${sourcePath} 不是有效的 ${client.displayName} MCP 配置，或未找到该 client 的 MCP 配置区域。`,
    );
  }

  const sourceServers = client.extractServers(clientConfigBefore);
  const importedServers: ImportedServer[] = [];
  const skippedServers: SkippedServer[] = [];

  for (const [name, raw] of Object.entries(sourceServers)) {
    if (isLikelyMcpAdapterSelf(name, raw)) {
      skippedServers.push({
        name,
        reason: "疑似 mcp-adapter 自身配置，跳过以避免循环启动",
      });
      continue;
    }

    const normalized = client.normalizeServer(name, raw);
    if (!normalized.ok) {
      skippedServers.push({ name, reason: normalized.reason });
      continue;
    }

    importedServers.push({
      name,
      server: withImportDefaults(name, normalized.server),
    });
  }

  const adapterHome = getDefaultAdapterHome(client.name);
  const previousAdapterHome = process.env.MCP_ADAPTER_HOME;
  process.env.MCP_ADAPTER_HOME = adapterHome.env;
  const adapterConfigPath = getConfigPath();
  if (previousAdapterHome === undefined) {
    delete process.env.MCP_ADAPTER_HOME;
  } else {
    process.env.MCP_ADAPTER_HOME = previousAdapterHome;
  }

  const adapterEntry = client.buildAdapterEntry({
    adapterHomeEnv: adapterHome.env,
  });
  const clientConfigAfter = client.installAdapterEntry(
    clientConfigBefore,
    adapterEntry,
  );

  return {
    client,
    sourcePath,
    adapterHomeActual: adapterHome.actual,
    adapterHomeEnv: adapterHome.env,
    adapterConfigPath,
    importedServers,
    skippedServers,
    clientConfigBefore,
    clientConfigAfter,
    adapterEntry,
  };
}

export function printImportDryRun(plan: ImportPlan): void {
  const importedPreview = plan.importedServers
    .map(
      (item) =>
        `  - ${item.name} (${item.server.type ?? "stdio"}) aliases: [${item.server.aliases?.join(", ")}]`,
    )
    .join("\n");
  const skippedPreview = plan.skippedServers
    .map((item) => `  - ${item.name} [跳过] ${item.reason}`)
    .join("\n");

  process.stdout.write(
    `\n[Import-Source]\n` +
      `client=${plan.client.name} (${plan.client.displayName})\n` +
      `path=${plan.sourcePath}\n\n` +
      `[Import-Adapter-Config]\n` +
      `target=${plan.adapterConfigPath}\n` +
      `adapterHome=${plan.adapterHomeEnv}\n` +
      `imported=${plan.importedServers.length}\n` +
      `skipped=${plan.skippedServers.length}\n\n` +
      `[Import-Servers]\n${importedPreview || "  (none)"}\n\n` +
      `[Import-Skipped]\n${skippedPreview || "  (none)"}\n\n` +
      `[Import-Client-Config]\n` +
      `target=${plan.sourcePath}\n` +
      `install=${plan.client.describeInstallTarget()}\n` +
      `entry=${previewJson(plan.adapterEntry)}\n\n` +
      `注意：此为预览，尚未实际写入配置。\n`,
  );
}

export function applyImportPlan(
  plan: ImportPlan,
  options: { writeClientConfig: boolean },
): void {
  const previousAdapterHome = process.env.MCP_ADAPTER_HOME;
  process.env.MCP_ADAPTER_HOME = plan.adapterHomeEnv;

  try {
    const targetConfig = loadConfig();
    targetConfig.mcpServers = targetConfig.mcpServers || {};

    for (const item of plan.importedServers) {
      targetConfig.mcpServers[item.name] = item.server;
    }

    saveConfig(targetConfig);

    if (options.writeClientConfig) {
      writeJsonAtomic(plan.sourcePath, plan.clientConfigAfter);
    }
  } finally {
    if (previousAdapterHome === undefined) {
      delete process.env.MCP_ADAPTER_HOME;
    } else {
      process.env.MCP_ADAPTER_HOME = previousAdapterHome;
    }
  }
}

export function formatDetectedClientConfigs(
  detected: DetectedClientConfig[],
): string {
  return detected
    .map(
      (source) =>
        `  - ${source.path} (${source.client.displayName}, client=${source.client.name})`,
    )
    .join("\n");
}

export function formatKnownClientPaths(): string {
  return CLIENT_CONFIG_ADAPTERS.flatMap((client) =>
    client
      .defaultConfigPaths()
      .map(
        (candidatePath) =>
          `  - ${resolveUserPath(candidatePath)} (${client.displayName}, client=${client.name})`,
      ),
  ).join("\n");
}
