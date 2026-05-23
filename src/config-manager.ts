// config-manager.ts - Configuration management for @lancernix/mcp-adapter
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { AdapterConfig, ServerConfig } from "./types.js";

export function getMcpAdapterHome(): string {
  if (process.env.MCP_ADAPTER_HOME) {
    return path.resolve(process.env.MCP_ADAPTER_HOME);
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
        enableFuseSearch: true
      },
      mcpServers: {}
    };
    
    fs.writeFileSync(
      configPath, 
      JSON.stringify(defaultTemplate, null, 2), 
      { encoding: "utf-8", mode: 0o600 }
    );
  }
}

export function loadConfig(): AdapterConfig {
  ensureConfigFile();
  const configPath = getConfigPath();
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    return JSON.parse(raw) as AdapterConfig;
  } catch (err: any) {
    throw new Error(`无法读取或解析 config.json: ${err.message}`);
  }
}

export function saveConfig(config: AdapterConfig): void {
  ensureDirs();
  const configPath = getConfigPath();
  try {
    fs.writeFileSync(
      configPath, 
      JSON.stringify(config, null, 2), 
      { encoding: "utf-8", mode: 0o600 }
    );
  } catch (err: any) {
    throw new Error(`保存 config.json 失败: ${err.message}`);
  }
}

/**
 * 统一做小写与归一化处理，防止中英文符号和空格大小写差异
 */
export function normalize(str: string): string {
  return str.trim().toLowerCase()
    .replace(/[-_\s]+/g, " "); // 把所有的中横线、下划线、多个空格归一化为单个空格
}

/**
 * 根据输入的别名、或者是原始名字来精准定位真实的 server 键值
 */
export function resolveServerName(
  input: string,
  servers: Record<string, ServerConfig>
): string | null {
  const q = normalize(input);

  for (const [serverName, config] of Object.entries(servers)) {
    if (normalize(serverName) === q) {
      return serverName;
    }

    if (config.aliases) {
      for (const alias of config.aliases) {
        if (normalize(alias) === q) {
          return serverName;
        }
      }
    }
  }

  return null;
}
