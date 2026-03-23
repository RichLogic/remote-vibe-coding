# remote-vibe-coding

[English README](./README.md)

`remote-vibe-coding` 是一个以 Codex 为核心、通过浏览器运行本地编码与聊天工作流的 Web 外壳。

当前仓库已经包含一套可实际使用的 phase-1 运行时：

- 桌面端 Web 客户端
- 基于真实 `codex app-server` 协议的本地主机服务
- 两种产品模式：`developer` 和 `chat`
- `user`、`developer`、`admin` 三类角色权限
- 以 transcript 为中心的会话体验，支持审批、附件、归档/恢复、停止、重启和 Fork
- 托管工作区，默认位于 `~/Coding/<username>/...`
- 可选的 Cloudflare Tunnel 集成

## 当前功能

### Developer 模式

- 创建托管工作区，或从 Git 仓库克隆到托管工作区
- 启动绑定单一主工作区的 Codex 编码会话
- 发送带文本和附件的 turn
- 查看 transcript、命令输出、文件改动和审批请求
- 运行时重启后，可对失效会话执行 restart
- 支持归档、恢复、Fork、重命名和删除会话

### Chat 模式

- 在独立共享的 `chat` 工作区中运行更偏助手体验的对话模式
- 对话历史持久化到 MongoDB
- 支持上传图片、PDF 和文本类文件作为上下文
- 支持管理员维护的聊天角色预设
- 支持归档、恢复、Fork、停止和删除对话

### 权限与信任模型

- 执行器：`Codex`
- 主客户端：桌面端 Web
- 默认安全配置：`repo-write`
- 网络：默认关闭
- `full-host`：仅对有权限的用户开放
- 审批：在浏览器中显式展示，而不是平台静默自动批准

## 仓库结构

- `apps/host`
  本地 Fastify host，负责认证、会话状态、审批路由、Cloudflare 编排、Mongo 持久化，以及对 `codex app-server` 的桥接。
- `apps/web`
  基于 React + Vite 的浏览器客户端，承载 chat 和 developer 两类流程。
- `apps/host/chat-system-prompt.json`
  Chat 模式默认系统提示词。
- `apps/host/chat-role-presets.json`
  内置聊天角色预设，管理员也可以在 UI 中管理。
- `docs/phase-1-architecture.md`
  当前阶段的产品与技术设计说明。

## 运行依赖

运行 host 的机器需要准备：

- 安装好 Node.js 和 `npm`
- 可访问的 MongoDB，默认地址为 `mongodb://127.0.0.1:27017/?directConnection=true`
- `codex` CLI，因为 host 会主动启动 `codex app-server`
- 如果要使用内置 Tunnel，再额外安装 `cloudflared`

如果 `codex` 不在默认路径上，请设置 `CODEX_BIN`。

## 本地开发

先安装依赖：

```bash
npm install
```

再启动 MongoDB。任意本地 Mongo 实例都可以，最简单的方式之一是：

```bash
docker run --name rvc-mongo -p 27017:27017 -d mongo:7
```

强烈建议在第一次启动前先设置登录账号：

```bash
export RVC_AUTH_USERNAME=owner
export RVC_AUTH_PASSWORD='change-me'
```

分别在两个终端中启动 host 和 web：

```bash
npm run dev:host
```

```bash
npm run dev:web
```

打开 `http://127.0.0.1:5173`。

开发环境默认值：

- host：`http://127.0.0.1:8787`
- web：`http://127.0.0.1:5173`
- Vite 会把 `/api` 代理到 host

## 单域名构建运行

如果要让 host 直接提供构建后的前端页面：

```bash
npm run build
npm run start:host
```

然后访问 `http://127.0.0.1:8787`。

## 认证说明

浏览器入口默认是 owner-gated 的。

- 未认证请求会被重定向到 `/login`
- 密码登录后会设置 HTTP-only cookie
- `?token=...` 链接仍然可以作为兜底方案
- 用户、角色、默认模式和 token 都由 host 管理

推荐做法：

- 第一次启动前就设置 `RVC_AUTH_USERNAME` 和 `RVC_AUTH_PASSWORD`

如果你没有设置这些环境变量，应用会在首次启动时自动创建一个 `owner` 用户，并把认证状态写入 `~/.config/remote-vibe-coding/auth.json`。

这里有一个关键细节：

- 文件里保存的是密码哈希，不是明文密码
- 文件里会保存生成出来的 token

所以如果你第一次启动时没有显式设置用户名密码，可以直接从 `~/.config/remote-vibe-coding/auth.json` 里拿 token，用下面这种方式登录：

```text
http://127.0.0.1:8787/?token=YOUR_TOKEN
```

登录后再到管理界面里创建或更新用户即可。

## 数据与存储

项目同时使用本地文件和 MongoDB。

- `~/.config/remote-vibe-coding/auth.json`
  认证状态和用户记录。
- `~/.config/remote-vibe-coding/sessions.json`
  本地持久化的会话状态及其备份。
- `~/Coding/<username>/...`
  应用创建和管理的工作区。
- MongoDB 数据库 `remote_vibe_coding`
  持久化的聊天历史、编码会话和工作区记录。

附件会直接写入托管工作区，方便 Codex 原地访问和修改。

当前附件行为：

- 单文件最大 `20 MB`
- 支持类型：图片、PDF、通用文件
- PDF 和文本类文件会尽可能做文本提取

## 配置项

### 核心运行时

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `HOST` | Host 绑定地址 | `127.0.0.1` |
| `PORT` | Host 端口 | `8787` |
| `MONGODB_URL` | MongoDB 连接串 | `mongodb://127.0.0.1:27017/?directConnection=true` |
| `MONGODB_DB_NAME` | MongoDB 数据库名 | `remote_vibe_coding` |
| `CODEX_BIN` | Codex 可执行文件路径 | 平台默认值 |

### 认证

| 变量 | 说明 |
| --- | --- |
| `RVC_AUTH_USERNAME` | 首个管理员用户的用户名 |
| `RVC_AUTH_PASSWORD` | 首个管理员用户的密码 |
| `RVC_AUTH_TOKEN` | 可选，自定义首个用户的固定 token |

### Cloudflare

| 变量 | 说明 |
| --- | --- |
| `CLOUDFLARE_TUNNEL_TOKEN` | 使用托管 Tunnel，而不是 quick tunnel |
| `CLOUDFLARE_PUBLIC_URL` | UI 中展示的稳定公网地址 |
| `CLOUDFLARE_TARGET_URL` | 覆盖 Tunnel 暴露的本地目标地址 |

### Web

| 变量 | 说明 |
| --- | --- |
| `VITE_API_BASE_URL` | 当前端脱离 host 单独运行时，指定 API 基地址 |

## Cloudflare 支持

当前 Cloudflare 集成支持：

- 通过 `cloudflared` 建立 quick tunnel
- 自动识别 `~/.cloudflared/config.yml` 中已有的 named tunnel
- 通过 `CLOUDFLARE_TUNNEL_TOKEN` 使用 managed tunnel
- 在浏览器 UI 里直接执行 connect / disconnect

如果已经有构建产物，host 会把前端和 API 以同源方式提供出去；如果没有构建产物，Tunnel 逻辑也可以回退到本地 Vite 开发服务器。

## 当前范围

这个仓库目前仍然是一个刻意收敛范围的 phase-1 产品。

已经包含：

- 只支持 Codex 作为执行器
- 只支持桌面 Web
- 在同一个浏览器外壳里提供 chat 和 developer 两种模式
- transcript-first 的会话体验
- 显式审批处理
- Cloudflare Tunnel 集成
- 管理员可维护的用户和聊天角色预设

尚未包含：

- 移动端客户端
- 多执行器抽象
- Cloudflare Access 集成
- 超出当前 host/runtime 模型之外的完整长时编排层
