# Codex with ChatGPT

<p align="center">
  <a href="README.md">English</a> | <a href="README.ja.md">日本語</a> | <strong>简体中文</strong> | <a href="README.zh-TW.md">繁體中文</a>
</p>

> **ChatGPT 负责思考，Codex 负责干活。**  
> 把 ChatGPT 作为规划大脑，同时保留 Codex 的本地执行能力。

---

## 解决什么问题

ChatGPT Plus/Pro 付费订阅的网页版额度大量闲置，Codex 却在消耗紧张的 API 额度做高层规划和代码审查。

本项目把“思考”交给你已付费的网页版 ChatGPT，Codex 只负责本地执行（编辑代码、跑测试、修复错误）。

无需 API Key、不搞逆向代理——官方网页界面直接连接安全、只读的 MCP 桥接服务。

## 这是什么

**Codex with ChatGPT** 把 ChatGPT 网页版变成 Codex 编码会话的“规划与审查大脑”，而执行权完全保留在 Codex 手里。

你的仓库永远不会被整包上传：ChatGPT 通过一条安全的、OAuth 2.1 保护的**只读** MCP（Model Context Protocol）连接，按需读取当前工作区里真正需要的代码片段。

## 一段话安装（纯小白专用）

不懂 git、Node、终端？完全不需要懂。把下面这段话原样复制给你的编码 Agent（Codex），然后去倒杯咖啡：

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

**自动更新**：Skill 每天自动检查一次 GitHub，有新版本会自动更新并继续任务，无需任何操作；也可以随时对 Codex 说“更新 Codex with ChatGPT”。

---

## 安装 → 配置 → 使用（手动版）

1. **安装 Skill**：把 `skill/` 目录复制到 `~/.codex/skills/codex-with-chatgpt/`。
2. **首次配置**：对 Codex 说：**“使用 Codex with ChatGPT 完成首次配置。”**
3. **日常使用**：对 Codex 说：**“使用 Codex with ChatGPT，帮我实现 [某功能/任务]。”**

说明书到此结束。Codex 会自动完成所有配置，你只会看到：

```
Codex with ChatGPT

✓ 当前项目已识别
✓ Workspace Bridge 已启动
✓ 安全连接已建立
✓ ChatGPT 已连接
✓ 文件读取测试通过

Ready.
```

唯一可能需要你动手的步骤：登录 ChatGPT。仅此而已。

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

- **控制面（状态消息）**：Codex 与 ChatGPT 之间只交换极小的结构化 `[C2C]` 状态消息（`INIT → PLAN → EXECUTED → REVIEW → DONE`）。绝不在聊天框中粘贴 diff、日志或文件内容。
- **数据面（MCP）**：ChatGPT 缺什么自己按需拉取，共 8 个只读工具：
  `workspace_info`、`list_directory`、`read_file`、`search_workspace`、`git_status`、`git_diff`、`test_status`、`execution_summary`。
- **独立审查**：Codex 执行完毕后，ChatGPT 通过 MCP 亲自检查真实的 `git_diff` 和测试记录——绝不盲目相信“测试全过”的口头声明。

---

## 安全模型（简版）

- **从构造上只读**：服务端根本不存在写文件、删除、Shell 执行、代码提交类工具，任何提示注入都无法启用它们。
- **一个工作区 = 一道边界**：每个令牌绑定单一工作区；路径校验基于规范化 `realpath`（symlink、`../`、绝对路径逃逸全部被拦截并有测试覆盖）。
- **敏感文件永不外泄**：`.env*`、密钥、SSH、各类云端凭据默认拒绝（`.env.example` 放行）；`.c2cignore` 可追加自定义规则。
- **知道 URL 不等于有权限**：公网 MCP 端点强制 OAuth 2.1（PKCE S256、动态客户端注册、refresh token 轮换）。无令牌：401；令牌属于别的工作区：403。
- **模型永远接触不到长期凭据**：唯一会出现在浏览器里的秘密是一次性配对码（5 分钟有效、限 5 次尝试、限速、用后即毁）。

完整威胁模型见 [docs/security.md](docs/security.md)。

---

## 开发者

```bash
pnpm install
pnpm build          # 产出 dist/，暴露 c2c 命令
pnpm test           # vitest：单元与集成测试

c2c setup           # 一条命令：Bridge + 隧道 + 配对码
c2c sandbox-allow   # 把本地设置目录加入 Codex 沙箱白名单（macOS / Windows）
c2c status / doctor / pair / unpair / logs / stop
```

**环境要求**：Node.js >= 20、git；公网连接需要 `cloudflared`（自动检测，Skill 会替你安装）。

**详细文档**：
- [架构设计](docs/architecture.md)
- [协议规范](docs/protocol.md)
- [安全模型](docs/security.md)
- [故障排查](docs/troubleshooting.md)

---

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
  process/    守护进程生命周期
  cli/        c2c 命令行
skill/        Codex Skill 定义
tests/        单元与集成测试
docs/         架构、协议、安全与故障排查文档
```

---

## 声明与许可证

**非官方社区项目，与 OpenAI 无关联或背书。**

遵循 [MIT 许可证](LICENSE)。
