// bm25-index.ts - Lightweight self-implemented BM25 lexical search index

import { tokenizeForSearch } from "./search-utils.js";
import type { ToolSearchDoc } from "./types.js";

export interface Bm25Result {
  doc: ToolSearchDoc;
  score: number;
  matchedTokens: string[];
}

const K1 = 1.2;
const B = 0.75;

/**
 * 字段加权：重复次数映射 TF 权重。
 * name x4 > aliases x3 > qualifiedName x2 > server/description x1
 */
function buildWeightedBm25Text(doc: ToolSearchDoc): string {
  const parts: string[] = [];
  // 工具名最重要，重复 4 次
  parts.push(doc.name, doc.name, doc.name, doc.name);
  // 别名次重要，重复 3 次
  for (const alias of doc.serverAliases) {
    parts.push(alias, alias, alias);
  }
  // 完整工具名重复 2 次
  parts.push(doc.qualifiedName, doc.qualifiedName);
  // 服务名和描述各 1 次
  parts.push(doc.server, doc.description || "");
  return parts.join(" ");
}

export class Bm25Index {
  private documents: ToolSearchDoc[] = [];
  private docTokens: Map<number, Map<string, number>> = new Map();
  private tokenDf: Map<string, number> = new Map();
  private docLengths: number[] = [];
  private avgDocLength: number = 0;
  private docCount: number = 0;

  build(documents: ToolSearchDoc[]): void {
    this.documents = documents;
    this.docTokens.clear();
    this.tokenDf.clear();
    this.docLengths = [];
    this.docCount = documents.length;

    let totalLength = 0;

    for (let i = 0; i < documents.length; i++) {
      const doc = documents[i];
      const text = buildWeightedBm25Text(doc);

      const tokens = tokenizeForSearch(text, { unique: false });
      const tf = new Map<string, number>();

      for (const token of tokens) {
        tf.set(token, (tf.get(token) ?? 0) + 1);
      }

      this.docTokens.set(i, tf);
      this.docLengths.push(tokens.length);
      totalLength += tokens.length;

      for (const token of tf.keys()) {
        this.tokenDf.set(token, (this.tokenDf.get(token) ?? 0) + 1);
      }
    }

    this.avgDocLength = this.docCount > 0 ? totalLength / this.docCount : 0;
  }

  private idf(token: string): number {
    const df = this.tokenDf.get(token) ?? 0;
    if (df === 0) return 0;
    return Math.log((this.docCount - df + 0.5) / (df + 0.5) + 1);
  }

  search(
    query: string,
    candidates?: ToolSearchDoc[],
    limit: number = 30,
  ): Bm25Result[] {
    if (this.documents.length === 0) return [];

    const queryTokens = tokenizeForSearch(query);
    if (queryTokens.length === 0) return [];

    const candidateSet = candidates
      ? new Set(candidates.map((c) => c.qualifiedName))
      : null;

    const results: Bm25Result[] = [];

    for (let i = 0; i < this.documents.length; i++) {
      const doc = this.documents[i];
      if (candidateSet && !candidateSet.has(doc.qualifiedName)) continue;

      const tf = this.docTokens.get(i);
      if (!tf) continue;

      const dl = this.docLengths[i];
      const matchedTokens: string[] = [];
      let score = 0;

      for (const token of queryTokens) {
        const termFreq = tf.get(token) ?? 0;
        if (termFreq === 0) continue;

        matchedTokens.push(token);
        const tokenIdf = this.idf(token);
        const numerator = termFreq * (K1 + 1);
        const denominator =
          termFreq + K1 * (1 - B + B * (dl / (this.avgDocLength || 1)));
        score += tokenIdf * (numerator / denominator);
      }

      if (score > 0) {
        results.push({ doc, score, matchedTokens });
      }
    }

    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  }
}
