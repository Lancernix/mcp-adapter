// config-manager.ts - Configuration management for @lancernix/mcp-adapter
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { AdapterConfigSchema } from "./config-schema.js";
export function getMcpAdapterHome() {
    if (process.env.MCP_ADAPTER_HOME) {
        return path.resolve(process.env.MCP_ADAPTER_HOME);
    }
    return path.join(os.homedir(), ".mcp-adapter");
}
export function getConfigPath() {
    return path.join(getMcpAdapterHome(), "config.json");
}
export function getCachePath() {
    return path.join(getMcpAdapterHome(), "cache.json");
}
export function getLogsDir() {
    return path.join(getMcpAdapterHome(), "logs");
}
export function ensureDirs() {
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
    }
    catch { }
    try {
        fs.chmodSync(logs, 0o700);
    }
    catch { }
}
export function ensureConfigFile() {
    ensureDirs();
    const configPath = getConfigPath();
    if (!fs.existsSync(configPath)) {
        const defaultTemplate = {
            version: 1,
            settings: {
                idleTimeout: 10,
                cacheTtlDays: 7,
                toolSearchLimit: 10,
                metadataBootstrap: "background",
                debug: false,
                connectTimeoutMs: 60000,
                requestTimeoutMs: 60000,
                closeTimeoutMs: 10000,
            },
            mcpServers: {},
        };
        fs.writeFileSync(configPath, JSON.stringify(defaultTemplate, null, 2), {
            encoding: "utf-8",
            mode: 0o600,
        });
        try {
            fs.chmodSync(configPath, 0o600);
        }
        catch { }
    }
    else {
        try {
            fs.chmodSync(configPath, 0o600);
        }
        catch { }
    }
}
function formatZodError(err) {
    return err.issues.map((i) => `[${i.path.join(".")}] ${i.message}`).join("; ");
}
export function loadConfig() {
    ensureConfigFile();
    const configPath = getConfigPath();
    try {
        const raw = fs.readFileSync(configPath, "utf-8");
        const parsed = JSON.parse(raw);
        return AdapterConfigSchema.parse(parsed);
    }
    catch (err) {
        if (err instanceof z.ZodError) {
            throw new Error(`config.json 格式校验失败: ${formatZodError(err)}`);
        }
        throw new Error(`无法读取或解析 config.json: ${err instanceof Error ? err.message : String(err)}`);
    }
}
export function saveConfig(config) {
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
        }
        catch { }
    }
    catch (err) {
        if (fs.existsSync(tmpPath)) {
            try {
                fs.unlinkSync(tmpPath);
            }
            catch { }
        }
        if (err instanceof z.ZodError) {
            throw new Error(`保存 config.json 失败，配置格式非法: ${formatZodError(err)}`);
        }
        throw new Error(`保存 config.json 失败: ${err instanceof Error ? err.message : String(err)}`);
    }
}
/**
 * 统一做小写与归一化处理，防止中英文符号和空格大小写差异
 */
export function normalize(str) {
    return str
        .trim()
        .toLowerCase()
        .replace(/[-_./:\s]+/g, " "); // 归一化分隔符为单个空格
}
/**
 * 构建子进程环境变量，过滤 process.env 中的 undefined 值
 */
export function buildChildEnv(extra) {
    const env = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined) {
            env[key] = value;
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
export function resolveCwd(cwd) {
    if (!cwd)
        return process.cwd();
    if (cwd === "~")
        return os.homedir();
    if (cwd.startsWith("~/")) {
        return path.join(os.homedir(), cwd.slice(2));
    }
    return path.resolve(cwd);
}
/**
 * 根据输入的别名、或者是原始名字来精准定位真实的 server 键值
 */
export function resolveServerName(input, servers) {
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
