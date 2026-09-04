# Codex with ChatGPT

[English](README.md) | **简体中文**

> ChatGPT 负责思考，Codex 负责干活。

## 解决什么问题

ChatGPT 付费订阅的网页版额度大量闲置，Codex 却在消耗紧张的 API 额度做
规划和 Review。本项目把"思考"交给你已付费的网页版 ChatGPT，Codex 只负责
执行。不用 API Key、不搞逆向代理——官方网页 + 工作区只读 MCP 桥接 +
本地结构化结果回传。

## 这是什么

把 ChatGPT 网页版变成 Codex 编码会话的"规划与审查大脑"，而执行权完全保留在
Codex 手里。你的仓库永远不会被上传——ChatGPT 通过一条安全的、OAuth 保护的
连接按需读取代码，并且只能向 C2C 本地状态提交受限进度和一次性、结构化的
建议结果，不能修改工作区。

ChatGPT 还可以负责代码检索和需要等待的网页研究；正式研究会在规划前独立返回
结论、来源链接、发布日期、关键证据和待确认问题。Codex 负责把建议落实为本地
修改并完成验证。C2C 本身不能
切换当前 Codex 模型，低成本模型需要由用户或宿主环境选择。

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
5. 首次配置：按 SKILL.md 里的 first-time setup 流程执行
  （运行 c2c setup，用内置浏览器打开 ChatGPT 配置连接器并输入配对码）。
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

唯一可能需要你动手的步骤：登录 ChatGPT（如果要用固定域名，再登录一次 Cloudflare）。**新仓库**还会请你在 ChatGPT 里建一次项目（合集）：名字用仓库名，记忆选「仅限项目记忆」。侧栏如果没有「项目」，把鼠标放在「聊天」上，点右边三个点，选「按项目整理」。之后对话都从合集页开，不用回首页。已经在用的仓库可以继续不使用 Project，但每个本地 Codex 会话仍会保存并复用各自的 ChatGPT 对话。

### 可选的固定域名

默认公网地址是临时的，桥重启后会变。Codex 会删掉这个项目的 ChatGPT 插件再按新地址加回去。

如果你有 Cloudflare 账号，并且域名已经加在 Cloudflare 上，首次配置时（老用户则在下一次编码时问一次）会问你要不要用固定域名，例如 `c2c-<项目>.你的域名`。选是的话，浏览器里授权一次 Cloudflare 即可。之后重启一般不用再改插件。没有账号、不想用、登录失败：继续用临时地址，功能一样，只是修复更慢。

凭证放在系统目录，不进项目。

## 工作原理

```
             ┌───────────────────────────┐
             │      ChatGPT 网页版       │
             │   推理 / 规划 / 审查      │
             └──────────┬──────────▲─────┘
                        │          │
          MCP 数据读取  │          │ 浏览器控制面
       + 进度/结果提交  │          │ RESEARCH / INIT / EXECUTED（< 1 KB）
                        ▼          │
             ┌─────────────────────┐
             │      C2C Bridge     │   仅监听本机回环地址
             │ MCP + 结果 mailbox  │   OAuth 2.1 + 一次性配对码
             │  OAuth + 配对       │   Cloudflare Quick Tunnel
             │  Tunnel 管理        │
             └──────┬────────┬─────┘
          只读访问  │        │ 受限结果写入 C2C 状态
                   ▼        ▼
       ┌────────────────┐  ┌─────────────────────┐
       │   本地工作区   │  │   本地结果 Mailbox │
       └───────▲────────┘  └──────────▲──────────┘
               │ 编辑/git/测试        │ 本地读取/确认
               └──────────┬───────────┘
                    ┌─────┴───────┐
                    │Codex Harness│
                    └─────────────┘
```

- **出站控制面（浏览器 UI）**：Codex 向 ChatGPT 发送极小的 `[C2C]` RESEARCH、
  INIT 和 EXECUTED 消息。完整状态循环是
  `[RESEARCH] → INIT → PLAN → EXECUTED → REVIEW → DONE`；
  绝不粘贴 diff、日志或文件内容。
- **数据面（MCP）**：ChatGPT 缺什么自己拉什么，共 9 个只读工具：
  `workspace_info`、`list_directory`、`read_file`、`search_workspace`、
  `git_status`、`git_diff`、`test_status`、`execution_summary`、
  `execution_output`。
- **返回面（本地 Mailbox）**：`report_control_progress` 返回受限且只能前进的
  进度；`submit_control_result` 只接受与有效一次性请求绑定的
  RESEARCH/PLAN/REVIEW/DONE/BLOCKED 结构化结果；每个请求严格对应一次提问和
  一次回答，Codex 使用同一 local-session/task/iteration/phase 在本地读取并
  确认，不再解析页面正文。
- **并行会话**：一个 ChatGPT Project 归工作区共享；每个本地 Codex 会话拥有
  独立的 ChatGPT 对话、检查点和结果请求。C2C 会返回该会话唯一的目标 URL；
  即使页面被切换，Skill 也会先跳回并确认正确对话，再发送控制消息。
- **独立审查**：Codex 执行完毕后，ChatGPT 通过 MCP 亲自检查真实的 git diff
  以及只属于当前本地会话、任务和轮次的测试记录，不会因为 Codex 说"测试全过"
  就直接相信。

结果返回默认优先使用本地 mailbox，失败时回退页面解析。可以在工作区的
`.c2c.json` 中选择严格模式：

```json
{ "resultTransport": "auto" }
```

可选值：`auto`（默认）、`mailbox`、`browser`（旧流程）。

## 安全模型（简版）

- **工作区从构造上只读**：服务端不存在写文件/删除/Shell/提交类工具。两个受限
  写工具只把进度或结构化建议写入 C2C 状态，不能选择工作区写入目标，并要求带
  作用域且会过期的一次性请求。
- **一个工作区 = 一道边界**：每个令牌绑定单一工作区；路径校验基于规范化
  realpath（symlink、`../`、绝对路径逃逸全部被拦截并有测试覆盖）。
- **敏感文件永不外泄**：`.env*`、密钥、SSH、各类凭据默认拒绝
  （`.env.example` 放行）；`.c2cignore` 可追加自定义规则。
- **知道 URL 不等于有权限**：公网 MCP 端点强制 OAuth 2.1（PKCE S256、动态
  客户端注册、refresh token 轮换）。无令牌：401；令牌属于别的工作区：403。
- **模型永远接触不到长期凭据**：唯一会出现在浏览器里的秘密是一次性配对码
  （5 分钟有效、限 5 次尝试、限速、用后即毁）。

完整威胁模型：[docs/security.md](docs/security.md)

## 开发者

```bash
pnpm install
pnpm build          # 产出 dist/，暴露 c2c 命令
pnpm test           # vitest：路径安全、OAuth、配对、mailbox、MCP 端到端

c2c setup           # 一条命令：Bridge + 隧道 + 配对码
c2c sandbox-allow   # 把本地设置目录加入 Codex 沙箱白名单（macOS / Windows）
c2c status / doctor / pair / unpair / logs / stop
```

环境要求：Node.js >= 20、git；公网连接需要 `cloudflared`
（自动检测，Skill 会替你安装）。

文档：[架构](docs/architecture.md) · [协议](docs/protocol.md) ·
[安全](docs/security.md) · [故障排查](docs/troubleshooting.md)

## 目录结构

```
src/
  bridge/     本机回环 HTTP 服务、端口自动恢复、管理 API
  mcp/        9 个只读数据工具 + 受限进度/结果提交、无状态 Streamable HTTP
  auth/       OAuth 2.1（PKCE、动态注册、refresh 轮换、吊销）
  pairing/    一次性配对码（CSPRNG、TTL、限速）
  workspace/  路径收敛、敏感文件策略、搜索、git
  tunnel/     TunnelProvider 抽象 + Cloudflare Quick Tunnel
  execution/  审查闭环所需的执行记录
  control/    研究/结果/进度 schema 与本地 mailbox 生命周期
  session/    工作区 Project 绑定 + 每个本地会话的对话/检查点
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
