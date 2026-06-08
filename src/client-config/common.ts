import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type ParseError, parse, printParseErrorCode } from "jsonc-parser";
import type { ClientName } from "./types.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function resolveUserPath(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return path.resolve(input);
}

export function readJsonLike(filePath: string): Record<string, unknown> {
  const raw = fs.readFileSync(filePath, "utf-8");
  const errors: ParseError[] = [];
  const parsed: unknown = parse(raw, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });

  if (errors.length > 0) {
    const message = errors
      .map((err) => `${printParseErrorCode(err.error)} at offset ${err.offset}`)
      .join("; ");
    throw new Error(`配置文件不是合法 JSON/JSONC: ${message}`);
  }

  if (!isRecord(parsed)) {
    throw new Error("配置文件根节点必须是 JSON object");
  }

  return parsed;
}

export function writeJsonAtomic(filePath: string, value: unknown): void {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });
  fs.renameSync(tmpPath, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {}
}

export function getDefaultAdapterHome(clientName: ClientName): {
  actual: string;
  env: string;
} {
  if (process.env.MCP_ADAPTER_HOME) {
    const env = process.env.MCP_ADAPTER_HOME;
    return { actual: resolveUserPath(env), env };
  }

  if (clientName === "claude") {
    return {
      actual: path.join(os.homedir(), ".mcp-adapter"),
      env: "~/.mcp-adapter",
    };
  }

  return {
    actual: path.join(os.homedir(), `.mcp-adapter-${clientName}`),
    env: `~/.mcp-adapter-${clientName}`,
  };
}
