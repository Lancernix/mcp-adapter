// search-index.ts - Local fuzzy search index powered by Fuse.js

import type { IFuseOptions } from "fuse.js";
import Fuse from "fuse.js";
import {
  findServersInText,
  normalizeForSearch,
  removeMatchedServerTerms,
  tokenizeForSearch,
} from "./search-utils.js";
import type {
  CachedTool,
  JsonSchema,
  ServerConfig,
  ToolSearchDoc,
} from "./types.js";

// ---- Fuse extended types ----

type FuseOptionsWithTokenSearch<T> = IFuseOptions<T> & {
  useTokenSearch?: boolean;
  tokenMatch?: "any" | "all";
  tokenize?: (text: string) => string[];
};

const FUSE_OPTIONS: FuseOptionsWithTokenSearch<ToolSearchDoc> = {
  includeScore: true,
  ignoreLocation: true,
  useTokenSearch: true,
  tokenMatch: "any",
  tokenize: tokenizeForSearch,
  threshold: 0.35,
  keys: [
    { name: "name", weight: 0.4 },
    { name: "serverAliases", weight: 0.2 },
    { name: "description", weight: 0.2 },
    { name: "server", weight: 0.1 },
    { name: "qualifiedName", weight: 0.1 },
  ],
};

const SCOPED_FUSE_OPTIONS: FuseOptionsWithTokenSearch<ToolSearchDoc> = {
  ...FUSE_OPTIONS,
  keys: [
    { name: "name", weight: 0.65 },
    { name: "description", weight: 0.35 },
  ],
};

// ---- types ----

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

// ---- rerank ----

function scoreFuseResult(
  doc: ToolSearchDoc,
  query: string,
  rawFuseScore: number | undefined,
  options?: { scoped?: boolean; ignoreServerFields?: boolean },
): { score: number; reasons: string[] } {
  const reasons: string[] = [];

  const fuseScore = Math.round((1 - (rawFuseScore ?? 1)) * 60);
  let score = fuseScore;

  if (fuseScore > 0) {
    reasons.push(`Fuse token 匹配 ${fuseScore}/60`);
  }

  const queryTokens = tokenizeForSearch(query);

  const nameText = normalizeForSearch(doc.name);
  const qualifiedText = normalizeForSearch(doc.qualifiedName);
  const descText = normalizeForSearch(doc.description || "");
  const serverText = normalizeForSearch(doc.server);
  const aliasText = normalizeForSearch(doc.serverAliases.join(" "));
  const normalizedQuery = normalizeForSearch(query);

  let nameHits = 0;
  let qualifiedHits = 0;
  let descHits = 0;
  let serverHits = 0;
  let aliasHits = 0;

  for (const token of queryTokens) {
    if (nameText.includes(token)) nameHits++;
    if (descText.includes(token)) descHits++;

    if (!options?.ignoreServerFields) {
      if (qualifiedText.includes(token)) qualifiedHits++;
      if (serverText.includes(token)) serverHits++;
      if (aliasText.includes(token)) aliasHits++;
    }
  }

  // 1. 工具名命中
  if (nameHits > 0) {
    const boost = Math.min(25, nameHits * 10);
    score += boost;
    reasons.push(`工具名命中 ${nameHits} 个查询 token (+${boost})`);
  }

  // 2. qualifiedName 命中
  if (qualifiedHits > 0) {
    const boost = Math.min(10, qualifiedHits * 4);
    score += boost;
    reasons.push(`完整工具名命中 ${qualifiedHits} 个查询 token (+${boost})`);
  }

  // 3. server alias 命中
  if (aliasHits > 0) {
    const boost = Math.min(15, aliasHits * 8);
    score += boost;
    reasons.push(`服务别名命中 ${aliasHits} 个查询 token (+${boost})`);
  }

  // 4. server name 命中
  if (serverHits > 0) {
    const boost = Math.min(8, serverHits * 4);
    score += boost;
    reasons.push(`服务名命中 ${serverHits} 个查询 token (+${boost})`);
  }

  // 5. description 命中
  if (descHits > 0) {
    const boost = Math.min(12, descHits * 4);
    score += boost;
    reasons.push(`描述命中 ${descHits} 个查询 token (+${boost})`);
  }

  // 6. 完整 query 被工具名包含
  if (normalizedQuery && nameText.includes(normalizedQuery)) {
    score += 15;
    reasons.push("工具名包含完整查询 (+15)");
  }

  // 7. scoped 搜索轻微加分
  if (options?.scoped) {
    score += 5;
    reasons.push("已限定服务范围 (+5)");
  }

  // 8. 仅 description 命中，降权
  const strongHit =
    nameHits > 0 ||
    aliasHits > 0 ||
    serverHits > 0 ||
    normalizedQuery.includes(nameText) ||
    nameText.includes(normalizedQuery);

  if (!strongHit && descHits > 0) {
    score -= 8;
    score = Math.min(score, options?.scoped ? 55 : 50);
    reasons.push("仅描述命中，降低置信度并限制最高分 (-8, cap)");
  }

  // 9. 零字段命中，降权
  if (
    nameHits === 0 &&
    qualifiedHits === 0 &&
    descHits === 0 &&
    serverHits === 0 &&
    aliasHits === 0
  ) {
    score -= 15;
    reasons.push("未命中可解释字段，降低置信度 (-15)");
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  return { score, reasons };
}

// ---- SearchIndex ----

export class SearchIndex {
  private fuse: Fuse<ToolSearchDoc> | null = null;
  private documents: ToolSearchDoc[] = [];

  buildIndex(
    servers: Record<string, ServerConfig>,
    cachedServers: Record<string, { tools: CachedTool[] }>,
  ): void {
    this.documents = [];

    for (const [serverName, serverEntry] of Object.entries(cachedServers)) {
      const config = servers[serverName];
      if (!config || config.disabled) continue;

      const aliases = config.aliases || [];
      const tools = serverEntry.tools || [];

      for (const tool of tools) {
        const qualifiedName = `${serverName}.${tool.name}`;

        this.documents.push({
          server: serverName,
          serverAliases: aliases,
          name: tool.name,
          qualifiedName,
          description: tool.description,
          inputSchema: tool.inputSchema,
        });
      }
    }

    if (this.documents.length > 0) {
      this.fuse = new Fuse<ToolSearchDoc>(
        this.documents,
        FUSE_OPTIONS as IFuseOptions<ToolSearchDoc>,
      );
    } else {
      this.fuse = null;
    }
  }

  search(
    query: string,
    targetServer?: string,
    limit: number = 10,
  ): ToolSearchResult[] {
    if (!this.fuse) return [];

    let candidates = this.documents;
    let scoped = false;
    let searchQuery = query;
    let functionQueryEmpty = false;

    if (targetServer) {
      const resolved = targetServer.trim();
      candidates = this.documents.filter(
        (doc) =>
          doc.server.toLowerCase() === resolved.toLowerCase() ||
          doc.serverAliases.some(
            (alias) => alias.toLowerCase() === resolved.toLowerCase(),
          ),
      );
      scoped = true;

      const first = candidates[0];
      if (first) {
        const removed = removeMatchedServerTerms(
          query,
          first.server,
          first.serverAliases,
        );
        if (removed.trim()) {
          searchQuery = removed;
        } else {
          functionQueryEmpty = true;
        }
      }
    } else {
      const mentionedServers = this.findServersMentionedInQuery(query);

      if (mentionedServers.length === 1) {
        const serverName = mentionedServers[0];
        candidates = this.documents.filter((doc) => doc.server === serverName);
        scoped = true;

        const first = candidates[0];
        if (first) {
          const removed = removeMatchedServerTerms(
            query,
            first.server,
            first.serverAliases,
          );
          if (removed.trim()) {
            searchQuery = removed;
          } else {
            functionQueryEmpty = true;
          }
        }
      } else if (mentionedServers.length > 1) {
        candidates = this.documents.filter((doc) =>
          mentionedServers.includes(doc.server),
        );
        scoped = true;
      }
    }

    if (candidates.length === 0) return [];

    if (scoped && functionQueryEmpty) {
      return this.browseDocs(
        candidates,
        limit,
        "query 仅命中服务名/别名，未提供功能关键词，返回该服务下工具浏览候选",
      );
    }

    const fuseOptions = scoped ? SCOPED_FUSE_OPTIONS : FUSE_OPTIONS;

    let currentFuse = this.fuse;
    if (scoped || candidates.length < this.documents.length) {
      currentFuse = new Fuse<ToolSearchDoc>(
        candidates,
        fuseOptions as IFuseOptions<ToolSearchDoc>,
      );
    }

    const rawResults = currentFuse.search(searchQuery);

    const scoringQuery = scoped && searchQuery.trim() ? searchQuery : query;

    if (rawResults.length === 0) {
      return this.tokenMatchFallback(scoringQuery, candidates, limit, {
        scoped,
        ignoreServerFields: scoped,
      });
    }

    const reranked = rawResults.map((res) => {
      const doc = res.item;
      const scored = scoreFuseResult(doc, scoringQuery, res.score, {
        scoped,
        ignoreServerFields: scoped,
      });

      return {
        server: doc.server,
        tool: doc.name,
        qualifiedName: doc.qualifiedName,
        description: doc.description || "",
        inputSchema: doc.inputSchema,
        score: scored.score,
        matchKind: "fuzzy" as const,
        matchReasons: scored.reasons,
      };
    });

    const minScore = scoped ? 25 : 30;

    const filtered = reranked
      .filter((r) => r.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    if (filtered.length > 0) return filtered;

    return this.tokenMatchFallback(scoringQuery, candidates, limit, {
      scoped,
      ignoreServerFields: scoped,
    });
  }

  /**
   * Token 命中 fallback：Fuse 无结果时，按 query token 在各字段的命中数分层评分。
   * scoped 基础分 35，全局基础分 0；低于阈值不返回。
   */
  private tokenMatchFallback(
    query: string,
    candidates: ToolSearchDoc[],
    limit: number,
    options?: { scoped?: boolean; ignoreServerFields?: boolean },
  ): ToolSearchResult[] {
    const scoped = options?.scoped === true;
    const queryTokens = tokenizeForSearch(query);

    const scored = candidates.map((doc) => {
      const nameText = normalizeForSearch(doc.name);
      const qualifiedText = normalizeForSearch(doc.qualifiedName);
      const descText = normalizeForSearch(doc.description || "");
      const serverText = normalizeForSearch(doc.server);
      const aliasText = normalizeForSearch(doc.serverAliases.join(" "));

      let score = scoped ? 35 : 0;
      const reasons: string[] = [];

      let nameHits = 0;
      let qualifiedHits = 0;
      let descHits = 0;
      let serverHits = 0;
      let aliasHits = 0;

      for (const token of queryTokens) {
        if (nameText.includes(token)) nameHits++;
        if (descText.includes(token)) descHits++;

        if (!options?.ignoreServerFields) {
          if (qualifiedText.includes(token)) qualifiedHits++;
          if (serverText.includes(token)) serverHits++;
          if (aliasText.includes(token)) aliasHits++;
        }
      }

      if (nameHits > 0) {
        const boost = Math.min(35, nameHits * 15);
        score += boost;
        reasons.push(`工具名命中 ${nameHits} 个查询 token (+${boost})`);
      }

      if (qualifiedHits > 0) {
        const boost = Math.min(12, qualifiedHits * 4);
        score += boost;
        reasons.push(
          `完整工具名命中 ${qualifiedHits} 个查询 token (+${boost})`,
        );
      }

      if (aliasHits > 0) {
        const boost = Math.min(18, aliasHits * 9);
        score += boost;
        reasons.push(`服务别名命中 ${aliasHits} 个查询 token (+${boost})`);
      }

      if (serverHits > 0) {
        const boost = Math.min(10, serverHits * 5);
        score += boost;
        reasons.push(`服务名命中 ${serverHits} 个查询 token (+${boost})`);
      }

      if (descHits > 0) {
        const boost = Math.min(15, descHits * 5);
        score += boost;
        reasons.push(`描述命中 ${descHits} 个查询 token (+${boost})`);
      }

      const onlyDescriptionHit =
        nameHits === 0 &&
        qualifiedHits === 0 &&
        serverHits === 0 &&
        aliasHits === 0 &&
        descHits > 0;

      if (onlyDescriptionHit) {
        score -= 8;
        score = Math.min(score, scoped ? 50 : 45);
        reasons.push("仅描述命中，降低置信度并限制最高分 (-8, cap)");
      }

      const hasFunctionalHit =
        nameHits > 0 || qualifiedHits > 0 || descHits > 0;

      return {
        doc,
        score: Math.max(0, Math.min(100, Math.round(score))),
        reasons,
        hasFunctionalHit,
      };
    });

    const minScore = scoped ? 35 : 45;

    const filtered = scored
      .filter((item) => item.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return filtered.map(({ doc, score, reasons, hasFunctionalHit }) => ({
      server: doc.server,
      tool: doc.name,
      qualifiedName: doc.qualifiedName,
      description: doc.description || "",
      inputSchema: doc.inputSchema,
      score,
      matchKind:
        scoped && !hasFunctionalHit ? "server_browse" : "token_fallback",
      matchReasons: reasons,
    }));
  }

  private findServersMentionedInQuery(query: string): string[] {
    const names: string[] = [];
    const nameToServers = new Map<string, Set<string>>();

    const uniqueServers = new Map<string, string[]>();
    for (const doc of this.documents) {
      if (!uniqueServers.has(doc.server)) {
        uniqueServers.set(doc.server, doc.serverAliases);
      }
    }

    for (const [serverName, aliases] of uniqueServers.entries()) {
      for (const name of [serverName, ...aliases]) {
        names.push(name);
        const key = normalizeForSearch(name);
        const set = nameToServers.get(key) ?? new Set<string>();
        set.add(serverName);
        nameToServers.set(key, set);
      }
    }

    const matchedNames = findServersInText(query, names);
    const result = new Set<string>();

    for (const matched of matchedNames) {
      const serversForName = nameToServers.get(normalizeForSearch(matched));
      if (serversForName) {
        for (const serverName of serversForName) {
          result.add(serverName);
        }
      }
    }

    return Array.from(result);
  }

  /**
   * 通用文档浏览：从候选 docs 中取前 N 个，统一返回 server_browse。
   */
  private browseDocs(
    docs: ToolSearchDoc[],
    limit: number = 10,
    reason = "已限定服务范围，但功能关键词未命中，返回服务内工具浏览候选",
  ): ToolSearchResult[] {
    return docs.slice(0, limit).map((doc) => ({
      server: doc.server,
      tool: doc.name,
      qualifiedName: doc.qualifiedName,
      description: doc.description || "",
      inputSchema: doc.inputSchema,
      score: 35,
      matchKind: "server_browse" as const,
      matchReasons: [reason],
    }));
  }

  /**
   * 返回指定 server 下的前 N 个工具作为兜底浏览结果。
   */
  browseServer(serverName: string, limit: number = 10): ToolSearchResult[] {
    const docs = this.documents.filter((doc) => doc.server === serverName);

    if (docs.length === 0) return [];

    return this.browseDocs(docs, limit);
  }
}
