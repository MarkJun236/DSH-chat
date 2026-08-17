# dsh-chat

> DSH Web GUI 的普通对话插件 —— 不用再为聊个天多开一个 App。

dsh-chat 在 DeepSeek Harness（DSH）Web GUI 的侧边栏里加一个「对话」入口：
不绑工作区、不带工具，就是一个纯粹的对话面板。你在 DSH 里已经配置好的
任何 provider / model 直接可用，流式输出，多会话历史自动保存。

---

## 设计理念

> 我就是不想要开这么多个 app。

日常工作中，大量场景其实只是"普通对话"：问个问题、查个概念、写段文案、
润色一段文字……这些不需要工作区，不需要工具调用，更不需要为它们单独打开
一个 ChatGPT 或 Claude 的 App。

于是想法很简单：

- **只装一个 Harness**。DSH 本身就是你日常开发/工作的地方，它已经配好了
  你所有 provider 和 model 的 API 凭据。
- **对话能力直接长在 DSH 里**。插件不引入任何新的模型适配层，不要求你
  再配一遍 key，而是直接复用 DSH 的 `ctx.llm` 模型路由——DSH 里能选的
  模型，这里就能聊。
- **随用随走，不留负担**。打开就是聊，聊完关掉；历史存在本地，下次接着聊。

**多一个插件，少一个 App。** 这就是 dsh-chat 存在的全部理由。

## 特性

- 🗨️ **侧边栏独立「对话」入口**：与任务看板、SSH 等插件并列，一键进入
  纯对话模式，不占用工作区界面。
- 🔌 **零配置复用 DSH 模型路由**：直接走 harness 的 `ctx.llm`，所有已导入
  的 provider / model 自动可用，支持切换，无需额外适配器或 API key。
- ⚡ **流式输出**：NDJSON 帧流式返回，支持 `delta`（正文）、`reasoning`
  （思考过程）、`usage`（用量）实时展示。
- 💬 **多会话管理**：左侧历史列表，新建 / 切换 / 重命名 / 删除；当前
  会话自动记住上次使用的模型。
- 🏷️ **AI 自动标题**：根据第一条提问自动生成会话标题（可关闭，也可指定
  专门的标题模型），手动重命名不会被覆盖。
- 📝 **Markdown 渲染**：内置 GFM 子集渲染（代码块、行内代码、表格、
  引用、列表、链接、图片），escape-first + 协议白名单，安全渲染。
- 🎨 **跟随 DSH 主题**：样式全部基于 DSH 的 `--dsw-*` design tokens，
  明暗主题自动适配。
- 🔥 **热插拔**：通过 profile 的 `cordis.patch.yml` + node_modules 软链
  挂载，**不改 DSH 源码**，升级 DSH 不受影响。

## 工作原理

插件是**双面（dual-face）结构**，由同一个 npm 包提供宿主端与浏览器端：

```
┌────────────────────────── 浏览器 (Web GUI) ──────────────────────────┐
│  lib/client.js         侧边栏「对话」入口 + React 对话面板            │
│                        （随 /plugins/dsh-chat/client.js 加载）       │
└───────────────▲──────────────────────────────────────────────────────┘
                │ fetch /api/dsh-chat/*（NDJSON 流式）
┌───────────────┴──────────────────────────────────────────────────────┐
│  lib/index.js         宿主端 Cordis 插件 (exports ".")                │
│                       注册 /api/dsh-chat 路由族                       │
│                       直接调用 ctx.llm.stream() 驱动模型              │
│                       会话历史持久化到 ~/.dsh/dsh-chat.json           │
└──────────────────────────────────────────────────────────────────────┘
```

- **宿主端**（`lib/index.js`）：纯 ESM，运行时只依赖 Node 内置模块；
  `llm` 与 `webServer` 来自 Cordis 注入列表。负责模型目录、会话存储 CRUD、
  流式对话与持久化。
- **浏览器端**（`lib/client.js`）：自包含的 React 面板，通过模块加载器
  注册，DOM 级注入侧边栏入口；样式骑在 DSH design tokens 上。

## 安装

### 方式一：作为 profile bundle（推荐）

1. 将 `dsh-chat` 装进 DSH 的 node_modules（或其软链目录）；
2. 在目标 profile 的 `dsh.profile.bundles` 中列出本包，或在 profile 自己的
   `cordis.patch.yml` 中插入插件行：

```yaml
- insert:
    - id: chat
      name: 'dsh-chat'
```

3. 启动 DSH Web，侧边栏即可看到「对话」入口。

### 方式二：手动插入 cordis.patch.yml

仓库根目录的 `cordis.patch.yml` 就是标准 bundle patch，可作为 profile
bundle 层（`dsh.bundle.patch` 清单字段）叠加到 dsh-base 之上。

## 使用

1. 点击侧边栏「对话」进入面板；
2. 顶部选择 **provider / model**（默认记住上次选择，存在 localStorage）；
3. 输入内容，`Enter` 发送，`Shift+Enter` 换行；
4. 左侧历史列表管理多个会话；
5. 齿轮按钮打开设置：可关闭 AI 自动标题，或为标题生成单独指定模型。

## API 一览

所有路由仅限本机回环访问（loopback-only），部署在局域网时不会被外部访问。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/dsh-chat/models` | 列出所有 provider 及其模型目录 |
| `GET` | `/api/dsh-chat/conversations` | 会话摘要列表 |
| `GET` | `/api/dsh-chat/conversations?id=` | 单个会话完整内容（含消息） |
| `POST` | `/api/dsh-chat/conversations` | 新建会话（可选 `title`） |
| `PATCH` | `/api/dsh-chat/conversations?id=` | 重命名会话（`title`） |
| `DELETE` | `/api/dsh-chat/conversations?id=` | 删除会话 |
| `POST` | `/api/dsh-chat/stream` | 流式对话（NDJSON 帧：`meta` / `delta` / `reasoning` / `usage` / `done` / `error`） |

## 数据与隐私

- **会话历史**：全部保存在本机 `~/.dsh/dsh-chat.json`（0600 权限，
  tmp + rename 原子写入）；列表接口返回的是不含消息的摘要投影。
- **偏好设置**：模型选择、标题模型选择存在浏览器 `localStorage`
  （`dsh-chat.model`、`dsh-chat.titleModel`）。
- **损坏兜底**：存储文件损坏时不会破坏插件——自动改名为
  `.corrupt-<时间戳>` 后从空会话开始，绝不静默覆盖原数据。

## 安全

- 所有 `/api/dsh-chat/*` 路由都有 **loopback trust fence**：校验远端地址、
  Host / Origin，仅允许本机回环访问，LAN 暴露的 DSH 部署不会把对话接口
  和模型输出暴露到局域网。
- Markdown 渲染 **escape-first** + 协议白名单：只放行 `http:`、`https:`、
  `mailto:`、锚点与相对路径，`javascript:` 等危险协议一律拒绝。
- 客户端断连会自动 abort 模型调用，不浪费 token。

## 目录结构

```
dsh-chat/
├── lib/
│   ├── index.js     # 宿主端：路由族 + ctx.llm 流式 + 会话存储（~508 行）
│   └── client.js    # 浏览器端：侧边栏入口 + React 对话面板（~1150 行）
├── cordis.patch.yml # bundle patch：向 profile 注册插件行
├── package.json     # 双面导出：exports "."（宿主）/ "./client"（浏览器）
└── README.md
```

## License

[MIT](./LICENSE)
