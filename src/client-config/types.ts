import type { ServerConfig } from "../types.js";

export type ClientName = "claude" | "opencode";

export type NormalizeResult =
  | { ok: true; server: ServerConfig }
  | { ok: false; reason: string };

export interface ClientConfigAdapter {
  name: ClientName;
  displayName: string;
  defaultConfigPaths(): string[];
  detect(config: unknown): boolean;
  extractServers(config: unknown): Record<string, unknown>;
  normalizeServer(name: string, raw: unknown): NormalizeResult;
  buildAdapterEntry(options: { adapterHomeEnv: string }): unknown;
  installAdapterEntry(
    config: Record<string, unknown>,
    entry: unknown,
  ): Record<string, unknown>;
  describeInstallTarget(): string;
}

export interface ImportedServer {
  name: string;
  server: ServerConfig;
}

export interface SkippedServer {
  name: string;
  reason: string;
}

export interface ImportPlan {
  client: ClientConfigAdapter;
  sourcePath: string;
  adapterHomeActual: string;
  adapterHomeEnv: string;
  adapterConfigPath: string;
  importedServers: ImportedServer[];
  skippedServers: SkippedServer[];
  clientConfigBefore: Record<string, unknown>;
  clientConfigAfter: Record<string, unknown>;
  adapterEntry: unknown;
}
