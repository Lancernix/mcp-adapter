读完了这一版的 README、`package.json` 和 `src` 下源码。整体判断：

> **这一版已经很接近可正式发布了。**
>
> 上轮提到的几个 P2 边界，你这版基本都补上了：
>
> - `findServersMentionedInQueryFromConfig()` 已改成 `nameToServer` map；
> - `removeMatchedServerTerms()` 已加英文词边界，避免 `doc` 误删 `docker`；
> - `resolveServerName()` 归一化规则已和搜索侧对齐，支持 `. / :`；
> - `parseQualifiedToolInput()` 已改成大小写不敏感，dotted server name 更稳。
>
> 当前没看到明显 P0/P1 阻塞问题。剩下主要是几个发布前可选项和一个 alias 冲突边界。

---

# 1. 本轮改得好的点

## 1.1 `findServersMentionedInQueryFromConfig()` 已优化

现在 `index.ts` 里：

```ts
function findServersMentionedInQueryFromConfig(
  query: string,
  servers: Record<string, ServerConfig>,
): string[] {
  const names: string[] = [];
  const nameToServer = new Map<string, string>();

  for (const [serverName, srvConfig] of Object.entries(servers)) {
    if (srvConfig.disabled) continue;

    for (const name of [serverName, ...(srvConfig.aliases || [])]) {
      names.push(name);
      nameToServer.set(normalizeForSearch(name), serverName);
    }
  }

  const matchedNames = findServersInText(query, names);
  const result = new Set<string>();

  for (const matched of matchedNames) {
    const serverName = nameToServer.get(normalizeForSearch(matched));
    if (serverName) result.add(serverName);
  }

  return Array.from(result);
}
```

这比上一版的二次遍历清爽很多，也和 `SearchIndex.findServersMentionedInQuery()` 的结构保持一致。

---

## 1.2 `removeMatchedServerTerms()` 已补英文词边界

现在 `search-utils.ts`：

```ts
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function removeMatchedServerTerms(
  query: string,
  serverName: string,
  aliases: string[],
): string {
  let text = normalizeForSearch(query);

  const terms = [serverName, ...aliases]
    .map((t) => normalizeForSearch(t))
    .filter((t) => t.length >= 2)
    .sort((a, b) => b.length - a.length);

  for (const term of terms) {
    if (/^[a-z0-9 ]+$/i.test(term)) {
      const pattern = new RegExp(`(^|\\s)${escapeRegExp(term)}(?=\\s|$)`, "g");
      text = text.replace(pattern, " ");
    } else {
      text = text.replaceAll(term, " ");
    }
  }

  return text.replace(/\s+/g, " ").trim();
}
```

这个修得很好。

之前这个 case：

```text
alias = doc
query = docker search
```

不会再把 `docker` 删成 `ker`。

同时中文 alias 仍然保留 substring 删除能力：

```text
alias = 钉钉文档
query = 钉钉文档搜索
=> 搜索
```

这个处理符合实际搜索场景。

---

## 1.3 `resolveServerName()` 的归一化已对齐

现在 `config-manager.ts`：

```ts
export function normalize(str: string): string {
  return str
    .trim()
    .toLowerCase()
    .replace(/[-_./:\s]+/g, " ");
}
```

这比上一版更统一。

现在这些输入更容易被解析到同一个 server：

```text
com.foo.mcp
com foo mcp
com/foo/mcp
com:foo:mcp
com-foo-mcp
com_foo_mcp
```

这对 dotted server key 很有帮助。

---

## 1.4 `parseQualifiedToolInput()` 已支持大小写不敏感

现在：

```ts
function parseQualifiedToolInput(
  input: string,
): { server: string; tool: string } | null {
  const text = input.trim();
  const lowerText = text.toLowerCase();
  const candidates = Object.keys(config.mcpServers).sort(
    (a, b) => b.length - a.length,
  );

  for (const serverName of candidates) {
    const prefix = `${serverName}.`;
    if (lowerText.startsWith(prefix.toLowerCase())) {
      return {
        server: serverName,
        tool: text.slice(prefix.length),
      };
    }
  }

  return null;
}
```

这个修复能覆盖：

```text
server key = com.foo.mcp
tool input = COM.FOO.MCP.search
```

不会再因为大小写不一致导致长前缀匹配失败。

---

# 2. 当前剩余最值得关注的问题

## 2.1 P2：server alias 冲突会被 `Map<string, string>` 吃掉

现在 `findServersMentionedInQueryFromConfig()` 和 `SearchIndex.findServersMentionedInQuery()` 都使用：

```ts
const nameToServer = new Map<string, string>();
```

如果两个 server 配了同一个 alias，会发生覆盖。

例如配置：

```json
{
  "mcpServers": {
    "notion": {
      "aliases": ["docs"]
    },
    "dingtalk-doc": {
      "aliases": ["docs"]
    }
  }
}
```

现在构建 map 时：

```ts
nameToServer.set("docs", "notion");
nameToServer.set("docs", "dingtalk-doc");
```

后者会覆盖前者。

于是用户 query：

```text
docs search
```

可能被误判成只命中一个 server：

```ts
mentionedServers.length === 1
```

然后进入 scoped search，导致另一个 server 被排除。

这个问题不是 P1，因为合理配置通常不应该重复 alias，但真实用户配置里很容易出现：

```text
doc
docs
文档
搜索
数据库
git
```

这类泛化 alias。

### 建议改成一名多 server

把：

```ts
const nameToServer = new Map<string, string>();
```

改成：

```ts
const nameToServers = new Map<string, Set<string>>();
```

辅助函数：

```ts
function addNameMapping(
  map: Map<string, Set<string>>,
  name: string,
  serverName: string,
): void {
  const key = normalizeForSearch(name);
  const set = map.get(key) ?? new Set<string>();
  set.add(serverName);
  map.set(key, set);
}
```

`index.ts` 里可以这样改：

```ts
function findServersMentionedInQueryFromConfig(
  query: string,
  servers: Record<string, ServerConfig>,
): string[] {
  const names: string[] = [];
  const nameToServers = new Map<string, Set<string>>();

  for (const [serverName, srvConfig] of Object.entries(servers)) {
    if (srvConfig.disabled) continue;

    for (const name of [serverName, ...(srvConfig.aliases || [])]) {
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
    if (!serversForName) continue;

    for (const serverName of serversForName) {
      result.add(serverName);
    }
  }

  return Array.from(result);
}
```

`SearchIndex.findServersMentionedInQuery()` 同理。

这样如果 `docs` 同时属于两个 server，就会返回两个 server：

```ts
mentionedServers.length === 2
```

不会错误 scoped 到单个服务，而是走多 server candidate 范围。

---

## 2.2 P2：`stripQualifiedPrefixForServer()` 仍然大小写敏感

你已经把 `parseQualifiedToolInput()` 改成大小写不敏感了，但 `stripQualifiedPrefixForServer()` 还是：

```ts
function stripQualifiedPrefixForServer(
  toolInput: string,
  serverName: string,
): string {
  const text = toolInput.trim();
  const prefix = `${serverName}.`;

  if (text.startsWith(prefix)) {
    return text.slice(prefix.length);
  }

  return text;
}
```

所以显式传 server 时：

```json
{
  "server": "siyuan-mcp",
  "tool": "SIYUAN-MCP.sql_query"
}
```

不会 strip 掉 `SIYUAN-MCP.`，最终会拿：

```text
SIYUAN-MCP.sql_query
```

去匹配真实工具名，导致 miss。

这个不算高频，但既然 `parseQualifiedToolInput()` 已经做了大小写不敏感，这里也建议顺手统一。

### 建议

```ts
function stripQualifiedPrefixForServer(
  toolInput: string,
  serverName: string,
): string {
  const text = toolInput.trim();
  const prefix = `${serverName}.`;

  if (text.toLowerCase().startsWith(prefix.toLowerCase())) {
    return text.slice(prefix.length);
  }

  return text;
}
```

这样不会改变真实工具名部分的大小写，因为 slice 仍基于原始 `text`。

---

## 2.3 P2：`stripQualifiedPrefixForServer()` 不支持 alias 前缀

当前支持：

```json
{
  "server": "思源",
  "tool": "siyuan-mcp.sql_query"
}
```

因为 `server` 会 resolve 成真实 key：

```text
siyuan-mcp
```

然后 strip `siyuan-mcp.`。

但不支持：

```json
{
  "server": "思源",
  "tool": "思源.sql_query"
}
```

因为只会尝试 strip：

```text
siyuan-mcp.
```

不会 strip：

```text
思源.
```

这不一定是 bug。严格来说 `qualifiedName` 应该使用真实 server key，不应该用 alias。

但从 LLM 调用容错角度，支持 alias 前缀会更友好。

### 如果想增强

可以这样写：

```ts
function stripQualifiedPrefixForServer(
  toolInput: string,
  serverName: string,
): string {
  const text = toolInput.trim();
  const cfg = config.mcpServers[serverName];

  const prefixes = [serverName, ...(cfg?.aliases || [])]
    .map((name) => `${name}.`)
    .sort((a, b) => b.length - a.length);

  const lowerText = text.toLowerCase();

  for (const prefix of prefixes) {
    if (lowerText.startsWith(prefix.toLowerCase())) {
      return text.slice(prefix.length);
    }
  }

  return text;
}
```

但这会让 helper 依赖全局 `config`。如果未来拆 `tool-locator.ts`，建议改成：

```ts
stripQualifiedPrefixForServer(toolInput, serverName, aliases)
```

---

# 3. Shutdown closeTimeout=0 仍建议加安全兜底

README 和代码现在一致：

```text
closeTimeoutMs = 0 表示禁用超时
```

`withTimeout()`：

```ts
if (ms <= 0) return promise;
```

但 `shutdownAndExit()` 里：

```ts
const closeTimeoutMs = config?.settings?.closeTimeoutMs ?? 10000;
await serverManager.shutdownAll(closeTimeoutMs, true);
process.exit(0);
```

如果用户配置：

```json
{
  "settings": {
    "closeTimeoutMs": 0
  }
}
```

父进程管道断开时，adapter 会无超时等待底层连接关闭。

这和配置语义一致，但对 death watch 来说不一定安全。理论上可能出现：

```text
stdin close
  -> shutdownAndExit
  -> shutdownAll
  -> 某个 transport.close 永久挂住
  -> adapter 无法及时退出
```

### 建议

保留普通 close 的 `0 = 禁用超时`，但 shutdown path 使用兜底硬超时：

```ts
async function shutdownAndExit(reason: string) {
  if (shutdownInProgress) return;
  shutdownInProgress = true;

  process.stdin.removeAllListeners("close");
  process.removeAllListeners("SIGINT");
  process.removeAllListeners("SIGTERM");

  writeLog(`[Shutdown] ${reason}\n`);

  lifecycleManager?.stopSweeper();

  const configuredCloseTimeoutMs = config?.settings?.closeTimeoutMs ?? 10000;
  const shutdownCloseTimeoutMs =
    configuredCloseTimeoutMs <= 0 ? 10000 : configuredCloseTimeoutMs;

  await serverManager.shutdownAll(shutdownCloseTimeoutMs, true);
  process.exit(0);
}
```

这能避免“死亡守卫自己也被无限等待卡住”。

---

# 4. 搜索链路当前状态

整体搜索链路已经比较完整：

```text
search_tools
  -> 显式 server 参数 resolve
  -> ensureServerMetadata
  -> searchIndex.search(query, targetServer)

无显式 server
  -> findServersMentionedInQueryFromConfig
  -> 唯一 server mention 则 ensure + scoped search
  -> 多 server mention 则 narrowed candidates
  -> 无 mention 则全局搜索

SearchIndex
  -> Fuse fuzzy
  -> rerank
  -> token fallback
  -> server browse fallback
```

现在几个关键点都做对了：

```text
scoped 搜索不再吃 server token 加分
query 仅命中 server name 时进入 browse
中文 bigram 兜底
英文 alias 删除有词边界
searchIndex 与 index.ts server mention 规则复用 findServersInText
```

我觉得搜索层已经可以内测使用。

---

# 5. 工具定位链路当前状态

现在工具定位也基本稳了：

```text
显式 server
  -> resolveServerName
  -> strip server prefix
  -> 在该 server cache 内找 tool

无显式 server + dotted input
  -> parseQualifiedToolInput 长前缀匹配
  -> fallback 首个点分割

无显式 server + simple input
  -> 全局 cache 搜索
  -> 多个则返回 conflict
```

当前只剩两个边界：

```text
显式 server 下 strip 前缀大小写敏感
显式 server 下不支持 alias.tool 前缀
```

建议至少修第一个。第二个看产品设计取舍。

---

# 6. `package.json` 仍是发布前最明显缺口

当前 `package.json` 还是：

```json
{
  "name": "@lancernix/mcp-adapter",
  "version": "1.0.0",
  "main": "dist/index.js",
  "type": "module",
  "bin": {
    "mcp-adapter": "dist/index.js"
  },
  "scripts": {
    "build": "tsc",
    "watch": "tsc -w",
    "start": "node dist/index.js"
  }
}
```

如果只是本地使用没问题。

如果要 npm 发布，建议最少补：

```json
{
  "files": [
    "dist",
    "README.md",
    "package.json"
  ],
  "scripts": {
    "build": "tsc",
    "watch": "tsc -w",
    "start": "node dist/index.js",
    "prepack": "npm run build"
  },
  "license": "MIT",
  "keywords": [
    "mcp",
    "model-context-protocol",
    "claude",
    "claude-code",
    "mcp-server",
    "tools",
    "gateway",
    "lazy-loading"
  ]
}
```

如果仓库已经公开，再补：

```json
{
  "repository": {
    "type": "git",
    "url": "https://github.com/lancernix/mcp-adapter.git"
  },
  "bugs": {
    "url": "https://github.com/lancernix/mcp-adapter/issues"
  },
  "homepage": "https://github.com/lancernix/mcp-adapter#readme"
}
```

最重要的是：

```json
"files": ["dist", "README.md", "package.json"]
```

和：

```json
"prepack": "npm run build"
```

否则发布包容易包含多余文件，或者发包时忘记构建。

---

# 7. README 建议补 npm 安装方式

README 现在仍然以源码构建为主：

```bash
git clone <repo-url> mcp-adapter
cd mcp-adapter
npm install
npm run build
npm link
```

如果要发布 `@lancernix/mcp-adapter`，建议补：

```bash
npm install -g @lancernix/mcp-adapter
```

Claude Code 配置也可以给全局命令版：

```json
{
  "mcpServers": {
    "mcp-adapter": {
      "command": "mcp-adapter",
      "args": []
    }
  }
}
```

以及 npx 版：

```json
{
  "mcpServers": {
    "mcp-adapter": {
      "command": "npx",
      "args": ["-y", "@lancernix/mcp-adapter"]
    }
  }
}
```

这会比 `node /path/to/dist/index.js` 对普通用户更友好。

---

# 8. 仍建议拆 `index.ts`

`index.ts` 现在仍然承担了太多职责：

```text
MCP server 初始化
meta tools 注册
search_tools handler
describe_tool handler
list_tools handler
execute_tool handler
bootstrap
shutdown
tool locator
CLI import
error classifier
schema formatter
```

现在可维护，但已经接近单文件复杂度上限。

下一阶段建议先拆：

```text
src/tool-locator.ts
src/bootstrap.ts
src/cli-import.ts
src/error-classifier.ts
src/search-response-format.ts
```

优先拆 `tool-locator.ts`，因为这部分最适合写单元测试：

```ts
parseQualifiedToolInput
stripQualifiedPrefixForServer
resolveServerFromToolInput
locateTool
```

测试 case 建议覆盖：

```text
1. dotted server key:
   com.foo.mcp.search

2. dotted server key + dotted tool:
   com.foo.mcp.docs.search

3. explicit server + dotted real tool:
   server=notion, tool=docs.search

4. explicit server + qualified dotted tool:
   server=notion, tool=notion.docs.search

5. uppercase qualified server:
   server=siyuan-mcp, tool=SIYUAN-MCP.sql_query

6. duplicate tool name:
   tool=search, no server => conflict

7. duplicate alias:
   alias=docs belongs to two servers => should not infer unique server
```

---

# 9. 建议发版前最小修复集

如果你想尽快发一个 npm 版本，我建议最小做这 3 件：

## 必修 1：补 `package.json` 发布字段

至少：

```json
"files": ["dist", "README.md", "package.json"],
"prepack": "npm run build",
"license": "MIT"
```

## 建议修 2：`stripQualifiedPrefixForServer()` 改大小写不敏感

```ts
function stripQualifiedPrefixForServer(
  toolInput: string,
  serverName: string,
): string {
  const text = toolInput.trim();
  const prefix = `${serverName}.`;

  if (text.toLowerCase().startsWith(prefix.toLowerCase())) {
    return text.slice(prefix.length);
  }

  return text;
}
```

## 建议修 3：server alias 冲突不要用 `Map<string, string>` 覆盖

把 `nameToServer` 改成：

```ts
Map<string, Set<string>>
```

避免共享 alias 导致错误单 server scoped。

---

# 10. 总体评价

这一版质量已经不错。

之前遗留的几个问题：

```text
英文 alias 误删单词内部
resolveServerName 与搜索归一化不一致
dotted server key 大小写不敏感解析
findServersMentionedInQueryFromConfig 二次遍历
```

这版都处理掉了。

当前剩余：

```text
alias 冲突覆盖
显式 server 下 strip prefix 大小写敏感
shutdown closeTimeout=0 可能无限等待
package.json 发布字段
README npm 安装方式
index.ts 拆分
```

我的结论：

> **代码主链路已经没有明显阻塞发布的问题。**
>
> 如果是本地自用/小范围内测：这一版可以直接用了。  
> 如果是 npm 正式发布：建议先补 `package.json` 发布字段，并顺手修掉 alias 冲突覆盖和 `stripQualifiedPrefixForServer()` 大小写敏感。