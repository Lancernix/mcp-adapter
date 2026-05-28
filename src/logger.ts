// logger.ts - 统一日志工具：始终写 stderr；debug=true 时额外写入文件
import fs from "node:fs";
import path from "node:path";
import { getLogsDir } from "./config-manager.js";
import type { AdapterConfig } from "./types.js";

let configRef: (() => AdapterConfig | undefined) | null = null;

export function setConfigRef(fn: () => AdapterConfig | undefined): void {
  configRef = fn;
}

export function writeLog(message: string): void {
  const normalized = message.replace(/\n+$/g, "");
  const line = `${new Date().toISOString()} ${normalized}\n`;

  process.stderr.write(line);

  const config = configRef?.();
  if (!config?.settings?.debug) return;

  try {
    const logsDir = getLogsDir();
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true, mode: 0o700 });
    }

    const logPath = path.join(logsDir, "mcp-adapter.log");

    fs.appendFileSync(logPath, line, {
      encoding: "utf-8",
      mode: 0o600,
    });

    try {
      fs.chmodSync(logPath, 0o600);
    } catch {}
  } catch {
    // 日志写入失败不影响主链路
  }
}
