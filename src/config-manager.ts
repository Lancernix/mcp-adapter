// config-manager.ts - Configuration management for @lancernix/mcp-adapter
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import { AdapterConfigSchema } from "./config-schema.js";
import { normalizeForSearch } from "./search-utils.js";
import type {
  AdapterConfig,
  GlobalSettings,
  ServerConfig,
  ServerResolveResult,
} from "./types.js";

function resolveHomePath(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return path.resolve(input);
}

export function getMcpAdapterHome(): string {
  if (process.env.MCP_ADAPTER_HOME) {
    return resolveHomePath(process.env.MCP_ADAPTER_HOME);
  }
  return path.join(os.homedir(), ".mcp-adapter");
}

export function getConfigPath(): string {
  return path.join(getMcpAdapterHome(), "config.json");
}

export function getCachePath(): string {
  return path.join(getMcpAdapterHome(), "cache.json");
}

export function getLogsDir(): string {
  return path.join(getMcpAdapterHome(), "logs");
}

export function ensureDirs(): void {
  const home = getMcpAdapterHome();
  const logs = getLogsDir();

  if (!fs.existsSync(home)) {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  }
  if (!fs.existsSync(logs)) {
    fs.mkdirSync(logs, { recursive: true, mode: 0o700 });
  }

  try {
    fs.chmodSync(home, 0o700);
  } catch {}
  try {
    fs.chmodSync(logs, 0o700);
  } catch {}
}

export function ensureConfigFile(): void {
  ensureDirs();
  const configPath = getConfigPath();

  if (!fs.existsSync(configPath)) {
    const defaultTemplate: AdapterConfig = {
      version: 1,
      settings: {
        idleTimeout: 10,
        cacheTtlDays: 7,
        toolSearchLimit: 10,
        startupMetadataCheck: true,
        debug: false,
        connectTimeoutMs: 60000,
        requestTimeoutMs: 60000,
        closeTimeoutMs: 10000,
        failureBackoffMs: 60000,
      },
      mcpServers: {},
    };

    fs.writeFileSync(configPath, JSON.stringify(defaultTemplate, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
    try {
      fs.chmodSync(configPath, 0o600);
    } catch {}
  } else {
    try {
      fs.chmodSync(configPath, 0o600);
    } catch {}
  }
}

function formatZodError(err: z.ZodError): string {
  return err.issues.map((i) => `[${i.path.join(".")}] ${i.message}`).join("; ");
}

// ---- 配置字段迁移 ----
//
// 这是整个兼容层的唯一入口。业务代码里不允许出现 `if (metadataBootstrap)` 之类的
// 分支：旧字段在 loadConfig() 返回前就被改写成新字段并删除，下游只有一个数据源。
// 写入路径（ensureConfigFile 的模板、saveConfig、import）一律只产出新字段，
// 所以任何一次落盘都会顺带完成迁移。等下一个主版本再删掉这里的兼容分支。

const configMigrationNotes: string[] = [];

/**
 * 取出并清空本次配置加载产生的迁移提示。
 * 由调用方（index.ts 的 initialize）负责写日志，避免 config-manager 反向依赖 logger。
 */
export function takeConfigMigrationNotes(): string[] {
  return configMigrationNotes.splice(0, configMigrationNotes.length);
}

function migrateLegacySettings(config: AdapterConfig): void {
  const settings = config.settings as
    | (GlobalSettings & Record<string, unknown>)
    | undefined;
  if (!settings) return;

  // JSON 里不存在 undefined，字段缺失与字段有值可以直接区分
  const legacy = settings.metadataBootstrap;
  if (legacy === undefined) return;

  if (settings.startupMetadataCheck === undefined) {
    settings.startupMetadataCheck = legacy !== "off";
    configMigrationNotes.push(
      `settings.metadataBootstrap 已更名为 settings.startupMetadataCheck` +
        `（${legacy} → ${settings.startupMetadataCheck}），本次已按新语义生效。` +
        `请把 config.json 中的 metadataBootstrap 改写为 startupMetadataCheck 以消除本提示`,
    );
  } else {
    configMigrationNotes.push(
      `settings.metadataBootstrap 已废弃，且与 settings.startupMetadataCheck 同时存在。` +
        `已按 startupMetadataCheck=${settings.startupMetadataCheck} 生效，请删除 metadataBootstrap`,
    );
  }

  // 归一化后立即删除旧字段，保证运行期对象里不存在两个同义字段
  delete settings.metadataBootstrap;
}

export function loadConfig(): AdapterConfig {
  ensureConfigFile();
  const configPath = getConfigPath();
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    const config = AdapterConfigSchema.parse(parsed) as AdapterConfig;
    migrateLegacySettings(config);
    return config;
  } catch (err) {
    if (err instanceof z.ZodError) {
      throw new Error(`config.json 格式校验失败: ${formatZodError(err)}`);
    }
    throw new Error(
      `无法读取或解析 config.json: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export function saveConfig(config: AdapterConfig): void {
  ensureDirs();
  const configPath = getConfigPath();
  const tmpPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;

  try {
    const validated = AdapterConfigSchema.parse(config);
    fs.writeFileSync(tmpPath, JSON.stringify(validated, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
    fs.renameSync(tmpPath, configPath);
    try {
      fs.chmodSync(configPath, 0o600);
    } catch {}
  } catch (err) {
    if (fs.existsSync(tmpPath)) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {}
    }
    if (err instanceof z.ZodError) {
      throw new Error(
        `保存 config.json 失败，配置格式非法: ${formatZodError(err)}`,
      );
    }
    throw new Error(
      `保存 config.json 失败: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * 构建子进程环境变量，过滤 process.env 中的 undefined 值。
 * inheritEnv 为 false 时不继承宿主进程的任意环境变量，仅保留 SDK 的跨平台
 * 安全默认集（HOME/PATH 等）与显式配置的 env；注意这不是空环境，也不是 OS 沙箱。
 */
export function buildChildEnv(
  extra?: Record<string, string>,
  inheritEnv: boolean = true,
): Record<string, string> {
  const env: Record<string, string> = {};

  if (inheritEnv) {
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) {
        env[key] = value;
      }
    }
  } else {
    for (const [key, value] of Object.entries(getDefaultEnvironment())) {
      if (value !== undefined) {
        env[key] = value;
      }
    }
  }

  for (const [key, value] of Object.entries(extra ?? {})) {
    env[key] = value;
  }

  return env;
}

/**
 * 解析 cwd 路径，支持 ~ 和 ~/path 展开
 */
export function resolveCwd(cwd?: string): string {
  if (!cwd) return process.cwd();

  if (cwd === "~") return os.homedir();

  if (cwd.startsWith("~/")) {
    return path.join(os.homedir(), cwd.slice(2));
  }

  return path.resolve(cwd);
}

/**
 * 根据输入的别名、或者是原始名字来精准定位真实的 server 键值
 */
export function resolveServerName(
  input: string,
  servers: Record<string, ServerConfig>,
): string | null {
  const q = normalizeForSearch(input);

  for (const [serverName, config] of Object.entries(servers)) {
    if (normalizeForSearch(serverName) === q) {
      return serverName;
    }

    if (config.aliases) {
      for (const alias of config.aliases) {
        if (normalizeForSearch(alias) === q) {
          return serverName;
        }
      }
    }
  }

  return null;
}

/**
 * 从 server key 自动生成变体（分隔符归一化为空格后的形式）
 * 例如: "dingtalk-doc" → ["dingtalk doc"]
 */
function generateServerNameVariants(name: string): string[] {
  const n = normalizeForSearch(name);
  const original = name.trim().toLowerCase();
  if (n !== original && n !== original.replace(/\s+/g, " ")) {
    return [n];
  }
  return [];
}

/**
 * 带置信度的 server hint 解析。用于 search_tools 的 server 参数。
 * 与 resolveServerName 不同的是，它支持变体匹配、歧义检测和部分匹配，
 * 并返回置信度分级结果。
 */
export function resolveServerHint(
  input: string,
  servers: Record<string, ServerConfig>,
): ServerResolveResult {
  const result: ServerResolveResult = {
    original: input,
    resolvedServer: null,
    confidence: "none",
    candidates: [],
    reason: "",
  };

  const q = normalizeForSearch(input);
  if (!q) {
    result.reason = "输入为空";
    return result;
  }

  // 1. Exact canonical server key 匹配
  for (const [serverName] of Object.entries(servers)) {
    if (normalizeForSearch(serverName) === q) {
      result.resolvedServer = serverName;
      result.confidence = "high";
      result.candidates = [serverName];
      result.reason = `精确匹配 server key "${serverName}"`;
      return result;
    }
  }

  // 2. Exact alias 匹配
  const aliasMatches: string[] = [];
  for (const [serverName, cfg] of Object.entries(servers)) {
    if (cfg.aliases) {
      for (const alias of cfg.aliases) {
        if (normalizeForSearch(alias) === q) {
          if (!aliasMatches.includes(serverName)) {
            aliasMatches.push(serverName);
          }
        }
      }
    }
  }

  if (aliasMatches.length === 1) {
    result.resolvedServer = aliasMatches[0];
    result.confidence = "high";
    result.candidates = aliasMatches;
    result.reason = `精确匹配别名，指向 server "${aliasMatches[0]}"`;
    return result;
  }

  if (aliasMatches.length > 1) {
    result.confidence = "medium";
    result.candidates = aliasMatches;
    result.reason = `别名 "${input}" 匹配到 ${aliasMatches.length} 个 server，存在歧义: ${aliasMatches.join(", ")}`;
    return result;
  }

  // 3. Variant 匹配（分隔符归一化后的等价形式）
  const variantMatches: string[] = [];
  for (const [serverName, cfg] of Object.entries(servers)) {
    for (const variant of generateServerNameVariants(serverName)) {
      if (variant === q) {
        variantMatches.push(serverName);
        break;
      }
    }
    if (cfg.aliases) {
      for (const alias of cfg.aliases) {
        for (const variant of generateServerNameVariants(alias)) {
          if (variant === q) {
            if (!variantMatches.includes(serverName)) {
              variantMatches.push(serverName);
            }
            break;
          }
        }
      }
    }
  }

  if (variantMatches.length === 1) {
    result.resolvedServer = variantMatches[0];
    result.confidence = "medium";
    result.candidates = variantMatches;
    result.reason = `变体匹配，指向 server "${variantMatches[0]}"`;
    return result;
  }

  if (variantMatches.length > 1) {
    result.confidence = "medium";
    result.candidates = variantMatches;
    result.reason = `变体匹配到 ${variantMatches.length} 个 server，存在歧义: ${variantMatches.join(", ")}`;
    return result;
  }

  // 4. 部分匹配（低置信）：input 是服务名或别名的子串
  if (q.length >= 3) {
    const partialMatches: string[] = [];
    for (const [serverName, cfg] of Object.entries(servers)) {
      const names = [serverName, ...(cfg.aliases || [])];
      for (const name of names) {
        if (normalizeForSearch(name).includes(q)) {
          partialMatches.push(serverName);
          break;
        }
      }
    }

    if (partialMatches.length === 1) {
      result.resolvedServer = partialMatches[0];
      result.confidence = "low";
      result.candidates = partialMatches;
      result.reason = `部分匹配，指向 server "${partialMatches[0]}"`;
      return result;
    }

    if (partialMatches.length > 1) {
      result.confidence = "low";
      result.candidates = partialMatches;
      result.reason = `部分匹配到 ${partialMatches.length} 个 server: ${partialMatches.join(", ")}`;
      return result;
    }
  }

  result.reason = `未找到匹配 "${input}" 的服务`;
  return result;
}
