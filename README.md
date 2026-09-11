# @lancernix/mcp-adapter

把几十个 MCP 服务、几百个工具，收敛成 **4 个元工具**。

mcp-adapter 是一个本地 MCP 网关。它挡在你的 AI 客户端和所有真实 MCP 服务之间，让客户端只需要认识 4 个元工具，剩下的工具发现与调度交给网关在幕后完成。

---

## 它解决什么问题

**问题一：上下文被工具 Schema 吃光。** MCP 的工作方式是客户端启动时把所有服务的所有工具定义（名称、描述、完整入参 JSON Schema）一次性塞进 System Prompt。服务一多，这部分固定开销就会涨到几万 token，每一轮对话都在为它买单——哪怕这次对话一个工具都用不上。

**问题二：冷启动又慢又吃内存。** 客户端启动时会并发拉起每个 stdio 服务对应的子进程。几十个服务同时起来，在 2GB 内存的小机器上很容易卡死或被 OOM 杀掉。

**实际效果。** 在一个真实配置（7 个 MCP 服务 / 410 个工具）上测量：

| 指标 | 直连 | 经 mcp-adapter | 变化 |
| :--- | :--- | :--- | :--- |
| 初始上下文 token | ≈ 98.7k | ≈ 20.8k | **约 -79%** |
| 启动时拉起的本地子进程 | 每个 stdio 服务一个 | 0（惰性唤醒） | 首次真实调用时才拉起 |

压缩幅度随服务与工具数量增长而放大：服务越多、Schema 越复杂，省得越多。20.8k 这个数字主要来自 4 个元工具自身的固定开销和少量补充信息，不再随底层工具数量线性膨胀。

> 关于"内存"：mcp-adapter 不优化单个底层服务自身的内存占用。它省的是**「每个 AI 客户端都要常驻一整套完整 stdio 服务集合」**这件事——服务只在真正被调用的那一刻才启动，闲置后自动退出。

---

## 怎么工作（30 秒版）

```
        AI 客户端
            │ 只看到 4 个元工具
            ▼
   ┌─────────────────────┐
   │    mcp-adapter      │   ← 工具目录（缓存）+ 按需调度
   └──────┬──────────────┘
          │ 用到哪个才拉起哪个
          ▼
   MCP Server A / B / C ...
```

对外只暴露 4 个元工具：

| 元工具 | 一句话作用 |
| :--- | :--- |
| `search_tools` | **默认入口。** 用自然语言描述你要干什么，返回匹配的工具、说明、匹配依据和完整入参 Schema |
| `list_tools` | 按服务列出全部工具名。搜索效果不理想时的目录式兜底 |
| `describe_tool` | 查看单个工具的完整入参 Schema。低置信或 Schema 过长时用来确认 |
| `execute_tool` | 执行真实工具。目标服务没在运行就即时唤醒，执行完原样返回结果 |

模型侧的典型链路是 **`search_tools` → `execute_tool`** 两步：搜索一次就拿到了入参 Schema，高置信时可以直接执行。不确定时才插入 `describe_tool` 确认。

---

## 快速开始

### 方式一：让 AI 助手帮你装（推荐）

把下面这句话原样发给你的 AI 助手（Claude Code、Cursor、Codex 等），它会自己读完安装指南并把步骤执行完：

> 读一下 https://raw.githubusercontent.com/Lancernix/mcp-adapter/master/llm-install.md ，按里面的步骤帮我把 mcp-adapter 装好，并导入我现有的 MCP 配置。

这份指南（[`llm-install.md`](./llm-install.md)）是**专门写给 AI 读的**：包含支持的客户端列表、`import` 命令的 dry-run 与正式导入、客户端配置回写、aliases 配置建议和安装验证清单。你也可以自己照着做。

### 方式二：手动配置客户端

在你现有的 MCP 客户端配置里加一个 `mcp-adapter` 条目即可。

Claude Code（`~/.claude.json`）：

```json
{
  "mcpServers": {
    "mcp-adapter": {
      "command": "npx",
      "args": ["-y", "@lancernix/mcp-adapter@latest"],
      "env": { "MCP_ADAPTER_HOME": "~/.mcp-adapter" }
    }
  }
}
```

OpenCode（`~/.config/opencode/opencode.json`）：

```json
{
  "mcp": {
    "mcp-adapter": {
      "type": "local",
      "command": ["npx", "-y", "@lancernix/mcp-adapter@latest"],
      "environment": { "MCP_ADAPTER_HOME": "~/.mcp-adapter-opencode" }
    }
  }
}
```

显式写 `MCP_ADAPTER_HOME` 是为了让多个 AI 客户端各用各的配置与缓存，互不干扰。npx 首次运行会把包缓存下来，之后启动不再下载。

也可以全局安装后直接使用：

```bash
npm install -g @lancernix/mcp-adapter
```

### 方式三：导入已有的 MCP 配置

已经把一堆服务配在 Claude Code / OpenCode 里了？用内置的 `import` 命令迁移到 mcp-adapter 的工作区，不用手抄。

```bash
# 1. 先预览，看会导入哪些、跳过哪些
npx -y @lancernix/mcp-adapter@latest import --client claude --from ~/.claude.json --dry-run

# 2. 确认无误后正式导入（只写 mcp-adapter 自己的 config.json，不动客户端配置）
npx -y @lancernix/mcp-adapter@latest import --client claude --from ~/.claude.json

# 3. 可选：把客户端 MCP 区域替换成单个 mcp-adapter 入口
npx -y @lancernix/mcp-adapter@latest import --client claude --from ~/.claude.json --write-client-config
```

支持的客户端与默认路径：

| 客户端 | `--client` | 默认配置路径 |
| :--- | :--- | :--- |
| Claude Code | `claude` | `~/.claude.json` |
| OpenCode | `opencode` | `$OPENCODE_CONFIG` 或 `~/.config/opencode/opencode.json` |

工作区（`MCP_ADAPTER_HOME`）默认位置：

```text
~/.mcp-adapter/                 # Claude Code
~/.mcp-adapter-opencode/        # OpenCode
├── config.json                 # 你注册的真实 MCP 服务 + 全局设置
├── cache.json                  # 自动生成的工具目录缓存，不用手改
└── logs/                       # 仅 debug: true 时写入
```

---

## 配置

网关的所有行为都在工作区的 `config.json` 里。完整示例：

```json
{
  "version": 1,
  "settings": {
    "idleTimeout": 10,
    "cacheTtlDays": 7,
    "toolSearchLimit": 10,
    "startupMetadataCheck": true,
    "debug": false,
    "connectTimeoutMs": 60000,
    "requestTimeoutMs": 60000,
    "closeTimeoutMs": 10000,
    "failureBackoffMs": 60000
  },
  "mcpServers": {
    "siyuan-mcp": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/siyuan-mcp/dist/index.js"],
      "env": { "SIYUAN_API_KEY": "xxxx" },
      "lifecycle": "lazy",
      "idleTimeout": 5,
      "aliases": ["思源", "笔记", "siyuan"]
    },
    "dingtalk-doc": {
      "type": "http",
      "url": "https://mcp-gw.dingtalk.com/server/xxx?key=xxx",
      "aliases": ["钉钉", "钉钉文档"]
    }
  }
}
```

> 通常你不需要手写这个文件——用上面的 `import` 命令生成即可。只有在调优（配 aliases、改超时、隐藏工具）时才需要改它。

### 全局 `settings`

| 字段 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `idleTimeout` | number | `10` | 闲置多少分钟（后自动回收子进程）。设为 `<= 0` 表示**禁用自动回收** |
| `cacheTtlDays` | number | `7` | 工具目录缓存的保鲜期（天）。设为 `0` 表示不因时间过期，只在服务配置变化时重刷 |
| `toolSearchLimit` | number | `10` | `search_tools` 默认返回条数，单次最多 20 |
| `startupMetadataCheck` | boolean | `true` | 启动后是否在后台做一次缓存体检（详见下方说明） |
| `debug` | boolean | `false` | 开启后额外把日志写入 `logs/mcp-adapter.log`。排查问题时再开，日志会持续追加 |
| `connectTimeoutMs` | number | `60000` | 连接底层服务的超时（毫秒），`0` 表示不限 |
| `requestTimeoutMs` | number | `60000` | 单次工具调用 / 拉取工具列表的超时（毫秒），`0` 表示不限 |
| `closeTimeoutMs` | number | `10000` | 关闭底层连接的超时（毫秒）。进程退出路径上有 6 秒的保底预算，配得比这更短不会生效 |
| `failureBackoffMs` | number | `60000` | 服务连接失败后的冷却窗口（毫秒）。冷却期内再次调用会立刻返回失败提示，而不是让你干等一次连接超时。`0` 表示关闭冷却 |

**`startupMetadataCheck` 是干什么的。** 开启（默认）时，网关每次启动后会在**后台**逐服务检查一遍工具目录缓存是否还能用——检查三件事：缓存是否存在、服务的启动配置有没有变、缓存是否超过 `cacheTtlDays`。只有失效的才会重新拉取。全部有效时什么都不做，只是打一行日志。

这个检查**不阻塞任何操作**：网关先就绪，你随时可以搜索和执行；检查是串行的，每刷完一个服务立刻生效，所以工具是"一个一个冒出来"的。唯一可能让你多等一会儿的情况，是你恰好针对**正在被检查的那个服务**发起检索——这时会复用那次检查，最多等一个服务的时长。

设为 `false` 则不做这次主动检查。注意它**不等于缓存冻结**：当你带着服务名去检索、而该服务缓存已失效时，网关仍会顺手刷新它。

### 服务专属配置项

除标准的 `command`、`args`、`env`、`cwd`（stdio）与 `url`、`headers`（http/sse）外，网关提供这些扩展：

| 字段 | 类型 | 说明 |
| :--- | :--- | :--- |
| `type` | string | `"stdio"`（默认，本地子进程）/ `"http"` / `"sse"`（远程服务） |
| `aliases` | string[] | **强烈建议配置。** 服务别名，直接影响搜索命中率。中文服务名必须配，网关不会自动生成中文变体 |
| `lifecycle` | string | `"lazy"`（默认，按需唤醒 + 闲置回收）/ `"eager"`（启动后后台预热，之后不参与闲置回收，适合启动慢但每次会话都用得到的服务）/ `"keep-alive"`（不做预热，但一旦连接就不被回收） |
| `idleTimeout` | number | 覆盖全局设置，单独指定该服务的闲置回收时间（分钟），`<= 0` 表示该服务禁用回收 |
| `disabled` | boolean | 临时屏蔽该服务：搜不到、列不出、也执行不了 |
| `refreshOnStartup` | boolean | 该服务在启动期缓存体检时**跳过缓存检查、无条件重新拉取工具列表**。适合工具列表会动态变化的在线服务 |
| `includeTools` | string[] | 工具白名单，支持 `sql_*`、`get?` 通配符。只有匹配的工具会对外暴露 |
| `excludeTools` | string[] | 工具黑名单，在 `includeTools` 之后应用。被排除的工具既搜不到也执行不了 |
| `inheritEnv` | boolean | 仅 stdio，默认 `true`。设为 `false` 时子进程只保留 SDK 的跨平台安全默认集（`PATH`、`HOME` 等）加显式 `env`，不携带宿主任意变量 |
| `bearerTokenEnv` | string | 仅 http/sse。从该环境变量读取 token 并注入 `Authorization: Bearer`，避免明文写进 `config.json` |
| `connectTimeoutMs` / `requestTimeoutMs` / `closeTimeoutMs` | number | 覆盖全局超时，适合个别响应很慢的服务 |

**`refreshOnStartup` 与 `startupMetadataCheck` 的区别。** 两者是不同维度，不是同一件事的两种写法：

- `settings.startupMetadataCheck`（全局）决定**要不要做这次体检**
- `x.refreshOnStartup`（单服务）决定**体检时这个服务要不要跳过缓存检查**

典型组合：全局保持默认做体检，只给工具列表经常变的那一两个在线服务加 `"refreshOnStartup": true`。

> 历史字段 `metadataBootstrap`（`"background"` / `"off"`）是 `startupMetadataCheck` 的旧名字。旧配置仍然可用，读取时会自动等价转换（`"background"` → `true`，`"off"` → `false`）并在启动日志里提示你改名。新配置请只用 `startupMetadataCheck`。

### aliases 怎么配

`aliases` 决定了 `search_tools` 能不能听懂你对服务的口语化称呼。

规则：

- **中文服务名必须配 aliases**，网关不会自动生成中文变体
- 英文 server key 里的 `-`、`_`、`.` 会被自动归一化成空格，不用额外配 `dingtalkdoc` 这种变体
- `search_tools` 的 `server` 参数是**提示（hint）**，填中文名、别名或近似名称都行，不需要精确的 server key；匹配不上会自动回退全局搜索，不会报错

```json
{
  "mcpServers": {
    "dingtalk-doc": { "aliases": ["钉钉", "钉钉文档", "dingtalk", "dingding"] },
    "siyuan-mcp": { "aliases": ["思源", "思源笔记", "siyuan"] },
    "github": { "aliases": ["GitHub", "gh"] }
  }
}
```

配完可以实际搜一次，看返回里的 `匹配依据`（matchReasons）判断是否需要补充。

---

## 常见问题

**搜不到我想要的工具？**
先确认这个服务在 `config.json` 里、且没有 `disabled`。然后：

- 带服务名搜：`search_tools(query="...", server="服务名或别名")` —— 这会强制刷新该服务的缓存再搜
- 服务名也搜不到，用 `list_tools(server="...")` 看它到底暴露了哪些工具
- 确认是缓存太旧（服务升级了但配置没变），可以删掉 `cache.json` 重启，或给该服务加 `"refreshOnStartup": true`

**会不会一启动就把所有服务都拉起来？**
不会。只要缓存有效，启动过程一个子进程都不会拉。缓存缺失或失效时才会在后台把对应服务拉起来读一次工具列表，读完立刻关掉（除非那一刻正好有别的请求在用它）。

**子进程什么时候退出？**
默认闲置 10 分钟后自动回收（`idleTimeout` 可调，也可按服务覆盖）。正在执行请求的连接不会被回收。

**同时用 Claude Code 和 OpenCode 会互相干扰吗？**
不会，只要给它们配不同的 `MCP_ADAPTER_HOME`。`import` 命令生成的配置会自动这么做。

**要不要把工具名单写全？**
不需要。想减少噪音可以用服务的 `includeTools` / `excludeTools` 精确控制哪些工具对外可见——被排除的工具既搜不到也执行不了。

**为什么只代理 Tools，不代理 Prompts 和 Resources？**
MCP 协议定义了三种能力，网关目前只拦截 Tools。原因很直接：Tools 是唯一有数量爆炸问题的能力（几十个服务 × 几十个工具 × 复杂 Schema = 数万 token），必须拦。Prompts 生态尚未成熟；Resources 数量通常很少（每个服务 5–10 个）且一般通过 URI 直接引用，不依赖模糊搜索发现。

---

## 工作原理

<details>
<summary>展开：缓存、搜索评分与进程调度（排查问题或二次开发时看）</summary>

### 工具目录缓存

网关不实时查询底层服务，而是把工具元数据缓存在 `cache.json`。缓存有效性由三条校验共同决定：

1. **结构合法** —— 条目必须包含完整的指纹与工具列表
2. **配置指纹匹配** —— 对服务的 `ServerConfig` 做 SHA256，采用**黑名单策略**：除 `aliases`、`lifecycle`、`includeTools` 等 adapter 侧元数据外，其余字段全部进指纹。好处是以后新增连接相关字段会自动纳入，不需要维护白名单；改元数据类字段不会触发重新发现
3. **未超期** —— 不超过 `cacheTtlDays`

任一条不通过就在下次需要时重新拉取。这是个**最终一致**的设计：它能发现"配置变了"，但发现不了"服务内部工具变了而配置没动"——后者靠 TTL、`refreshOnStartup` 或手动删除缓存兜底。这样换来的是"每次搜索都不需要拉起子进程"。

### 搜索评分

三层召回 + 统一排序：

- **BM25** 负责词项相关性与长度归一化
- **Fuse.js token search** 负责 typo、大小写、多词乱序
- **IDF 字段加权**让低频特征词和关键字段（工具名、服务别名）命中时权重更高

最终合成一个分数，并输出 `matchReasons` 告诉模型"这个候选为什么被召回"，辅助判断是直接执行还是继续 `describe_tool`。没有用 embedding：工具元数据规模在百到千级、字段明确，本地轻量检索足够，还省掉了索引构建、缓存失效重算和模型依赖。

### 进程调度

- **并发去重**：同一服务的并发首次调用复用同一个建连 Promise，不会重复拉起进程
- **崩溃自愈**：底层连接意外断开时主动把它摘出连接池，下一次调用重新冷启动，而不是反复复用一条已断开的连接
- **超时不连坐**：某个请求超时后，该连接被标记为"退役"（新请求会建新连接），但要等最后一个在途请求结束才物理关闭——直接强关会让同一连接上其他正常请求一起失败
- **有序退出**：收到客户端断开或 `SIGINT`/`SIGTERM` 时，按「熔断新建 → 清半连接资源 → 等在途建连结束 → 回收已退役连接 → 关闭稳定连接池」的顺序释放全部子进程

> 边界：这套清理只在**有退出信号**时生效。父进程被 `kill -9` 或 OOM 强杀时，网关来不及做任何事，底层子进程只能靠 stdin 断开自救。这是子进程模型的结构性限制，需要在宿主机层面兜底（进程组 kill、容器生命周期钩子）。

</details>

---

## 开发与维护

<details>
<summary>展开：测试、发版流程与代码规范（维护者看）</summary>

### 从源码开发

```bash
git clone https://github.com/Lancernix/mcp-adapter.git
cd mcp-adapter
npm install
npm run build          # 产物在 dist/，也可以 npm link 后全局调用
```

### 测试

```bash
npm test        # tsx --test --test-timeout=120000 __tests__/*.test.ts
npm run check   # biome lint + format 检查
npm run build   # tsc 编译到 dist/
```

测试**不依赖网络、不依赖任何真实 MCP 服务**，可在本地与 CI 稳定重跑。分两层：

**端到端**（真实拉起 adapter 进程 + 真实 stdio 协议，验证"客户端看到的行为"）：

| 文件 | 覆盖内容 |
| :--- | :--- |
| `__tests__/meta-tools-e2e.test.ts` | 4 个元工具的暴露面、冷启动写缓存、search 的各类命中与兜底、search→execute 闭环、list/describe、重名冲突、includeTools/excludeTools/disabled 的可见性与可执行性、`env`/`inheritEnv`/`cwd` 真实生效、eager 启动预热与无崩溃守护、缓存有效时不产生额外进程、关闭体检后的按需刷新、退出不留孤儿 |

**单元**（直接调用内部模块，验证并发、资源释放与缓存语义）：

| 文件 | 覆盖内容 |
| :--- | :--- |
| `__tests__/process-lifecycle.test.ts` | 并发建连去重、失败可重试、崩溃自愈、超时退役不误杀在途请求、eager 预热、闲置回收边界、`shutdownAll` 收敛与孤儿进程防护 |
| `__tests__/cache-manager.test.ts` | 配置指纹稳定性与元数据字段排除、有效性三校验、原子写与合并、并发写队列、mtime 快照与跨进程可见性、`getValidCachedServers` |
| `__tests__/server-options.test.ts` | `includeTools`/`excludeTools` 的匹配语义（含 `?` 通配与大小写）、`resolveCwd`、`buildChildEnv` 与 `inheritEnv`、`FailureBackoff` |
| `__tests__/config-legacy-migration.test.ts` | 旧字段 `metadataBootstrap` 的兼容与落盘迁移 |
| 其余 | 客户端配置适配、搜索索引、server hint 解析、`resolveHttpHeaders`、失败冷却等 |

**单一归属原则**：同一件事只在**一个**文件里被测试——缓存层归 `cache-manager.test.ts`，服务配置解析归 `server-options.test.ts`，两者不重叠。跨文件复用的工具（进程存活探测、轮询等待、假 server 定位与 spawn 记录读取、临时工作区）集中在 `__tests__/helpers.ts`（不以 `.test.ts` 结尾，不会被收集成用例）。

测试夹具：`__tests__/fixtures/fake-mcp-server.mjs` 是一个**零依赖**的最小 MCP stdio server（手写 JSON-RPC 循环），通过环境变量精确制造故障场景：

| 环境变量 | 作用 |
| :--- | :--- |
| `FAKE_SPAWN_LOG` | 每次启动把自身 pid 追加到该文件，用于精确统计 spawn 次数 |
| `FAKE_INIT_DELAY_MS` | 延迟 `initialize` 响应，制造"建连中"状态 |
| `FAKE_STUBBORN` | 设为 `1` 后忽略 stdin 关闭与 `SIGTERM`，只能被 `SIGKILL` 杀死 |

暴露的工具（与 `meta-tools-e2e.test.ts` 的 `FAKE_TOOLS` 常量同步）：`echo` / `sleep` / `pid` / `crash`（直接 `process.exit(7)` 模拟崩溃）/ `env` / `cwd` / `fail`。

> 改动 `src/server-manager.ts`、`src/lifecycle.ts` 或 4 个元工具的入口逻辑后，务必先确认 `npm test` 全绿再提交。

### 发版流程

版本号唯一来源是 `package.json` 的 `version`，发版通过打 tag 触发。仅 push `master` 只会跑 CI，不会发布。

1. 更新 `package.json` 的 `version`（遵循 semver）
2. 本地确认三道门全绿：`npm run check` → `npm run build` → `npm test`
3. 合并到 `master`
4. 打 tag 并推送：`git tag v<x.y.z> && git push origin v<x.y.z>`

tag 推送后 CI 自动完成：校验 tag 与 `package.json` 版本一致 → lint + build + 测试 → `npm publish`（Trusted Publishing / OIDC，无需 token，附带 provenance）→ 创建 GitHub Release。CI 配置见 `.github/workflows/main.yaml`。

### 代码规范

TypeScript + `strict` 模式，biome 作为 linter/formatter，无显式 `any`、无非空断言。底层通信遵循官方 MCP 协议，支持 SDK 内置的 Stdio / Streamable HTTP / SSE 三种传输。

</details>

---

## License

MIT
