// search-index.ts - Local fuzzy search index powered by Fuse.js

import type { IFuseOptions } from "fuse.js";
import Fuse from "fuse.js";
import type { Bm25Result } from "./bm25-index.js";
import { Bm25Index } from "./bm25-index.js";
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

// ---- Helpers ----

/**
 * Graded hit weight: exact token match > prefix match > substring match.
 * Reduces false positives for short tokens (e.g. "sql" matching "nosql").
 */
function tokenHitWeightForField(
  fieldText: string,
  fieldTokens: string[],
  token: string,
): number {
  if (fieldTokens.includes(token)) return 1.0;
  if (fieldTokens.some((t) => t.startsWith(token))) return 0.6;
  if (fieldText.includes(token)) return 0.3;
  return 0;
}

// ---- Fuse extended types ----

type FuseOptionsWithTokenSearch<T> = IFuseOptions<T> & {
  useTokenSearch?: boolean;
  tokenMatch?: "any" | "all";
  tokenize?: RegExp | ((text: string) => string[]);
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

export type ToolSearchMatchKind =
  | "hybrid"
  | "bm25"
  | "fuzzy"
  | "token_fallback"
  | "server_browse";

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

// ---- SearchIndex ----

export class SearchIndex {
  private fuse: Fuse<ToolSearchDoc> | null = null;
  private bm25: Bm25Index = new Bm25Index();
  private documents: ToolSearchDoc[] = [];
  private tokenDf: Map<string, number> = new Map();
  private docCount: number = 0;

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
      this.bm25.build(this.documents);
      this.computeTokenDf();
    } else {
      this.fuse = null;
      this.bm25.build([]);
      this.tokenDf.clear();
      this.docCount = 0;
    }
  }

  private computeTokenDf(): void {
    this.tokenDf.clear();
    this.docCount = this.documents.length;

    for (const doc of this.documents) {
      const text = [
        doc.name,
        doc.qualifiedName,
        doc.description || "",
        doc.server,
        ...doc.serverAliases,
      ].join(" ");
      const tokens = new Set(tokenizeForSearch(text));
      for (const token of tokens) {
        this.tokenDf.set(token, (this.tokenDf.get(token) ?? 0) + 1);
      }
    }
  }

  private idf(token: string): number {
    const df = this.tokenDf.get(token) ?? 0;
    if (df === 0) return 1.5;
    return Math.log((this.docCount + 1) / (df + 1)) + 1;
  }

  search(
    query: string,
    targetServer?: string,
    limit: number = 10,
  ): ToolSearchResult[] {
    if (!this.fuse) return [];

    let candidates = this.documents;
    let scopeMode: "none" | "single" | "multi" = "none";
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
      scopeMode = "single";

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
        scopeMode = "single";

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
        scopeMode = "multi";
      }
    }

    if (candidates.length === 0) return [];

    const isScoped = scopeMode !== "none";

    if (isScoped && functionQueryEmpty) {
      return this.browseDocs(
        candidates,
        limit,
        "query 仅命中服务名/别名，未提供功能关键词，返回该服务下工具浏览候选",
      );
    }

    // BM25 recall
    const bm25Results = this.bm25.search(searchQuery, candidates, limit * 4);
    const maxBm25Score =
      bm25Results.length > 0 ? Math.max(...bm25Results.map((r) => r.score)) : 0;

    // Fuse recall: only single-server scope uses SCOPED_FUSE_OPTIONS (ignore server fields)
    const fuseOptions =
      scopeMode === "single" ? SCOPED_FUSE_OPTIONS : FUSE_OPTIONS;

    let currentFuse = this.fuse;
    if (isScoped || candidates.length < this.documents.length) {
      currentFuse = new Fuse<ToolSearchDoc>(
        candidates,
        fuseOptions as IFuseOptions<ToolSearchDoc>,
      );
    }

    const rawResults = currentFuse.search(searchQuery);
    const scoringQuery = isScoped && searchQuery.trim() ? searchQuery : query;

    // Merge by qualifiedName
    type MergeEntry = {
      doc: ToolSearchDoc;
      bm25Result?: Bm25Result;
      fuseScore?: number;
      sources: Set<string>;
    };

    const merged = new Map<string, MergeEntry>();

    for (const r of bm25Results) {
      merged.set(r.doc.qualifiedName, {
        doc: r.doc,
        bm25Result: r,
        sources: new Set(["bm25"]),
      });
    }

    for (const r of rawResults) {
      const existing = merged.get(r.item.qualifiedName);
      if (existing) {
        existing.fuseScore = r.score;
        existing.sources.add("fuse");
      } else {
        merged.set(r.item.qualifiedName, {
          doc: r.item,
          fuseScore: r.score,
          sources: new Set(["fuse"]),
        });
      }
    }

    // Token fallback if too few results or no BM25 match
    const hasBm25Match = [...merged.values()].some((c) =>
      c.sources.has("bm25"),
    );
    const needsTokenFallback =
      merged.size < Math.min(limit, 5) || !hasBm25Match;

    if (needsTokenFallback) {
      const tokenResults = this.tokenMatchFallbackRaw(
        scoringQuery,
        candidates,
        { scoped: isScoped, ignoreServerFields: scopeMode === "single" },
      );
      for (const tr of tokenResults) {
        if (!merged.has(tr.doc.qualifiedName)) {
          merged.set(tr.doc.qualifiedName, {
            doc: tr.doc,
            sources: new Set(["token"]),
          });
        }
      }
    }

    // Unified rerank
    const reranked = [...merged.values()].map((c) => {
      // BM25 normalized: 0-45
      const bm25Norm =
        c.bm25Result && maxBm25Score > 0
          ? Math.min(45, (c.bm25Result.score / maxBm25Score) * 45)
          : 0;

      // Fuse normalized: 0-20
      const fuseNorm =
        c.fuseScore !== undefined
          ? Math.max(0, Math.min(20, (1 - c.fuseScore) * 20))
          : 0;

      // IDF-weighted field hits
      const field = this.computeFieldHits(c.doc, scoringQuery, {
        scoped: isScoped,
        ignoreServerFields: scopeMode === "single",
      });

      let score = bm25Norm + fuseNorm + Math.min(35, field.score);

      // Full query in name
      const normalizedQuery = normalizeForSearch(scoringQuery);
      const nameText = normalizeForSearch(c.doc.name);
      if (normalizedQuery && nameText.includes(normalizedQuery)) {
        score += 15;
        field.reasons.push("工具名包含完整查询 (+15)");
      }

      // Scoped boost
      if (isScoped) {
        score += 5;
        field.reasons.push("已限定服务范围 (+5)");
      }

      // Determine matchKind
      let matchKind: ToolSearchMatchKind;
      if (c.sources.has("bm25") && c.sources.has("fuse")) {
        matchKind = "hybrid";
      } else if (c.sources.has("bm25")) {
        matchKind = "bm25";
      } else if (c.sources.has("fuse")) {
        matchKind = "fuzzy";
      } else {
        matchKind = "token_fallback";
      }

      // Caps based on source
      if (matchKind === "token_fallback") {
        score = Math.min(score, isScoped ? 50 : 45);
        field.reasons.push("token fallback 结果，封顶 (-cap)");
      } else if (matchKind === "fuzzy" && !c.sources.has("bm25")) {
        if (field.nameWeight === 0 && field.aliasWeight === 0) {
          score = Math.min(score, 45);
          field.reasons.push("Fuse-only 无强字段命中，封顶 (-cap)");
        }
      }

      // Description-only cap
      if (
        field.nameWeight === 0 &&
        field.aliasWeight === 0 &&
        field.serverWeight === 0 &&
        field.descWeight > 0
      ) {
        score -= 8;
        score = Math.min(score, isScoped ? 55 : 50);
        field.reasons.push("仅描述命中，降低置信度并限制最高分 (-8, cap)");
      }

      score = Math.max(0, Math.min(100, Math.round(score)));

      return {
        server: c.doc.server,
        tool: c.doc.name,
        qualifiedName: c.doc.qualifiedName,
        description: c.doc.description || "",
        inputSchema: c.doc.inputSchema,
        score,
        matchKind,
        matchReasons: field.reasons,
      };
    });

    const minScore = isScoped ? 25 : 30;

    const filtered = reranked
      .filter((r) => r.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    if (filtered.length > 0) return filtered;

    return this.tokenMatchFallback(scoringQuery, candidates, limit, {
      scoped: isScoped,
      ignoreServerFields: scopeMode === "single",
    });
  }

  /**
   * 纯 IDF 加权字段命中分数，不含 Fuse/BM25 基础分。
   * 用于 hybrid 统一 rerank。
   */
  private computeFieldHits(
    doc: ToolSearchDoc,
    query: string,
    options?: { scoped?: boolean; ignoreServerFields?: boolean },
  ): {
    score: number;
    reasons: string[];
    nameWeight: number;
    aliasWeight: number;
    serverWeight: number;
    qualifiedWeight: number;
    descWeight: number;
  } {
    const reasons: string[] = [];
    const queryTokens = tokenizeForSearch(query);

    const nameText = normalizeForSearch(doc.name);
    const qualifiedText = normalizeForSearch(doc.qualifiedName);
    const descText = normalizeForSearch(doc.description || "");
    const serverText = normalizeForSearch(doc.server);
    const aliasText = normalizeForSearch(doc.serverAliases.join(" "));

    // Pre-tokenize fields for exact/prefix match detection
    const nameTokens = tokenizeForSearch(nameText);
    const qualifiedTokens = tokenizeForSearch(qualifiedText);
    const descTokens = tokenizeForSearch(descText);
    const serverTokens = tokenizeForSearch(serverText);
    const aliasTokens = tokenizeForSearch(aliasText);

    let nameWeight = 0;
    let qualifiedWeight = 0;
    let descWeight = 0;
    let serverWeight = 0;
    let aliasWeight = 0;

    for (const token of queryTokens) {
      const w = this.idf(token);
      nameWeight += w * tokenHitWeightForField(nameText, nameTokens, token);
      descWeight += w * tokenHitWeightForField(descText, descTokens, token);

      if (!options?.ignoreServerFields) {
        qualifiedWeight +=
          w * tokenHitWeightForField(qualifiedText, qualifiedTokens, token);
        serverWeight +=
          w * tokenHitWeightForField(serverText, serverTokens, token);
        aliasWeight +=
          w * tokenHitWeightForField(aliasText, aliasTokens, token);
      }
    }

    let score = 0;

    if (nameWeight > 0) {
      const boost = Math.min(25, Math.round(nameWeight * 4));
      score += boost;
      reasons.push(`工具名命中 IDF 加权 (+${boost})`);
    }

    if (qualifiedWeight > 0) {
      const boost = Math.min(10, Math.round(qualifiedWeight * 2));
      score += boost;
      reasons.push(`完整工具名命中 IDF 加权 (+${boost})`);
    }

    if (aliasWeight > 0) {
      const boost = Math.min(15, Math.round(aliasWeight * 3));
      score += boost;
      reasons.push(`服务别名命中 IDF 加权 (+${boost})`);
    }

    if (serverWeight > 0) {
      const boost = Math.min(8, Math.round(serverWeight * 2));
      score += boost;
      reasons.push(`服务名命中 IDF 加权 (+${boost})`);
    }

    if (descWeight > 0) {
      const boost = Math.min(12, Math.round(descWeight * 2));
      score += boost;
      reasons.push(`描述命中 IDF 加权 (+${boost})`);
    }

    return {
      score,
      reasons,
      nameWeight,
      aliasWeight,
      serverWeight,
      qualifiedWeight,
      descWeight,
    };
  }

  /**
   * Token fallback 原始结果（未过滤），用于 hybrid merge 时补充候选。
   */
  private tokenMatchFallbackRaw(
    query: string,
    candidates: ToolSearchDoc[],
    options?: { scoped?: boolean; ignoreServerFields?: boolean },
  ): Array<{ doc: ToolSearchDoc; score: number; reasons: string[] }> {
    const scoped = options?.scoped === true;

    return candidates
      .map((doc) => {
        const field = this.computeFieldHits(doc, query, options);
        let score = scoped ? 35 + field.score : field.score;
        const reasons = [...field.reasons];

        if (
          field.nameWeight === 0 &&
          field.qualifiedWeight === 0 &&
          field.serverWeight === 0 &&
          field.aliasWeight === 0 &&
          field.descWeight > 0
        ) {
          score -= 8;
          score = Math.min(score, scoped ? 50 : 45);
          reasons.push("仅描述命中，降低置信度并限制最高分 (-8, cap)");
        }

        return {
          doc,
          score: Math.max(0, Math.min(100, Math.round(score))),
          reasons,
        };
      })
      .filter((item) => item.score >= (scoped ? 35 : 45));
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

      let nameWeight = 0;
      let qualifiedWeight = 0;
      let descWeight = 0;
      let serverWeight = 0;
      let aliasWeight = 0;

      for (const token of queryTokens) {
        const w = this.idf(token);
        if (nameText.includes(token)) nameWeight += w;
        if (descText.includes(token)) descWeight += w;

        if (!options?.ignoreServerFields) {
          if (qualifiedText.includes(token)) qualifiedWeight += w;
          if (serverText.includes(token)) serverWeight += w;
          if (aliasText.includes(token)) aliasWeight += w;
        }
      }

      if (nameWeight > 0) {
        const boost = Math.min(35, Math.round(nameWeight * 5));
        score += boost;
        reasons.push(`工具名命中 IDF 加权 (+${boost})`);
      }

      if (qualifiedWeight > 0) {
        const boost = Math.min(12, Math.round(qualifiedWeight * 2));
        score += boost;
        reasons.push(`完整工具名命中 IDF 加权 (+${boost})`);
      }

      if (aliasWeight > 0) {
        const boost = Math.min(18, Math.round(aliasWeight * 4));
        score += boost;
        reasons.push(`服务别名命中 IDF 加权 (+${boost})`);
      }

      if (serverWeight > 0) {
        const boost = Math.min(10, Math.round(serverWeight * 2));
        score += boost;
        reasons.push(`服务名命中 IDF 加权 (+${boost})`);
      }

      if (descWeight > 0) {
        const boost = Math.min(15, Math.round(descWeight * 2));
        score += boost;
        reasons.push(`描述命中 IDF 加权 (+${boost})`);
      }

      const onlyDescriptionHit =
        nameWeight === 0 &&
        qualifiedWeight === 0 &&
        serverWeight === 0 &&
        aliasWeight === 0 &&
        descWeight > 0;

      if (onlyDescriptionHit) {
        score -= 8;
        score = Math.min(score, scoped ? 50 : 45);
        reasons.push("仅描述命中，降低置信度并限制最高分 (-8, cap)");
      }

      const hasFunctionalHit =
        nameWeight > 0 || qualifiedWeight > 0 || descWeight > 0;

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
