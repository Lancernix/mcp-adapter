// search-index.ts - Local fuzzy search index powered by Fuse.js
import Fuse from "fuse.js";
import { normalize } from "./config-manager.js";
export class SearchIndex {
    fuse = null;
    documents = [];
    /**
     * 根据从 cache.json 中加载的、所有有效服务器的工具列表，构建本地模糊搜索文档与索引
     */
    buildIndex(servers, cachedServers) {
        this.documents = [];
        for (const [serverName, serverEntry] of Object.entries(cachedServers)) {
            const config = servers[serverName];
            if (!config || config.disabled)
                continue; // 过滤被禁用的服务
            const aliases = config.aliases || [];
            const tools = serverEntry.tools || [];
            for (const tool of tools) {
                const qualifiedName = `${serverName}.${tool.name}`;
                // 拼接综合检索文本，涵盖服务名、别名、工具名、功能描述
                const searchText = [
                    serverName,
                    ...aliases,
                    tool.name,
                    tool.description || ""
                ].join(" ");
                this.documents.push({
                    server: serverName,
                    serverAliases: aliases,
                    name: tool.name,
                    qualifiedName,
                    description: tool.description,
                    searchText
                });
            }
        }
        if (this.documents.length > 0) {
            // 遵照峰哥《改进计划.md》第 12.3 节的黄金加权配比，精细化设置检索权重
            this.fuse = new Fuse(this.documents, {
                includeScore: true,
                ignoreLocation: true,
                threshold: 0.45, // 适当放宽门槛，提供更佳的容错与拼写校正
                keys: [
                    { name: "qualifiedName", weight: 0.35 },
                    { name: "name", weight: 0.25 },
                    { name: "serverAliases", weight: 0.20 },
                    { name: "server", weight: 0.10 },
                    { name: "description", weight: 0.10 }
                ]
            });
        }
        else {
            this.fuse = null;
        }
    }
    /**
     * 检索符合条件的工具
     */
    search(query, targetServer, limit = 10) {
        if (!this.fuse)
            return [];
        let candidates = this.documents;
        // 1. 如果显式指定了 server 参数：先进行 server 名字或别名定位
        if (targetServer) {
            const resolved = targetServer.trim();
            candidates = this.documents.filter(doc => doc.server.toLowerCase() === resolved.toLowerCase() ||
                doc.serverAliases.some(alias => alias.toLowerCase() === resolved.toLowerCase()));
        }
        // 2. 如果未指定 server 参数，但在 query 中提到了某个 server 的别名（Server alias 命中）
        else {
            const mentionedServers = this.findServersMentionedInQuery(query);
            if (mentionedServers.length > 0) {
                candidates = this.documents.filter(doc => mentionedServers.includes(doc.server));
            }
        }
        if (candidates.length === 0)
            return [];
        // 使用筛选后的候选池动态实例化临时 Fuse（如指定了具体 server，能加速检索并防偏）
        let currentFuse = this.fuse;
        if (candidates.length < this.documents.length) {
            currentFuse = new Fuse(candidates, {
                includeScore: true,
                ignoreLocation: true,
                threshold: 0.45,
                keys: [
                    { name: "qualifiedName", weight: 0.35 },
                    { name: "name", weight: 0.25 },
                    { name: "serverAliases", weight: 0.20 },
                    { name: "server", weight: 0.10 },
                    { name: "description", weight: 0.10 }
                ]
            });
        }
        const rawResults = currentFuse.search(query);
        const sliced = rawResults.slice(0, limit);
        return sliced.map(res => {
            const doc = res.item;
            const rawScore = res.score ?? 1;
            // 遵照峰哥《改进计划.md》指示：将 Fuse 的越小越好 (0 = 完美) 统一转化为越接近 100 越精准直观的直觉分数
            const targetScore = Math.round((1 - rawScore) * 100);
            return {
                server: doc.server,
                tool: doc.name,
                qualifiedName: doc.qualifiedName,
                description: doc.description || "",
                score: targetScore
            };
        });
    }
    /**
     * 检测 query 文本中是否包含任何注册的服务器名或别名
     */
    findServersMentionedInQuery(query) {
        const q = normalize(query);
        const matched = [];
        // 我们可以直接根据已构建 of documents 里的 server 信息进行逆向提取
        const uniqueServers = new Map();
        for (const doc of this.documents) {
            if (!uniqueServers.has(doc.server)) {
                uniqueServers.set(doc.server, doc.serverAliases);
            }
        }
        const entries = Array.from(uniqueServers.entries());
        for (const [serverName, aliases] of entries) {
            const names = [serverName, ...aliases].map(normalize);
            if (names.some(name => q.includes(name))) {
                matched.push(serverName);
            }
        }
        return matched;
    }
}
