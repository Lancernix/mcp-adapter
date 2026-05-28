import type { AdapterConfig, ServerConfig } from "./types.js";
export declare function getMcpAdapterHome(): string;
export declare function getConfigPath(): string;
export declare function getCachePath(): string;
export declare function getLogsDir(): string;
export declare function ensureDirs(): void;
export declare function ensureConfigFile(): void;
export declare function loadConfig(): AdapterConfig;
export declare function saveConfig(config: AdapterConfig): void;
/**
 * 统一做小写与归一化处理，防止中英文符号和空格大小写差异
 */
export declare function normalize(str: string): string;
/**
 * 构建子进程环境变量，过滤 process.env 中的 undefined 值
 */
export declare function buildChildEnv(extra?: Record<string, string>): Record<string, string>;
/**
 * 解析 cwd 路径，支持 ~ 和 ~/path 展开
 */
export declare function resolveCwd(cwd?: string): string;
/**
 * 根据输入的别名、或者是原始名字来精准定位真实的 server 键值
 */
export declare function resolveServerName(input: string, servers: Record<string, ServerConfig>): string | null;
