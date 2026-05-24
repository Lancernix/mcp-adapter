# @lancernix/mcp-adapter

一款专为海量工具场景（如数十个底座服务、数百个原子工具）打造的**标准通用 MCP 惰性分发网关**。

在重度 AI 编码或智能体协同场景中，注册过多的 MCP 服务常会面临以下致命痛点：
1. **Context 迅速暴涨：** 数十个 MCP 服务对应的数百个工具 Schema 统统塞入 System Prompt，每次对话前置开销可能高达数万 Token。
2. **冷启动极慢且极耗内存：** 每次 AI 客户端（如 Claude Code CLI）冷启动时，会瞬间并发拉起几十个物理子进程，内存开销数以 GB 计。在 2GB RAM 等低配云主机上会导致卡死或进程被 OOM 强杀。
3. **残留僵尸进程：** 父进程异常暴毙时，被拉起的底层 MCP 服务子进程无法释放，沦为僵尸进程霸占系统资源。

`@lancernix/mcp-adapter` 采用 **“元工具拦截 + JIT 惰性唤醒 + 自消退释放 + 管道死亡守卫”** 的四重保障，完美解决上述痛点。

---

## 核心特性

- 🛡️ **Context Token 挽救：** 物理拦截真实 Tools 的入参 Schema。网关对外**有且仅暴露 3 个极简元工具**（`search_tools`, `describe_tool`, `execute_tool`），将大模型 System Prompt 阶段的工具提示词开销骤降 **95% 以上**。
- ⚡ **冷启动与惰性 JIT 唤醒 (Lazy Loading)：** 启动网关只需几毫秒，不唤醒任何底层子进程。仅当执行 `execute_tool` 调用具体工具时，才会毫秒级建立底层连接。
- ⏳ **闲置消退与自动降温 (Idle Autorelease)：** 内置 30s 扫描周期的 Sweeper。当底层服务闲置超过指定阈值（默认全局 10 分钟，支持单服务自定义）时，平滑杀死底层子进程并断开连接，彻底释放物理内存。
- 💀 **死亡守卫 (Parent Death Watch)：** 拦截父进程的 `stdin` 的 `close` 事件与常规终止信号（`SIGINT`/`SIGTERM`），当父进程暴毙或管道破裂时，在 **10 毫秒内**自毁并强杀所有底层真实物理子进程，绝不残留僵尸。
- 🔍 **智能模糊搜索 (Fuse.js)：** 采用 Fuse.js 本地模糊搜索，对服务名、别名、工具名、描述进行综合检索，其判定与排序遵照黄金加权配比。支持拼写校正，并统一输出 `0~100` 的直观匹配分数。
- 📦 **一键无损迁移 (CLI Config Migration)：** 提供一键 CLI 导入工具，可无损迁移现有的 MCP 声明（如 `~/.claude.json`），并智能分析追加常用服务（思源、钉钉、Wiki 等）的中英文别名。

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
         │  (有且仅暴露 3 个元工具，物理拦截真实 Schema)  │
         └──────┬───────────────────────┬───────────────┘
                │                       │
                ├─ (1) search_tools     ├─ (2) describe_tool
                │  基于本地缓存快速检索  │  返回缓存中的工具 Schema
                │                       │
                ▼                       ▼
         ┌──────────────────────────────────────────────┐
         │               (3) execute_tool               │
         │  1. 检测底层服务是否已连接 (已连接? 直接调用) │
         │  2. 若未连接 -> 毫秒级 JIT 惰性唤醒子进程    │
         │  3. 完成调用 -> 原样返回结果 -> 刷新闲置计时 │
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
└── logs/        # 运行日志
```
*注：可通过环境变量 `MCP_ADAPTER_HOME` 自定义上述工作根路径。*

---

## 3 个对外元工具 (Meta-Tools)

### 1. `search_tools`
* **功能：** 检索所有配置的 MCP 工具。模糊匹配工具名、别名、领域和服务描述。
* **设计细节：** 默认不返回庞大的入参 Schema，以防挤占 Context。返回格式清晰的列表与评分（0-100）。
* **参数：**
  * `query` (string, 必填): 想要实现的诉求或功能关键字（如 `"siyuan sql"`, `"钉钉文档"`, `"search"`）。
  * `server` (string, 可选): 指定仅在特定的服务名或别名下窄化检索。
  * `limit` (number, 可选): 返回条数，默认 10。

### 2. `describe_tool`
* **功能：** 获取指定工具的完整入参 Schema。在大模型首次调用或对齐参数时使用。
* **参数：**
  * `tool` (string, 必填): 工具全名（如 `"siyuan-mcp.sql_query"`）或单纯的工具名。
  * `server` (string, 可选): 用于解决同名工具冲突，指定服务名或别名。

### 3. `execute_tool`
* **功能：** 执行底层的真实工具。如果子进程处于休眠状态，会即时进行 Lazy 惰性唤醒、建立握手并分发，执行完毕后原样返回底层最真实的结果。
* **参数：**
  * `tool` (string, 必填): 真实的工具全名（如 `"siyuan-mcp.sql_query"`）。
  * `server` (string, 可选): 用于多服务同名工具冲突时窄化范围。
  * `arguments` (object, 可选): 符合该底层工具入参 Schema 的真实键值对。

---

## 安装与配置

### 1. 克隆并构建

```bash
cd /home/ubuntu/bot-workspace/repos/mcp-adapter
npm install
npm run build
```

你可以将其链接到全局以便在任何地方调用：
```bash
npm link
# 链接后可在系统任意位置通过 mcp-adapter 命令启动
```

### 2. 一键无损迁移

若你此前已在 `~/.claude.json` 中配置了大量的 MCP Server，可以使用内置迁移工具一键导入：

```bash
# 执行无损迁移
node dist/index.js import --from ~/.claude.json

# 迁移成功后，配置将被合流并原子写入 ~/.mcp-adapter/config.json 中
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
    "enableFuseSearch": true
  },
  "mcpServers": {
    "siyuan-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/siyuan-mcp/dist/index.js"],
      "env": {
        "SIYUAN_API_KEY": "xxxx"
      },
      "lifecycle": "lazy",
      "idleTimeout": 5,
      "aliases": ["思源", "笔记", "siyuan"]
    }
  }
}
```

### 全局 `settings`
| 字段 | 类型 | 默认值 | 描述 |
| :--- | :--- | :--- | :--- |
| `idleTimeout` | `number` | `10` | 默认全局子进程闲置自动退出的时间（单位：分钟） |
| `cacheTtlDays` | `number` | `7` | 工具缓存的有效生存期，过期后在执行连接时自愈重新拉取 |
| `toolSearchLimit` | `number` | `10` | 模糊搜索默认返回的工具数量上限 |
| `enableFuseSearch` | `boolean` | `true` | 是否启用 Fuse.js 模糊匹配搜索引擎 |

### 服务专属 `mcpServers` 配置项
除了标准的 `command`、`args`、`env`、`cwd` 字段，网关新增了如下扩展配置：
* `lifecycle` (string, 默认 `"lazy"`): 
  * `"lazy"`: 惰性连接。按需唤醒进程，闲置超过 `idleTimeout` 自动杀死释放物理内存（推荐，低内存宿主机黄金搭档）。
  * `"eager"` / `"keep-alive"`: 预留用于强常驻模式（在网关冷启动时直接全量拉起，且永不消退，未来扩展支持）。
* `idleTimeout` (number, 可选): 覆盖全局设置，单独指定该子进程闲置被杀死的超时时间（分钟）。
* `aliases` (string[], 可选): 服务器别名。可定义该服务的中文别名（如 `["思源", "思源笔记"]`），`search_tools` 会将其无缝纳入权重检索中。
* `disabled` (boolean, 可选): 设为 `true` 则会在模糊搜索及执行时临时屏蔽该服务。

---

## 客户端接入示例

### 在 Claude Code 中接入
通过 `HOME=/home/ubuntu` 运行 Claude CLI，或者在 Claude CLI 配置中添加本服务。以全局 `mcp-adapter` 为例：

```json
{
  "mcpServers": {
    "mcp-adapter": {
      "command": "node",
      "args": ["/home/ubuntu/bot-workspace/repos/mcp-adapter/dist/index.js"]
    }
  }
}
```
配置完成后，Claude 在冷启动时将**仅启动 mcp-adapter 这一物理进程**，不占用额外内存。Claude 也只会获得 `search_tools` 等 3 个元工具。当 Claude 检索或调用具体功能时，网关将在幕后惰性地调度对应的真实底层进程。

---

## 开发者提示

### 1. 代码规范与自愈
* 项目基于 TypeScript 编写。修改代码后，需执行 `npm run build` 生成生产 JavaScript。
* 底层通信严格遵循官方标准 MCP Stdio 规范。
* 连接握手成功后，网关在抓取 Schema 时会**自动计算 config 指纹并更新 cache.json**，确保配置更新后自动同步工具列表。

### 2. 进程看护
* 强烈建议在低配 VPS 上开启 `"lifecycle": "lazy"`。网关会在高频调用后进入闲置轮询，将进程优雅退温，宿主机将始终保持轻量健康的负载表现。
