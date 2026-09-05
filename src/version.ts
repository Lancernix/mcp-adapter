// version.ts - Gateway version shared by the MCP server and client identities
import { readFileSync } from "node:fs";

// src/ 与 dist/ 都在包根的下一级，tsx 直跑与构建后该相对路径一致。
// 直接读文件而不是 createRequire：require 解析受 package.json 的 exports
// 字段约束，将来若加了 exports 且未显式导出 "./package.json"，require 会抛
// ERR_PACKAGE_PATH_NOT_EXPORTED 导致网关启动即挂；文件读取不受影响。
const pkgJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
) as { version: string };

/**
 * 网关对外暴露的版本号，取自 package.json。
 * MCP Server 身份与 MCP Client 身份共用，避免两处硬编码漂移。
 */
export const GATEWAY_VERSION: string = pkgJson.version;
