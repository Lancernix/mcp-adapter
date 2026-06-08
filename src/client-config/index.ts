import { claudeAdapter } from "./adapters/claude.js";
import { opencodeAdapter } from "./adapters/opencode.js";
import type { ClientConfigAdapter, ClientName } from "./types.js";

export const CLIENT_CONFIG_ADAPTERS: ClientConfigAdapter[] = [
  claudeAdapter,
  opencodeAdapter,
];

export function getClientConfigAdapter(
  name: string,
): ClientConfigAdapter | undefined {
  return CLIENT_CONFIG_ADAPTERS.find((adapter) => adapter.name === name);
}

export function isKnownClientName(name: string): name is ClientName {
  return CLIENT_CONFIG_ADAPTERS.some((adapter) => adapter.name === name);
}

export type {
  ClientConfigAdapter,
  ClientName,
  ImportedServer,
  ImportPlan,
  NormalizeResult,
  SkippedServer,
} from "./types.js";
