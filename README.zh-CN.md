# Codex with ChatGPT

[English](README.md) | **简体中文**

> ChatGPT 负责思考，Codex 负责干活。

## 解决什么问题

ChatGPT 付费订阅的网页版额度大量闲置，Codex 却在消耗紧张的 API 额度做
规划和 Review。本项目把"思考"交给你已付费的网页版 ChatGPT，Codex 只负责
执行。不用 API Key、不搞逆向代理——官方网页 + 只读 MCP 桥接。

## 这是什么

把 ChatGPT 网页版变成 Codex 编码会话的"规划与审查大脑"，而执行权完全保留在
Codex 手里。你的仓库永远不会被上传——ChatGPT 通过一条安全的、OAuth 保护的
**只读** MCP 连接，按需读取当前工作区里它真正需要的那几行代码。

## 一段话安装（纯小白专用）

不懂 git、Node、终端？完全不需要懂。把下面这段话原样复制给你的编码
Agent（Codex），然后去倒杯咖啡：

```text
请帮我完整安装并配置 Codex with ChatGPT，全程自动，我是不懂技术的小白，
所有事情你自己做：

1. 环境自检：需要 git 和 Node.js ≥ 20，缺什么就自动安装
  （macOS 用 Homebrew，Windows 用 winget），同时安装 cloudflared。
2. 下载：把 https://github.com/XiaoDuoYa/codex-with-chatgpt 克隆到
   ~/codex-with-chatgpt（已存在就 git pull 更新）。
3. 构建：在该目录里执行 corepack pnpm install 和 corepack pnpm build。
4. 安装 Skill：把仓库里的 skill/SKILL.md 复制到
   ~/.codex/skills/codex-with-chatgpt/SKILL.md，并把文件中
   "The codex-with-chatgpt checkout lives at:" 那一行的路径改成实际克隆路径。
5. 首次配置：按 SKILL.md 里的 first-time setup 流程执行。
  （首次连接时在内置浏览器中输入一次配对码；同一 workspace 后续任务复用已有 connector，不会重复输入。）
   全程只用内置浏览器，禁止打开任何第三方浏览器。
6. 只有遇到需要我登录（ChatGPT / Cloudflare）、验证码或两步验证时才叫我，
   而且一次只告诉我一个动作。
7. 完成后给我看 ✓ 清单，并确认文件读取测试通过。我不懂 MCP、OAuth、
   Tunnel、端口这些词，不要向我解释；出了问题先自己修。
```

**更新**：Skill 每天自动检查一次 GitHub，有新版本会自动更新并继续任务，
无需任何操作；也可以随时对 Codex 说"更新 Codex with ChatGPT"。

## 安装 → 配置 → 使用（手动版）

1. 安装 Codex Skill：把 `skill/` 复制到 `~/.codex/skills/codex-with-chatgpt/`。
2. 对 Codex 说：**"使用 Codex with ChatGPT 完成首次配置。"**
3. 之后正常使用：**"使用 Codex with ChatGPT，帮我实现 XXX。"**

说明书到此结束。你不需要知道 MCP、OAuth、Tunnel、端口、localhost 是什么——
Codex 会自动完成所有配置，你只会看到：

```
Codex with ChatGPT

✓ 当前项目已识别
✓ Workspace Bridge 已启动
✓ 安全连接已建立
✓ ChatGPT 已连接
✓ 文件读取测试通过

Ready.
```

唯一可能需要你动手的步骤：登录 ChatGPT（如果要用固定域名，再登录一次 Cloudflare）。

### 可选的固定域名

默认公网地址是临时的，桥重启后会变。Codex 会删除这个 workspace 自己的 ChatGPT Connector，再用新地址重新创建；不会触碰其它 workspace 的 Connector。

删除并重新创建 Connector 会产生新的 ChatGPT 应用身份，因此保存的会话也必须更换。修复后请新建 ChatGPT 会话，用 `@` 添加当前 Connector，发送 Boot Prompt，确认 `workspace_info` 成功，再提交新的绑定：

```sh
c2c connector commit -w <workspace> \
  --generation <generation> --fingerprint <fingerprint> --url <conversation-url> \
  --lock-token <token> --json
```

## 在 OMP 中使用

OMP 配下的默认 C2C workspace 是 `~/Data/OMP`。即使从某个子项目目录发起任务，也不会把当前目录自动当作 workspace 边界。

通常任务先进行只读检查，不运行 `setup` 或 `pair`：

```sh
./scripts/omp-c2c.sh status -w ~/Data/OMP --json
./scripts/omp-c2c.sh session get -w ~/Data/OMP --json
./scripts/omp-c2c.sh tunnel status -w ~/Data/OMP --json
./scripts/omp-c2c.sh doctor -w ~/Data/OMP --no-fix --json
```

只有 `session get` 返回 `usable: true`、doctor 返回 `status: "ok"`，并且
`report.bridge.ok`、`report.mcp.ok`、`report.tunnel.ok` 都为 true 时，才复用现有
Connector、OAuth token 和会话。`doctor --no-fix` 即使返回 `exitCode: 0`，也可能是
`status: "pending"`；不能只看退出码。

如果没有 endpoint 或 usable 会话，自动路由会在 OMP 内部进入初次配置或明确的恢复流程，
不会要求用户输入 `/chatgpt-setup`。正常健康检查仍然不运行 `setup` 或 `pair`。

在修改状态或操作 ChatGPT 浏览器前，先取得 workspace 会话锁。只在当前任务中保存返回的 token，
并将 `--lock-token <token>` 传给所有修改命令；结束后运行 `session lock release`。

```sh
./scripts/omp-c2c.sh session lock acquire \
  -w ~/Data/OMP --task <task-id> --json
```

只有首次连接或明确恢复时，才在持有锁的情况下运行 `setup`。`setup` 输出的
`pairingCode` 不要在 Connector 创建前保存或输入。
先运行只读的 `doctor --no-fix --json` 完成诊断，在 ChatGPT 创建或重新创建 Connector；
仅在 Connector 创建完成、即将打开 OAuth 授权弹窗时，才用同一个 lock token 运行修复模式
`doctor --json --lock-token <token>`，然后立即把返回的 `chatgptRepair.pairingCode`
输入弹窗。配对码默认有效 30 分钟且只能使用一次；如果已有配对流程，`setup` 不会再发新码。

OMP 默认使用临时地址。只有明确选择固定域名时，才先在会话锁内运行
`tunnel login -w ~/Data/OMP --lock-token <token>`，再运行
`tunnel choose --mode named --zone <domain> --lock-token <token>`。

临时地址发生变化时，doctor 会给出当前 Connector、generation 和 fingerprint。
只删除并重新创建该 workspace 的 Connector，不触碰其它 workspace，也不对旧地址 Reconnect 或编辑。
重新创建会产生新的 ChatGPT 应用身份，因此不要复用保存的旧会话；请新建会话，用 `@` 添加当前
Connector，发送 Boot Prompt，确认 `workspace_info` 成功后提交新的绑定：

```sh
./scripts/omp-c2c.sh connector commit -w ~/Data/OMP \
  --generation <generation> --fingerprint <fingerprint> --url <conversation-url> \
  --lock-token <token> --json
```

`generation` 和 `fingerprint` 必须来自 doctor，并且只能在 `workspace_info` 成功后提交。
commit 会同时写入已验证的会话元数据和 Connector 绑定；禁止在 commit 前运行 `session set`。
之后只有当保存会话的 generation、fingerprint 与当前 `connectorBound` 完全一致时，才会复用该会话。
固定域名连接需要修复时，重新登录 Cloudflare，不删除 Connector。

旧 endpoint state 会在读取时正规化为 version 2 的未绑定 `legacy_state`，旧会话不会因此自动变得可用；
必须在当前 Connector 上验证 `workspace_info` 后再通过 `connector commit` 迁移。
OAuth 的动态客户端注册按 client 名称和去重排序后的 redirect URI 计算 fingerprint；
重复注册会复用同一 client，旧 state 中的重复 client 会确定性地收敛并退役其 token。

连接 ChatGPT 网页版时不要使用 `--no-tunnel`。项目级隔离只有在明确指定时才使用子目录作为 `-w` 参数。

配对码不是 ChatGPT 登录码，而是 connector 首次授权使用的一次性确认码。

---

## 工作原理

```
             ┌───────────────────────────┐
             │      ChatGPT 网页版       │
             │   推理 / 规划 / 审查      │
             └──────────┬──────────▲─────┘
                        │          │
               MCP      │          │ Computer Use
              数据面    │          │ 控制面（消息 < 1 KB）
                        ▼          │
             ┌─────────────────────┐
             │      C2C Bridge     │   仅监听本机回环地址
             │  只读 MCP           │   OAuth 2.1 + 一次性配对码
             │  OAuth + 配对       │   Cloudflare Quick Tunnel
             │  Tunnel 管理        │
             └──────────┬──────────┘
                        │  只读
                        ▼
             ┌─────────────────────┐          ┌─────────────────────┐
             │     本地工作区      │◀─────────│    Codex Harness    │
             └─────────────────────┘ 编辑/git │  Shell / 测试 / 修复 │
                                              └─────────────────────┘
```

- **控制面（Computer Use）**：Codex 与 ChatGPT 之间只交换极小的结构化 `[C2C]`
  状态消息——`INIT → PLAN → EXECUTED → REVIEW → DONE`。绝不粘贴 diff、日志
  或文件内容。
- **数据面（MCP）**：ChatGPT 缺什么自己拉什么，共 8 个只读工具：
  `workspace_info`、`list_directory`、`read_file`、`search_workspace`、
  `git_status`、`git_diff`、`test_status`、`execution_summary`。
- **独立审查**：Codex 执行完毕后，ChatGPT 通过 MCP 亲自检查真实的 git diff
  和测试记录——绝不因为 Codex 说"测试全过"就直接相信。

## 安全模型（简版）

- **从构造上只读**：服务端根本不存在写文件/删除/Shell/提交类工具，任何提示
  注入都无法启用它们。
- **一个工作区 = 一道边界**：每个令牌绑定单一工作区；路径校验基于规范化
  realpath（symlink、`../`、绝对路径逃逸全部被拦截并有测试覆盖）。在 OMP 集成中，默认 workspace 是 `~/Data/OMP`；只有明确要求隔离时才使用子项目目录。
- **敏感文件永不外泄**：`.env*`、密钥、SSH、各类凭据默认拒绝
  （`.env.example` 放行）；`.c2cignore` 可追加自定义规则。
- **知道 URL 不等于有权限**：公网 MCP 端点强制 OAuth 2.1（PKCE S256、动态
  客户端注册、refresh token 轮换）。无令牌：401；令牌属于别的工作区：403。
- **模型永远接触不到长期凭据**：唯一会出现在浏览器里的秘密是一次性配对码
  （30 分钟有效、限 5 次尝试、限速、用后即毁）。

完整威胁模型：[docs/security.md](docs/security.md)

## 开发者

```bash
pnpm install
pnpm build          # 产出 dist/，暴露 c2c 命令
pnpm test           # vitest：路径安全、OAuth、配对、MCP 端到端

c2c session lock acquire -w <workspace> --task <task-id> --json
c2c doctor -w <workspace> --no-fix --json
c2c setup --workspace <workspace> --lock-token <token>  # 仅首次配置或明确恢复
c2c connector commit -w <workspace> --generation <n> \
  --fingerprint <fingerprint> --url <conversation-url> \
  --lock-token <token> --json
c2c session get -w <workspace> --json  # 仅 usable: true 时复用
c2c session lock release -w <workspace> --token <token> --json
```

环境要求：Node.js >= 20、git；公网连接需要 `cloudflared`
（自动检测，Skill 会替你安装）。

文档：[架构](docs/architecture.md) · [协议](docs/protocol.md) ·
[安全](docs/security.md) · [故障排查](docs/troubleshooting.md)

## 目录结构

```
src/
  bridge/     本机回环 HTTP 服务、端口自动恢复、管理 API
  mcp/        8 个只读工具、无状态 Streamable HTTP
  auth/       OAuth 2.1（PKCE、动态注册、refresh 轮换、吊销）
  pairing/    一次性配对码（CSPRNG、TTL、限速）
  workspace/  路径收敛、敏感文件策略、搜索、git
  tunnel/     TunnelProvider 抽象 + Cloudflare Quick Tunnel
  execution/  审查闭环所需的执行记录
  session/    workspace 会话锁和 Bridge 启动锁
  process/    守护进程生命周期
  cli/        c2c 命令行
skill/        Codex Skill（真正的 UX 层）
tests/        单元 + 集成测试
docs/         架构 / 协议 / 安全 / 故障排查
```

## 状态与声明

V1。已端到端验证：Bridge、OAuth + 配对、公网隧道、ChatGPT 连接器配置、
零操作首次配置体验。

**非官方社区项目，与 OpenAI 无关联，未获其背书。**

## 许可证

[MIT](LICENSE)
