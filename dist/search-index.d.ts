import type { ServerConfig, CachedTool } from "./types.js";
export declare class SearchIndex {
    private fuse;
    private documents;
    /**
     * 根据从 cache.json 中加载的、所有有效服务器的工具列表，构建本地模糊搜索文档与索引
     */
    buildIndex(servers: Record<string, ServerConfig>, cachedServers: Record<string, {
        tools: CachedTool[];
    }>): void;
    /**
     * 检索符合条件的工具
     */
    search(query: string, targetServer?: string, limit?: number): Array<{
        server: string;
        tool: string;
        qualifiedName: string;
        description: string;
        score: number;
    }>;
    /**
     * 检测 query 文本中是否包含任何注册的服务器名或别名
     */
    private findServersMentionedInQuery;
}
