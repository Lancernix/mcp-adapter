// version.ts - Gateway version shared by the MCP server and client identities
import { createRequire } from "node:module";

// src/ 与 dist/ 都在包根的下一级，tsx 直跑与构建后该相对路径一致
const pkgJson = createRequire(import.meta.url)("../package.json") as {
  version: string;
};

/**
 * 网关对外暴露的版本号，取自 package.json。
 * MCP Server 身份与 MCP Client 身份共用，避免两处硬编码漂移。
 */
export const GATEWAY_VERSION: string = pkgJson.version;
