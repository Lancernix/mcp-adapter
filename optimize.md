可以，按你这 3 个约束，我建议把搜索目标重新定义一下：

> **mcp-adapter 的搜索不追求“一次语义理解到位”，而是追求通用、稳定、低噪音、可解释的工具候选召回。**
>
> 允许模型通过：
>
> ```text
> search_tools → 看 schema / 换词 search_tools → execute_tool
> ```
>
> 或者：
>
> ```text
> search_tools → list_tools → describe_tool → execute_tool
> ```
>
> 在 2~3 轮内收敛。
>
> 所以不要内置业务词典，也不要试图把“搜索=search、创建=create”这种翻译硬编码进 adapter。这个应该交给 LLM 自己完成。

基于这个目标，我建议优化方向是：

```text
1. 启用 token search，提高多词查询的通用召回能力；
2. 使用通用 tokenizer，解决中文连续文本被当成一个整体的问题；
3. 调整 Fuse key 权重，降低 description 过度干扰；
4. 加一个非常克制的结构化 rerank，只基于“命中在哪个字段”，不做语义翻译；
5. fallback 允许全局触发，但用分数阈值控制噪音；
6. 返回 matchReasons，让 LLM 更容易判断候选可靠性。
```

---

# 1. 优化原则

你这 3 点其实可以总结成几个原则。

## 1.1 通用优先，不做 MCP 领域特化

不做：

```ts
{
  "钉钉文档": ["dingtalk", "document"],
  "表格": ["sheet", "table"],
  "创建": ["create", "new"]
}
```

原因：

```text
不同 MCP 的命名风格不同；
有的工具英文，有的中文，有的混合；
硬编码词典必然偏向你当前测试集；
维护成本高，还可能误导排序。
```

---

## 1.2 LLM 负责语义转换，adapter 负责检索候选

比如用户说：

```text
创建文档
```

LLM 自己应该有能力尝试：

```text
创建文档
create document
new doc
```

adapter 不需要内置这个映射。

adapter 更应该做好：

```text
如果 query 里某个 token 和工具名 / 描述 / server alias / server name 有交集，就稳定返回；
如果 query 命中某个 server，就优先在这个 server 里给候选；
如果不确定，就提供 list_tools / describe_tool 的明确兜底路径。
```

---

## 1.3 排序应该偏向“结构可靠性”，不是语义推断

通用场景里，最可靠的信号顺序大概是：

```text
工具名 name 命中 > qualifiedName 命中 > server alias 命中 > server 名命中 > 描述 description 命中
```

尤其不能让 description 过度支配排序。

你的 `创建文档 -> create_folder 排第一` 就是 description 干扰过强的典型问题。

---

# 2. 总体方案

推荐把搜索链路改成：

```text
query
  ↓
tokenizeForSearch(query)
  ↓
server scope inference
  ↓
Fuse token search
  ↓
field-aware rerank
  ↓
threshold / fallback
  ↓
返回候选 + schema + matchReasons
```

核心变化：

```text
Fuse 负责召回；
rerank 负责修正“命中在哪个字段”的权重；
LLM 负责最终语义判断。
```

---

# 3. 启用 Fuse token search

这是最关键的一步。

当前默认 fuzzy search 会把完整 query 当作一个 pattern。对于：

```text
搜索钉钉文档
插入 表格 钉钉
重命名 文档 思源
```

这种中英文混合、多词、无空格中文 query，非常容易漏。

建议启用：

```ts
useTokenSearch: true
```

并配置自定义 tokenizer。

---

# 4. tokenizer 设计：通用，不带业务语义

不要做中英文 map，也不要做领域词典。

只做：

```text
1. 英文 / 数字 / 下划线 token；
2. Intl.Segmenter 中文分词；
3. 连续中文 bigram 兜底；
4. 过滤过弱 token。
```

## 推荐实现

```ts
const zhSegmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter("zh", { granularity: "word" })
    : null;

export function normalizeForSearch(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[-_./:]+/g, " ")
    .replace(/\s+/g, " ");
}

export function tokenizeForSearch(text: string): string[] {
  const normalized = normalizeForSearch(text);
  const tokens = new Set<string>();

  // 1. 英文、数字 token
  for (const m of normalized.matchAll(/[a-z0-9]+/gi)) {
    tokens.add(m[0].toLowerCase());
  }

  // 2. Intl.Segmenter，通用中文分词
  if (zhSegmenter) {
    for (const seg of zhSegmenter.segment(normalized)) {
      if (seg.isWordLike) {
        const token = seg.segment.trim().toLowerCase();
        if (token) tokens.add(token);
      }
    }
  }

  // 3. 连续中文串 bigram 兜底
  for (const m of normalized.matchAll(/[\u4e00-\u9fff]+/g)) {
    const s = m[0];

    // 整串保留
    if (s.length >= 2) {
      tokens.add(s);
    }

    // bigram 兜底：搜索钉钉文档 -> 搜索 / 索钉 / 钉钉 / 钉文 / 文档
    if (s.length >= 2) {
      for (let i = 0; i < s.length - 1; i++) {
        tokens.add(s.slice(i, i + 2));
      }
    }
  }

  return Array.from(tokens).filter((t) => !isWeakSearchToken(t));
}

function isWeakSearchToken(token: string): boolean {
  if (!token) return true;

  // 单个中文字符噪音太大，不作为默认搜索 token
  if (/^[\u4e00-\u9fff]$/.test(token)) return true;

  // 单字符英文/数字也过滤
  if (/^[a-z0-9]$/i.test(token)) return true;

  return false;
}
```

为什么不用纯中文单字？

```text
“文”“档”“表”“格”“搜”“索” 太泛；
召回会变多，但排序噪音明显增加；
bigram 比 unigram 更稳。
```

---

# 5. Fuse 权重调整

你现在：

```ts
keys: [
  { name: "qualifiedName", weight: 0.25 },
  { name: "name", weight: 0.25 },
  { name: "description", weight: 0.25 },
  { name: "serverAliases", weight: 0.15 },
  { name: "server", weight: 0.1 },
]
```

问题：

```text
qualifiedName 和 name 高度重叠；
description 权重过高，容易把“描述里高频出现某词”的工具排太前；
serverAliases 对中文路由很重要，可以提高；
name 应该是最高权重。
```

建议改成：

```ts
const FUSE_OPTIONS: FuseOptionsWithTokenSearch<ToolSearchDoc> = {
  includeScore: true,
  ignoreLocation: true,
  useTokenSearch: true,
  tokenMatch: "any",
  tokenize: tokenizeForSearch,

  // token search 下不要太宽，避免噪音
  threshold: 0.35,

  keys: [
    { name: "name", weight: 0.4 },
    { name: "serverAliases", weight: 0.2 },
    { name: "description", weight: 0.2 },
    { name: "server", weight: 0.1 },
    { name: "qualifiedName", weight: 0.1 },
  ],
};
```

如果 TS 类型不认 `useTokenSearch`，可以加扩展类型：

```ts
type FuseOptionsWithTokenSearch<T> = IFuseOptions<T> & {
  useTokenSearch?: boolean;
  tokenMatch?: "any" | "all";
  tokenize?: RegExp | ((text: string) => string[]);
};
```

---

# 6. 不做语义 map，但做字段命中 rerank

你说权重计算需要优化，这个我同意。

但 rerank 不应该做：

```text
中文 → 英文
业务词 → 业务词
```

而应该做：

```text
query token 命中了哪个字段？
命中工具名还是描述？
命中 server alias 还是普通 description？
```

这是通用的。

---

## 6.1 分数结构建议

建议最终分数由这几部分组成：

```text
baseFuseScore       0~60
nameBoost           0~25
qualifiedNameBoost  0~10
serverAliasBoost    0~15
serverBoost         0~8
descriptionBoost    0~12
exactBoost          0~15
weakPenalty         0~-20
```

然后 clamp 到：

```text
0~100
```

核心思想：

```text
Fuse 给基础相关性；
命中工具名显著加分；
命中描述只能小幅加分；
server alias 命中用于路由，不应该完全支配工具排序；
无任何强字段命中时降权。
```

---

# 7. 推荐 rerank 实现

可以给 `ToolSearchResult` 加一个可选字段：

```ts
matchReasons?: string[];
```

类型改成：

```ts
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
```

然后实现：

```ts
function scoreFuseResult(
  doc: ToolSearchDoc,
  query: string,
  rawFuseScore: number | undefined,
  options?: {
    scoped?: boolean;
  },
): {
  score: number;
  reasons: string[];
  strongHit: boolean;
} {
  const reasons: string[] = [];

  // Fuse 原始分：0 最好，1 最差
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
    if (qualifiedText.includes(token)) qualifiedHits++;
    if (descText.includes(token)) descHits++;
    if (serverText.includes(token)) serverHits++;
    if (aliasText.includes(token)) aliasHits++;
  }

  // 1. 工具名命中，最重要
  if (nameHits > 0) {
    const boost = Math.min(25, nameHits * 10);
    score += boost;
    reasons.push(`工具名命中 ${nameHits} 个查询 token (+${boost})`);
  }

  // 2. qualifiedName 命中，次重要
  // 注意 qualifiedName 包含 server，因此权重不能太高
  if (qualifiedHits > 0) {
    const boost = Math.min(10, qualifiedHits * 4);
    score += boost;
    reasons.push(`完整工具名命中 ${qualifiedHits} 个查询 token (+${boost})`);
  }

  // 3. server alias 命中，有助于路由
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

  // 5. description 命中，控制权重，避免 description 支配排序
  if (descHits > 0) {
    const boost = Math.min(12, descHits * 4);
    score += boost;
    reasons.push(`描述命中 ${descHits} 个查询 token (+${boost})`);
  }

  // 6. 完整 query 被工具名包含，强信号
  if (normalizedQuery && nameText.includes(normalizedQuery)) {
    score += 15;
    reasons.push("工具名包含完整查询 (+15)");
  }

  // 7. scoped 搜索轻微加分
  if (options?.scoped) {
    score += 5;
    reasons.push("已限定服务范围 (+5)");
  }

  const strongHit =
    nameHits > 0 ||
    aliasHits > 0 ||
    serverHits > 0 ||
    normalizedQuery.includes(nameText) ||
    nameText.includes(normalizedQuery);

  // 8. 如果只有 description 命中，没有 name/server/alias 命中，轻微降权
  if (!strongHit && descHits > 0) {
    score -= 8;
    reasons.push("仅描述命中，降低置信度 (-8)");
  }

  // 9. 如果 query token 一个都没命中结构化字段，明显降权
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

  return {
    score,
    reasons,
    strongHit,
  };
}
```

这个 rerank 完全不做语义映射，只做字段命中分层。

---

# 8. 为什么这样能改善你的几个 case

## 8.1 `创建文档`

现在 `create_folder` 可能因为描述里有很多“文档”被 Fuse 排前。

新规则下：

```text
description 命中最多 +12
仅描述命中还会 -8
工具名命中才是强信号
```

所以：

```text
create_folder
```

如果只是描述里有“文档”，不会拿到太高分。

但 `create_document` 如果工具名或 qualifiedName 里有 `document`，会拿到：

```text
工具名命中 +10~25
qualifiedName 命中 +4~10
```

即使 LLM 用中文 query 搜，第一轮不一定完美，但如果 LLM 看到结果不理想，第二轮搜：

```text
create document
```

就会非常稳。

这符合你说的：允许 2~3 轮收敛。

---

## 8.2 `搜索钉钉文档`

新 tokenizer 会让：

```text
搜索钉钉文档
```

至少产生：

```text
搜索钉钉文档
搜索
索钉
钉钉
钉文
文档
```

如果 `钉钉文档` 是 alias，server alias 会命中。

更重要的是，你现有逻辑里 query 命中唯一 server 后会缩小 candidates，这个要继续保留。然后在钉钉 server 内搜索，噪音会明显降低。

第一轮可能仍然不一定把 `search_documents` 稳定排第一，因为没有中文→英文 map。但没关系，LLM 可以第二轮搜：

```text
search document dingtalk
```

这时 token search + name 权重会非常稳。

---

## 8.3 `插入 表格 钉钉`

如果 query 中文没有和英文工具名对应，第一轮可能还是不完美。

但新机制至少会：

```text
识别钉钉 alias → 限定 server；
表格/钉钉 token search → 尽量召回相关工具；
如果无强匹配 → fallback 返回 server 内候选；
LLM 可继续 list_tools 或换英文 query。
```

这就是一个通用 adapter 合理的边界。

---

# 9. server scope 逻辑要继续保留，而且可以小优化

你现在已经有：

```ts
findServersMentionedInQueryFromConfig()
```

和 `SearchIndex.findServersMentionedInQuery()`。

建议继续保留。

但有一个优化点：**识别到 server 后，Fuse query 可以尽量去掉 server token，只搜功能 token。**

这不是语义 map，是通用清洗。

例如：

```text
搜索钉钉文档
```

如果 `钉钉文档` 命中了 server alias，那么进入该 server 内搜索时，query 可以从：

```text
搜索钉钉文档
```

变成：

```text
搜索
```

或者至少：

```text
搜索 文档
```

不过这步要小心，因为有时候 alias 本身也是对象词。

我建议先做保守版本：

```ts
function removeMatchedServerTerms(
  query: string,
  serverName: string,
  aliases: string[],
): string {
  let text = normalizeForSearch(query);

  const terms = [serverName, ...aliases]
    .map(normalizeForSearch)
    .filter((t) => t.length >= 2)
    .sort((a, b) => b.length - a.length);

  for (const term of terms) {
    text = text.replaceAll(term, " ");
  }

  return text.replace(/\s+/g, " ").trim();
}
```

在 `SearchIndex.search()` 里：

```ts
const scoped = !!targetServer || mentionedServers.length === 1;

const searchQuery =
  targetServer && servers[targetServer]
    ? removeMatchedServerTerms(
        query,
        targetServer,
        servers[targetServer].aliases || [],
      ) || query
    : query;
```

注意：如果移除后为空，则回退原 query。

---

# 10. fallback 触发条件怎么改

你现在只有 scoped 才 fallback：

```ts
if (
  rawResults.length === 0 &&
  candidates.length > 0 &&
  candidates.length < this.documents.length
) {
  return this.tokenMatchFallback(query, candidates, limit);
}
```

我建议改成：

```ts
if (rawResults.length === 0 && candidates.length > 0) {
  const scoped = !!targetServer || candidates.length < this.documents.length;
  return this.tokenMatchFallback(query, candidates, limit, { scoped });
}
```

但 fallback 内部必须有阈值：

```text
scoped fallback：允许低一点，作为 server browse
global fallback：必须高一点，避免噪音
```

---

## 推荐 fallback 实现

```ts
private tokenMatchFallback(
  query: string,
  candidates: ToolSearchDoc[],
  limit: number,
  options?: { scoped?: boolean },
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
      if (qualifiedText.includes(token)) qualifiedHits++;
      if (descText.includes(token)) descHits++;
      if (serverText.includes(token)) serverHits++;
      if (aliasText.includes(token)) aliasHits++;
    }

    if (nameHits > 0) {
      const boost = Math.min(35, nameHits * 15);
      score += boost;
      reasons.push(`工具名命中 ${nameHits} 个查询 token (+${boost})`);
    }

    if (qualifiedHits > 0) {
      const boost = Math.min(12, qualifiedHits * 4);
      score += boost;
      reasons.push(`完整工具名命中 ${qualifiedHits} 个查询 token (+${boost})`);
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
      reasons.push("仅描述命中，降低置信度 (-8)");
    }

    return {
      doc,
      score: Math.max(0, Math.min(100, Math.round(score))),
      reasons,
    };
  });

  const minScore = scoped ? 35 : 45;

  const filtered = scored
    .filter((item) => item.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return filtered.map(({ doc, score, reasons }) => ({
    server: doc.server,
    tool: doc.name,
    qualifiedName: doc.qualifiedName,
    description: doc.description || "",
    inputSchema: doc.inputSchema,
    score,
    matchKind: scoped && score < 50 ? "server_browse" : "token_fallback",
    matchReasons: reasons,
  }));
}
```

---

# 11. search 结果展示建议

既然允许 2~3 轮，那就要让 LLM 容易判断下一步怎么做。

建议在每个结果下面加：

```text
匹配依据: ...
```

例如：

```text
- **dingtalk-doc.list_document_blocks** (58分)
  匹配依据: 服务别名命中 1 个查询 token；描述命中 2 个查询 token；仅描述命中，降低置信度
  描述: ...
  inputSchema:
```

这对模型非常有用。

如果它看到：

```text
仅描述命中，降低置信度
```

就更可能继续 search/list，而不是直接 execute。

---

## index.ts 输出改动

现在：

```ts
replyText += `  描述: ${match.description || "无"}\n`;
```

可以加：

```ts
if (match.matchReasons?.length) {
  replyText += `  匹配依据: ${match.matchReasons.join("；")}\n`;
}
```

---

# 12. `SearchIndex.search()` 推荐改法

核心结构：

```ts
search(
  query: string,
  targetServer?: string,
  limit: number = 10,
): ToolSearchResult[] {
  if (!this.fuse) return [];

  let candidates = this.documents;
  let scoped = false;
  let searchQuery = query;

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
      searchQuery =
        removeMatchedServerTerms(query, first.server, first.serverAliases) ||
        query;
    }
  } else {
    const mentionedServers = this.findServersMentionedInQuery(query);

    if (mentionedServers.length === 1) {
      const serverName = mentionedServers[0];
      candidates = this.documents.filter((doc) => doc.server === serverName);
      scoped = true;

      const first = candidates[0];
      if (first) {
        searchQuery =
          removeMatchedServerTerms(query, first.server, first.serverAliases) ||
          query;
      }
    } else if (mentionedServers.length > 1) {
      candidates = this.documents.filter((doc) =>
        mentionedServers.includes(doc.server),
      );
      scoped = true;
    }
  }

  if (candidates.length === 0) return [];

  let currentFuse = this.fuse;
  if (candidates.length < this.documents.length) {
    currentFuse = new Fuse<ToolSearchDoc>(candidates, FUSE_OPTIONS);
  }

  const rawResults = currentFuse.search(searchQuery);

  if (rawResults.length === 0) {
    return this.tokenMatchFallback(query, candidates, limit, { scoped });
  }

  const reranked = rawResults.map((res) => {
    const doc = res.item;
    const scored = scoreFuseResult(doc, query, res.score, { scoped });

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

  return reranked
    .filter((r) => r.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
```

注意：rerank 后一定重新排序。

---

# 13. 关于分数体系

建议重新定义分数语义，让 LLM 更容易判断。

```text
80~100: 高可信，通常可以直接 execute
60~79: 较可信，建议结合 schema 判断
40~59: 弱匹配或 server 内候选，建议谨慎
20~39: 浏览兜底，不建议直接 execute
0~19: 基本不返回
```

这套分数比现在的：

```text
兜底 10/20
fuzzy 70
```

更好理解。

server scoped fallback 不应该只有 10 分。因为如果用户已经明确 server，那么“服务内候选”本身就有价值。

所以：

```ts
let score = scoped ? 35 : 0;
```

是合理的。

---

# 14. 关于 2~3 轮链路的优化

既然你接受 2~3 轮，那么 search 失败时的引导要更明确。

现在 no match 已经会列 server 列表。可以进一步优化：

```text
建议：
1. 如果你知道目标服务，调用 list_tools(server=...)
2. 如果你怀疑是英文命名工具，可尝试用英文关键词重新 search_tools
3. 如果某个候选工具名看起来接近，调用 describe_tool(tool=...)
```

这不是增加复杂度，而是帮助 LLM 选择下一步。

例如 no match 文案可以改成：

```text
[mcp-adapter] 暂未匹配到与 "插入 表格 钉钉" 相关的接口。

可尝试：
1. 如果目标服务明确，调用 list_tools server="钉钉文档" 查看工具目录；
2. 使用更接近工具命名的关键词重新 search_tools，例如对象名、动作名或英文关键词；
3. 从 list_tools 返回的工具名中选择疑似项后调用 describe_tool 获取完整 schema。
```

---

# 15. 不建议做的事

根据你的目标，我建议明确不要做：

## 15.1 不内置中英文 action map

不要：

```ts
const actionMap = {
  创建: ["create", "new"],
  搜索: ["search", "find"],
};
```

这应该交给 LLM。

---

## 15.2 不做业务 object conflict

不要：

```ts
document vs folder
table vs ai_table
block vs sheet
```

这太偏测试集。

---

## 15.3 不用 schema 全文参与 Fuse

`inputSchema` 很大，而且字段噪音不少。当前 search 已返回 schema，不建议再把完整 schema 纳入 Fuse 主排序。

如果未来要做，可以只提取 schema key，且权重很低。但这一轮不建议加。

---

# 16. 最小变更清单

如果你要快速落地，我建议这一版只改 `search-index.ts` 和一点输出。

## 必改

```text
1. 加 tokenizeForSearch / normalizeForSearch
2. FUSE_OPTIONS 启用 useTokenSearch
3. 调整 keys 权重
4. raw Fuse result 做 field-aware rerank
5. rerank 后重新 sort
6. fallback 全局可触发，但加 scoped/global 阈值
```

## 可选

```text
7. ToolSearchResult 加 matchReasons
8. search_tools 输出匹配依据
9. server scope 后移除 server alias token
```

---

# 17. 推荐最终方案摘要

你这个产品最合理的搜索策略是：

```text
通用 token search + 字段权重 rerank + 明确兜底链路
```

而不是：

```text
业务同义词 map + 试图一次语义命中
```

具体：

```text
1. Fuse useTokenSearch 解决多词/中文连续文本的召回问题；
2. Intl.Segmenter + 中文 bigram 兜底，保持通用；
3. name 权重最高，description 降低，避免描述高频词误导；
4. rerank 只关心 query token 命中了哪个字段，不做语义翻译；
5. server alias 命中后缩小候选范围；
6. fallback 可以全局触发，但必须用阈值控噪；
7. 返回 matchReasons，让 LLM 能判断是否直接 execute，还是继续 search/list/describe。
```

这样既符合你的 3 个要求：

```text
通用
不做中英文词 map
优化权重计算
```

也符合这个 adapter 的产品定位：

```text
牺牲少量检索轮次，换取系统 prompt 大幅减负和底层 server 惰性加载。
```