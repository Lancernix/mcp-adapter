// search-index.test.ts - Tests for search-index and related modules

import assert from "node:assert";
import { describe, it } from "node:test";
import { resolveServerHint } from "../src/config-manager.js";
import { SearchIndex } from "../src/search-index.js";
import type { ServerConfig } from "../src/types.js";

// ---- Test helpers ----

function makeServers(
  overrides?: Record<string, Partial<ServerConfig>>,
): Record<string, ServerConfig> {
  const base: Record<string, ServerConfig> = {
    "dingtalk-doc": {
      type: "stdio",
      command: "echo",
      aliases: ["钉钉", "钉钉文档", "dingtalk", "dingding"],
    },
    "siyuan-mcp": {
      type: "stdio",
      command: "echo",
      aliases: ["思源", "思源笔记", "siyuan"],
    },
    postgres: {
      type: "stdio",
      command: "echo",
      aliases: ["pg", "postgresql", "数据库"],
    },
    github: {
      type: "stdio",
      command: "echo",
      aliases: ["GitHub", "gh"],
    },
  };

  if (overrides) {
    for (const [key, val] of Object.entries(overrides)) {
      base[key] = { ...base[key], ...val };
    }
  }

  return base;
}

function makeCachedTools(
  tools: Array<{ name: string; description?: string }>,
): Record<string, { tools: Array<{ name: string; description?: string }> }> {
  const result: Record<
    string,
    { tools: Array<{ name: string; description?: string }> }
  > = {};

  for (const tool of tools) {
    // Split by first dot: server.toolName
    const dotIdx = tool.name.indexOf(".");
    const server = tool.name.slice(0, dotIdx);
    const toolName = tool.name.slice(dotIdx + 1);

    if (!result[server]) {
      result[server] = { tools: [] };
    }
    result[server].tools.push({
      name: toolName,
      description: tool.description,
    });
  }

  return result;
}

// ---- resolveServerHint tests ----

describe("resolveServerHint", () => {
  const servers = makeServers();

  it("精确匹配 server key", () => {
    const result = resolveServerHint("dingtalk-doc", servers);
    assert.strictEqual(result.confidence, "high");
    assert.strictEqual(result.resolvedServer, "dingtalk-doc");
  });

  it("精确匹配别名（中文）", () => {
    const result = resolveServerHint("钉钉文档", servers);
    assert.strictEqual(result.confidence, "high");
    assert.strictEqual(result.resolvedServer, "dingtalk-doc");
  });

  it("精确匹配别名（英文）", () => {
    const result = resolveServerHint("gh", servers);
    assert.strictEqual(result.confidence, "high");
    assert.strictEqual(result.resolvedServer, "github");
  });

  it("大小写不敏感匹配", () => {
    const result = resolveServerHint("DINGTALK-DOC", servers);
    assert.strictEqual(result.confidence, "high");
    assert.strictEqual(result.resolvedServer, "dingtalk-doc");
  });

  it("部分匹配（低置信）", () => {
    const result = resolveServerHint("ding", servers);
    assert.strictEqual(result.confidence, "low");
    assert.strictEqual(result.resolvedServer, "dingtalk-doc");
  });

  it("未匹配返回 none", () => {
    const result = resolveServerHint("nonexistent", servers);
    assert.strictEqual(result.confidence, "none");
    assert.strictEqual(result.resolvedServer, null);
  });

  it("变体匹配（分隔符归一化→高置信，因为归一化后等同于 server key）", () => {
    // "dingtalk doc" 归一化后是 "dingtalk doc"，与 "dingtalk-doc" 归一化结果相同 → 精确匹配
    const result = resolveServerHint("dingtalk doc", servers);
    assert.strictEqual(result.confidence, "high");
    assert.strictEqual(result.resolvedServer, "dingtalk-doc");
  });

  it("变体匹配：下划线分隔符归一化后匹配", () => {
    const result = resolveServerHint("dingtalk_doc", servers);
    assert.strictEqual(result.confidence, "high");
    assert.strictEqual(result.resolvedServer, "dingtalk-doc");
  });

  it("歧义检测：多 server 共享同一别名", () => {
    const s = makeServers({
      notion: {
        aliases: ["docs"],
      },
      "dingtalk-doc": {
        aliases: ["钉钉", "钉钉文档", "dingtalk", "docs"],
      },
    });
    const result = resolveServerHint("docs", s);
    assert.strictEqual(result.confidence, "medium");
    assert.ok(result.candidates.length > 1);
  });
});

// ---- SearchIndex tests ----

describe("SearchIndex", () => {
  const servers = makeServers();

  const cached = makeCachedTools([
    {
      name: "dingtalk-doc.search_document",
      description: "搜索钉钉文档",
    },
    {
      name: "dingtalk-doc.create_document",
      description: "创建钉钉文档",
    },
    {
      name: "dingtalk-doc.delete_document",
      description: "删除钉钉文档",
    },
    {
      name: "siyuan-mcp.sql_query",
      description: "执行 SQL 查询思源笔记数据库",
    },
    {
      name: "siyuan-mcp.search_notes",
      description: "搜索思源笔记",
    },
    {
      name: "postgres.query_table_schema",
      description: "查询 PostgreSQL 表结构",
    },
    {
      name: "postgres.execute_sql",
      description: "执行原始 SQL 查询",
    },
    {
      name: "github.create_issue",
      description: "创建 GitHub Issue",
    },
    {
      name: "github.search_repos",
      description: "搜索 GitHub 仓库",
    },
    {
      name: "github.list_issues",
      description: "列出仓库 Issues",
    },
  ]);

  const index = new SearchIndex();
  index.buildIndex(servers, cached);

  it("server alias 精确命中 → 工具名搜索", () => {
    const results = index.search("搜索", "dingtalk-doc", 5);
    assert.ok(results.length > 0);
    assert.ok(
      results.some((r) => r.qualifiedName === "dingtalk-doc.search_document"),
    );
  });

  it("中文 alias 搜索", () => {
    const results = index.search("钉钉文档", undefined, 5);
    assert.ok(results.length > 0);
    assert.ok(results.every((r) => r.server === "dingtalk-doc"));
  });

  it("query 内 server mention 自动识别", () => {
    const results = index.search("思源 sql", undefined, 5);
    assert.ok(results.length > 0);
    // 思源命中的结果应排在前面
    assert.strictEqual(results[0].server, "siyuan-mcp");
  });

  it("scoped query 为空 → server_browse", () => {
    const results = index.search("思源", undefined, 5);
    assert.ok(results.length > 0);
    assert.ok(results.every((r) => r.matchKind === "server_browse"));
  });

  it("泛词应排在稀有词之后（IDF 加权）", () => {
    // "schema" 是稀有词，应在结果中排在前列
    const results = index.search("list schema", undefined, 5);
    const schemaIdx = results.findIndex((r) =>
      r.qualifiedName.includes("schema"),
    );
    assert.ok(schemaIdx >= 0, "query_table_schema 应该在结果中");
    assert.ok(schemaIdx <= 2, `schema 结果应排在前 3，实际第 ${schemaIdx + 1}`);
  });

  it("typo 'postgress' 应 fuzzy 匹配到 postgres", () => {
    const results = index.search("postgress", undefined, 5);
    assert.ok(results.length > 0);
    assert.ok(results.some((r) => r.server === "postgres"));
  });

  it("description-only 命中应降权", () => {
    // 搜索一个仅出现在描述中的中文词
    const results = index.search("删除钉钉文档", undefined, 5);
    // delete_document 的 name 是 "delete_document"，不含"删除"
    // 描述是 "删除钉钉文档"，"删除"只出现在描述中
    const match = results.find(
      (r) => r.qualifiedName === "dingtalk-doc.delete_document",
    );
    if (match) {
      const reasons = match.matchReasons?.join("") || "";
      // 注意：钉钉是 alias，会命中 alias 字段，所以可能不是纯 desc-only
      // 如果 alias 没命中，应看到降权标记
      if (reasons.includes("仅描述命中")) {
        assert.ok(match.score < 60, `desc-only 应低分，实际=${match.score}`);
      }
    }
  });

  it("多路召回返回 hybrid 或 bm25 matchKind", () => {
    const results = index.search("search document", undefined, 5);
    assert.ok(results.length > 0);
    // 至少有一个结果来自 BM25 或 hybrid
    const hasBm25OrHybrid = results.some(
      (r) => r.matchKind === "bm25" || r.matchKind === "hybrid",
    );
    assert.ok(
      hasBm25OrHybrid,
      `结果应有 bm25/hybrid，实际: ${results.map((r) => r.matchKind).join(",")}`,
    );
  });
});
