# @lancernix/mcp-adapter

一款专为海量工具场景（如数十个底座服务、数百个原子工具）打造的**标准通用 MCP 惰性分发网关**。

在重度 AI 编码或智能体协同场景中，注册过多的 MCP 服务常会面临以下致命痛点：
1. **Context 迅速暴涨：** 数十个 MCP 服务对应的数百个工具 Schema 统统塞入 System Prompt，每次对话前置开销可能高达数万 Token。
2. **冷启动极慢且极耗内存：** 每次 AI 客户端（如 Claude Code CLI）冷启动时，会瞬间并发拉起几十个物理子进程，内存开销数以 GB 计。在 2GB RAM 等低配云主机上会导致卡死或进程被 OOM 强杀。
3. **残留僵尸进程：** 父进程异常暴毙时，被拉起的底层 MCP 服务子进程无法释放，沦为僵尸进程霸占系统资源。

`@lancernix/mcp-adapter` 采用 **“元工具拦截 + JIT 惰性唤醒 + 自消退释放 + 管道死亡守卫”** 的四重保障，完美解决上述痛点。

---

## 核心特性

- 🛡️ **Context Token 挽救：** 物理拦截真实 Tools 的入参 Schema。网关对外**仅暴露 4 个元工具**（`search_tools`, `list_tools`, `describe_tool`, `execute_tool`），将大模型 System Prompt 阶段的工具提示词开销骤降 **95% 以上**。其中 `search_tools` 返回完整 `inputSchema`，通常可直接进入 `execute_tool`；`list_tools` 提供轻量全量工具名目录作为兜底。
- ⚡ **冷启动与惰性 JIT 唤醒 (Lazy Loading)：** 当 metadata cache 有效时，adapter 启动不会唤醒任何底层 MCP server。首次 cache 为空或部分失效时，adapter 会先接入客户端，再在后台顺序刷新缺失 metadata；每个 server 刷新完成后，若连接由 metadata refresh 临时创建则立即关闭；若该连接正在被其他请求复用则不会误关，后续交由 idle sweeper 自动释放。
- ⏳ **闲置消退与自动降温 (Idle Autorelease)：** 内置 30s 扫描周期的 Sweeper。当底层服务闲置超过指定阈值（默认全局 10 分钟，支持单服务自定义）时，平滑杀死底层子进程并断开连接，彻底释放物理内存。
- 💀 **死亡守卫 (Parent Death Watch)：** 拦截父进程的 `stdin` 的 `close` 事件与常规终止信号（`SIGINT`/`SIGTERM`），当父进程退出或管道破裂时，立即进入清理流程，尽力关闭所有底层连接与子进程，避免僵尸进程残留。
- 🔍 **混合工具搜索（BM25 + Fuse.js Token Search + IDF Rerank）：** 搜索层结合轻量 BM25 关键词召回、Fuse.js Token Search 多词模糊匹配，以及 IDF 加权字段命中重排。支持中英混合、中文服务别名、typo、多词乱序搜索。自动降低 `get`/`list`/`search`/`query` 等泛词影响，优先提升工具名、服务别名、稀有关键词的权重。Fuse Token Search 支持 `tokenMatch: "any"` 以保留部分 token 命中的召回能力，中文搜索通过 `Intl.Segmenter` 与 bigram 兜底增强。搜索结果通过 `matchReasons` 输出匹配依据和置信度，帮助模型判断是否可直接执行或需要先 `describe_tool`。
- 📦 **一键无损迁移 (CLI Config Migration)：** 提供一键 CLI 导入工具，可无损迁移现有的 MCP 声明（如 `~/.claude.json`），根据服务名自动生成基础 aliases，保留源配置中已有 aliases。

---

## 系统架构与实现逻辑

网关作为 AI 客户端（如 Claude Code、Claude Desktop）与底层海量真实 MCP Server 之间的中间层，其运作模型如下：

```
                    ┌────────────────────────┐
                    │ AI Client (Claude CLI) │
                    └───────────┬────────────┘
                                │ StdIO 通道
                                ▼
         ┌──────────────────────────────────────────────┐
         │            @lancernix/mcp-adapter            │
         │  (仅暴露 4 个元工具，物理拦截真实 Schema)   │
         └──────┬───────────────────────┬───────────────┘
                │                       │
                ├─ (1) search_tools     ├─ (2) list_tools
                │  智能搜索，返回完整    │  浏览指定 server 的
                │  inputSchema           │  全部工具名
                │                       │
                ▼                       ▼
         ┌──────────────────────────────────────────────┐
         │  (3) describe_tool        (4) execute_tool   │
         │  查询单个工具完整 Schema   惰性唤醒并执行     │
         └──────┬───────────────────────┬───────────────┘
                │                       │
                ▼                       ▼
        ┌───────────────┐       ┌───────────────┐
        │  MCP Server A │       │  MCP Server B │
        └───────────────┘       └───────────────┘
```

### 文件系统布局

网关默认会将配置、缓存和日志保存在当前用户的家目录：

```bash
~/.mcp-adapter/
├── config.json  # 注册的真实底层 MCP 服务与全局设置
├── cache.json   # 缓存的所有底层服务的工具 Schema、哈希校验指纹与抓取时间
└── logs/        # debug=true 时写入的文件日志目录；默认仅输出到 stderr
```
*注：可通过环境变量 `MCP_ADAPTER_HOME` 自定义上述工作根路径。*

---

## 4 个对外元工具 (Meta-Tools)

### 1. `search_tools`
* **功能：** 首选工具发现入口。检索所有配置的 MCP 工具，模糊匹配工具名、服务名、别名和描述正文。
* **设计细节：** 返回候选工具的描述与完整 `inputSchema`，通常可直接据此调用 `execute_tool`。当 query 命中某个 server 但功能关键词未强匹配时，会返回该 server 下的候选工具作为兜底。为避免极端复杂工具 Schema 造成单次响应过大，`search_tools` 会对超长 `inputSchema` 做安全截断；如需完整 Schema，请使用 `describe_tool` 查询单个工具。
* **参数：**
  * `query` (string, 必填): 想要实现的诉求或功能关键字（如 `"siyuan sql"`, `"钉钉文档"`, `"search"`）。
  * `server` (string, 可选): 目标服务提示（hint）。可填写真实 server key、中文名、英文名、aliases 或近似名称。高置信匹配时会在对应服务下窄化检索；存在歧义或低置信时会回退全局搜索，并将该提示作为搜索关键词参与排序。
  * `limit` (number, 可选): 返回条数，默认 10，最大 20。

### 2. `list_tools`
* **功能：** 列出指定 MCP Server 的全部工具名称。
* **设计细节：** 仅返回工具名，不返回描述和参数 Schema。用于 `search_tools` 结果不理想时的目录式兜底浏览。看到疑似工具名后，再调用 `describe_tool` 获取完整 schema。
* **参数：**
  * `server` (string, 必填): 服务名或 aliases。
  * `limit` (number, 可选): 最多返回工具数量，默认全量，最大 500。

### 3. `describe_tool`
* **功能：** 获取指定单个工具的完整定义与入参 Schema。
* **使用场景：** 已知工具名后确认参数，尤其适合从 `list_tools` 返回的工具名中选择疑似工具后调用。日常工具发现推荐优先使用 `search_tools`，因为其已返回完整 `inputSchema`，通常可直接 `execute_tool`。
* **参数：**
  * `tool` (string, 必填): 工具全名（如 `"siyuan-mcp.sql_query"`）或单纯的工具名。
  * `server` (string, 可选): 用于解决同名工具冲突，指定服务名或别名。

### 4. `execute_tool`
* **功能：** 执行底层的真实工具。如果子进程处于休眠状态，会即时进行 Lazy 惰性唤醒、建立握手并分发，执行完毕后原样返回底层最真实的结果。
* **参数：**
  * `tool` (string, 必填): 真实的工具全名（如 `"siyuan-mcp.sql_query"`）。
  * `server` (string, 可选): 用于多服务同名工具冲突时窄化范围。
  * `arguments` (object, 可选): 符合该底层工具入参 Schema 的真实键值对。

---

## 安装与配置

### npm 全局安装（推荐）

```bash
npm install -g @lancernix/mcp-adapter
```

安装后直接运行：

```bash
mcp-adapter
```

### npx 直接使用（无需安装）

在 MCP 客户端配置中直接使用 npx，无需提前安装：

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

### 源码克隆并构建

```bash
git clone <repo-url> mcp-adapter
cd mcp-adapter
npm install
npm run build
```

构建产物位于 `dist/` 目录。你可以将其链接到全局以便在任何地方调用：

```bash
npm link
# 链接后可在系统任意位置通过 mcp-adapter 命令启动
```

### 2. 一键无损迁移

若你此前已在 `~/.claude.json` 中配置了大量的 MCP Server，可以使用内置迁移工具一键导入：

**npx 直接使用（推荐，无需安装）：**

```bash
# 预览导入内容，不写入（推荐先执行此步骤确认无误）
npx -y @lancernix/mcp-adapter import --dry-run

# 确认无误后正式导入
npx -y @lancernix/mcp-adapter import
```

`--from` 参数可选。默认从 `~/.claude.json` 读取，如果你的配置文件在其他路径，可通过 `--from <path>` 指定。

**npm 全局安装后：**

```bash
mcp-adapter import --dry-run
mcp-adapter import
```

**源码构建后：**

```bash
node dist/index.js import --dry-run
node dist/index.js import
```

---

## 配置详解 (`config.json`)

默认配置文件结构如下：

```json
{
  "version": 1,
  "settings": {
    "idleTimeout": 10,
    "cacheTtlDays": 7,
    "toolSearchLimit": 10,
    "metadataBootstrap": "background",
    "debug": false,
    "connectTimeoutMs": 60000,
    "requestTimeoutMs": 60000,
    "closeTimeoutMs": 10000
  },
  "mcpServers": {
    "siyuan-mcp": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/siyuan-mcp/dist/index.js"],
      "env": {
        "SIYUAN_API_KEY": "xxxx"
      },
      "lifecycle": "lazy",
      "idleTimeout": 5,
      "aliases": ["思源", "笔记", "siyuan"]
    },
    "dingtalk-doc": {
      "type": "http",
      "url": "https://mcp-gw.dingtalk.com/server/xxx?key=xxx",
      "lifecycle": "lazy",
      "refreshOnStartup": true,
      "aliases": ["钉钉", "钉钉文档"]
    }
  }
}
```

### 全局 `settings`
| 字段 | 类型 | 默认值 | 描述 |
| :--- | :--- | :--- | :--- |
| `idleTimeout` | `number` | `10` | 默认全局子进程闲置自动退出的时间（单位：分钟） |
| `cacheTtlDays` | `number` | `7` | 工具缓存的有效生存期（天），过期后会在后台 bootstrap、search_tools/describe_tool 明确定位 server 时自动刷新。设为 `0` 表示缓存不因 TTL 过期（仅在 server 配置哈希变化时自动刷新） |
| `toolSearchLimit` | `number` | `10` | `search_tools` 默认返回数量。单次调用最大 20 |
| `metadataBootstrap` | `"background"` \| `"off"` | `"background"` | 启动后是否在后台自动刷新缺失/失效的 metadata 缓存 |
| `debug` | `boolean` | `false` | 是否开启文件日志。默认仅输出到 stderr；设为 `true` 后会额外写入 `logs/mcp-adapter.log`。日志持续追加，请仅在排查问题时开启并定期清理 |
| `connectTimeoutMs` | `number` | `60000` | 连接底层 MCP 服务的超时时间（毫秒）。设为 `0` 表示禁用超时 |
| `requestTimeoutMs` | `number` | `60000` | `listTools` / `callTool` 等请求的超时时间（毫秒）。设为 `0` 表示禁用超时 |
| `closeTimeoutMs` | `number` | `10000` | 关闭底层连接的超时时间（毫秒）。设为 `0` 表示禁用超时 |

### 服务专属 `mcpServers` 配置项
除了标准的 `command`、`args`、`env`、`cwd` 字段，网关新增了如下扩展配置：
* `type` (string, 默认 `"stdio"`): 连接方式。
  * `"stdio"`: 本地子进程（需配置 `command` + `args`）。
  * `"http"` / `"sse"`: 远程服务（需配置 `url`，可选 `headers`）。
* `url` (string, HTTP/SSE 必填): 远程 MCP 服务端点地址。
* `headers` (object, 可选): HTTP/SSE 请求附加的自定义请求头。
* `lifecycle` (string, 默认 `"lazy"`): 
  * `"lazy"`: 惰性连接。按需唤醒进程，闲置超过 `idleTimeout` 自动杀死释放物理内存（推荐，低内存宿主机黄金搭档）。
  * `"eager"` / `"keep-alive"`: 预留模式。当前版本仅表示服务一旦被连接后不参与 idle sweeper，不会因空闲被自动关闭；冷启动主动拉起将在后续版本支持。
* `idleTimeout` (number, 可选): 覆盖全局设置，单独指定该子进程闲置被杀死的超时时间（分钟）。
* `aliases` (string[], 可选): 服务器别名。可定义该服务的中文别名（如 `["思源", "思源笔记"]`），`search_tools` 会将其无缝纳入权重检索中。
* `disabled` (boolean, 可选): 设为 `true` 则会在模糊搜索及工具执行时临时屏蔽该服务（`search_tools` 不会列出其工具，`execute_tool` 会拒绝调用）。
* `refreshOnStartup` (boolean, 可选): 设为 `true` 时，该 server 会在 adapter 每次启动后的后台 bootstrap 中强制刷新 metadata cache，跳过缓存有效性检查。推荐用于 HTTP/SSE 等在线服务或工具列表可能动态变化的服务。对 stdio 服务也生效，但会在每次启动后后台拉起对应子进程，请谨慎开启。
* `connectTimeoutMs` / `requestTimeoutMs` / `closeTimeoutMs` (number, 可选): 覆盖全局对应超时设置，单位为毫秒。适用于个别响应较慢的服务（如报表生成类工具）。

### aliases 最佳实践

`aliases` 直接影响 `search_tools` 的服务识别、query 中服务名检测和搜索结果排序加权。**如果你的服务使用了中文名或其他常用别称，强烈建议配置 aliases。**

`search_tools` 的 `server` 参数是**服务提示（hint）**，不要求精确的 server key。你可以填入自然语言服务名、中文名、别名或近似名称（如 `"钉钉文档"`、`"dingtalk"`、`"dingtalk doc"`），网关会自动尝试匹配。如果无法高置信匹配，会自动回退全局搜索而不是报错。

推荐配置如下：

```json
{
  "mcpServers": {
    "dingtalk-doc": {
      "aliases": ["钉钉", "钉钉文档", "dingtalk", "dingtalk doc", "dingding"]
    },
    "siyuan-mcp": {
      "aliases": ["思源", "思源笔记", "siyuan", "siyuan note"]
    },
    "feishu-bitable": {
      "aliases": ["飞书", "飞书多维表格", "多维表格", "bitable", "feishu", "lark"]
    },
    "github": {
      "aliases": ["GitHub", "github.com", "gh"]
    }
  }
}
```

规则：
- 中文服务名**必须**配置 aliases，网关不会自动生成中文变体
- 英文 server key 中的分隔符（`-`、`_`、`.`）会被自动归一化为空格，无需单独配置 `dingtalkdoc` 之类变体
- `search_tools` 会优先匹配 aliases 精确命中项并加权排序
- 如果你不确定 aliases 是否足够，可以在实际使用 `search_tools` 时观察匹配结果中的 `matchReasons` 来调整

---

## 客户端接入示例

### 在 Claude Code 中接入

**npm 全局安装后：**

```json
{
  "mcpServers": {
    "mcp-adapter": {
      "command": "mcp-adapter"
    }
  }
}
```

**npx 直接使用：**

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

**源码构建后：**

```json
{
  "mcpServers": {
    "mcp-adapter": {
      "command": "node",
      "args": ["/path/to/mcp-adapter/dist/index.js"]
    }
  }
}
```
配置完成后，Claude 冷启动阶段只需加载 mcp-adapter 和 4 个元工具。若 metadata cache 已有效，adapter 不会唤醒真实 MCP；若 cache 缺失或失效，adapter 会在接入客户端后于后台顺序刷新 metadata。若刷新过程中临时创建了连接，则该 server 刷新完成后立即关闭；若该连接正在被其他请求复用，则不会误关，后续交由 idle sweeper 自动释放。Claude 也只会获得 `search_tools` 等 4 个元工具。当 Claude 检索或调用具体功能时，网关将在幕后惰性地调度对应的真实底层进程。

---

## 开发者提示

### 缓存自举引导
网关启动时若检测到 `cache.json` 为空但 `config.json` 中已配置服务，会在**接入客户端之后**，于后台依次连接所有非禁用服务，拉取工具列表写入缓存。若刷新过程中临时创建了连接，则拉取完成后立即关闭；若该连接正在被其他请求复用，则不会误关，后续交由 idle sweeper 释放。启动完成后 `search_tools` 可逐步检索到工具，无需手动触发。可通过 `settings.metadataBootstrap` 设为 `"off"` 关闭此后台行为。

缓存刷新的两个时机：
* **哈希变更**：`config.json` 中某服务的 `command`、`args`、`env`、`url` 等影响工具集的字段发生变化 → 下次连接时自动重新发现
* **TTL 过期**：缓存条目超过 `cacheTtlDays`（默认 7 天） → 下次 metadata 刷新时自动重新发现

> **为什么只缓存 tools，不缓存 prompts 和 resources？**
> 
> MCP 协议定义了三种能力：Tools、Prompts、Resources。当前 `mcp-adapter` 仅缓存和代理 Tools，原因：
> * **Tools** 是唯一有数量爆炸问题的能力——几十个服务 × 几十个工具 × 复杂 Schema = 数万 token 上下文开销，必须拦截。
> * **Prompts** 生态未成熟，Claude Code 当前版本不支持 MCP Prompts，实际无人使用。
> * **Resources** 数量通常很少（每个服务 5-10 个），且通过 URI 直接引用（`@server:resource/path`），不需要模糊搜索发现。

### 缓存哈希
网关通过 **黑名单策略** 计算每个服务的配置指纹：排除 `aliases`、`lifecycle`、`disabled`、`idleTimeout`、`refreshOnStartup`、`connectTimeoutMs`、`requestTimeoutMs`、`closeTimeoutMs` 等 adapter 元数据字段，其余所有字段（`type`、`command`、`args`、`env`、`cwd`、`url`、`headers` 及未来新增字段）全部纳入 SHA256。配置不变则复用缓存，变更则自动重新发现。

### 代码规范与自愈
* 项目基于 TypeScript 编写。修改代码后，需执行 `npm run build` 生成生产 JavaScript。
* 底层通信严格遵循官方标准 MCP 协议，支持 SDK 内置的 Stdio、Streamable HTTP、SSE 三种传输方式。认证信息可通过 `headers` 或 `env` 配置传入。
* 代码使用 biome 作为 linter/formatter，TS 编译启用 `strict` 模式。已消除所有显式 `any`（仅保留一处 SDK 类型兼容所需的 `as any`）和非空断言。

### 进程看护
* 强烈建议在低配 VPS 上开启 `"lifecycle": "lazy"`。网关会在高频调用后进入闲置轮询，将进程优雅退温，宿主机将始终保持轻量健康的负载表现。
* 父进程崩溃或管道断开时，Death Watch 守卫会在统一的 `shutdownAndExit` 流程中先移除 `stdin.close` / `SIGINT` / `SIGTERM` 监听器，并通过 once guard 防止二次清理。
