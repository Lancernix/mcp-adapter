import type { CachedTool, JsonSchema, ServerConfig } from "./types.js";
export type ToolSearchMatchKind = "fuzzy" | "token_fallback" | "server_browse";
export interface ToolSearchResult {
    server: string;
    tool: string;
    qualifiedName: string;
    description: string;
    inputSchema?: JsonSchema;
    score: number;
    matchKind: ToolSearchMatchKind;
    matchReasons?: string[];
}
export declare class SearchIndex {
    private fuse;
    private documents;
    buildIndex(servers: Record<string, ServerConfig>, cachedServers: Record<string, {
        tools: CachedTool[];
    }>): void;
    search(query: string, targetServer?: string, limit?: number): ToolSearchResult[];
    /**
     * Token 命中 fallback：Fuse 无结果时，按 query token 在各字段的命中数分层评分。
     * scoped 基础分 35，全局基础分 0；低于阈值不返回。
     */
    private tokenMatchFallback;
    private findServersMentionedInQuery;
    /**
     * 通用文档浏览：从候选 docs 中取前 N 个，统一返回 server_browse。
     */
    private browseDocs;
    /**
     * 返回指定 server 下的前 N 个工具作为兜底浏览结果。
     */
    browseServer(serverName: string, limit?: number): ToolSearchResult[];
}
