# Issue Log

记录日期：2026-09-05

本文档用于集中记录本项目在“一个全局 Connector/Tunnel、多项目、多本地会话、ChatGPT 页面回写”方案中发现的问题。这里的状态只表示当前仓库和本机验证到的事实；实现恢复流程前，先逐项确认验收条件。

## 当前开放问题

| ID | 问题 | 当前证据 | 后续处理方向 |
| --- | --- | --- | --- |
| C2C-001 | 本地会话绑定的 ChatGPT 对话被归档或删除后，不能自动恢复 | 旧链接仍可打开，但页面显示“此对话已归档。要继续，请先将其取消归档”；本地 `session get` 没有可提交的 `chatUrl` 和页面租约 | 只针对当前 `localSessionId` 做健康探测；发现归档、关闭、URL 不匹配或页面失效时，创建新的 Project 内 Chat，完成 BOOT 校验后原子替换路由 |
| C2C-002 | 会话失效探测与新会话创建尚未形成完整生命周期 | 当前已有精确 `tabId`、Project/chat URL、generation 的校验规则，但没有把“失效 -> 新页面 -> 新 Chat -> 提交新路由”作为一个已验证的自动流程 | 增加可重入、幂等、单会话隔离的 replacement/rebind 流程；旧 context、lease 和 mailbox 请求必须按状态撤销或收敛 |
| C2C-003 | 归档与删除的用户语义需要区分 | 本次页面明确提供“取消归档”，不是删除后可继续的状态；仅凭 URL 存在不能判断会话可用 | 健康检查同时记录 HTTP/页面可达、Project 归属、会话可发送三种状态；归档页面应标记为不可发送并进入 replacement 流程 |
| C2C-004 | ChatGPT 对话向本地 MCP 回写的端到端验证仍不完整 | 当前机器 Gateway、Tunnel 和 mailbox 健康，但尚未在不依赖浏览器最后一条文本的前提下完成一次多会话写回验收 | 用独立测试会话验证 `control open -> ChatGPT MCP submit_control_result -> control wait/ack`，确认 request/task/iteration/phase 严格对应 |
| C2C-005 | 文件/mailbox 更新与浏览器页面感知的职责边界需继续固化 | 浏览器页面只能负责发送和页面健康检查；控制结果应来自受保护 mailbox，而不是读取“最新回复”或截图 | 保持 mailbox 为唯一结果通道；页面文本只用于 BOOT 配对和可用性诊断，不得作为控制结果来源 |
| C2C-006 | 多项目、多会话的后台页面自动配对仍需实测 | 设计上一个工作区对应一个 ChatGPT Project、一个本地会话对应一个 Project 内 Chat/page；本次本地路由为空，未完成新页面配对 | 在两个工作区、至少两个本地 session 上验证 Project、chatUrl、tabId、generation 和 context_id 互不串用，且不抢占用户前台页面 |
| C2C-007 | ChatGPT Project/Chat 的自动创建依赖浏览器页面，失败时的交互恢复未定义 | 官方 Tunnel 不提供可信 Project ID/Conversation ID；页面归档、登录、验证码或权限页都可能阻塞创建 | 为每个阻塞状态提供单会话可重试状态机；需要用户操作时只请求一次明确动作，完成后重新校验精确页面 |
| C2C-008 | ChatGPT 模型“最新/更高权重”没有机器侧强制保证 | 当前 `modelId`/`effort` 可作为任务元数据，但实际模型选择仍由 ChatGPT 页面选择器和账号默认值决定 | 将任务优先级与 `reasoningProfile` 分开；发送前记录并检查页面模型，不能假定官方更新会自动改变历史页面配置 |

## 已实现或已确认的基础能力

| ID | 项目 | 状态/证据 |
| --- | --- | --- |
| C2C-101 | 全局 Connector/Tunnel | 已采用一个 `Codex with ChatGPT` Connector、`Authentication: None` 和一个官方 OpenAI Secure MCP Tunnel；本机 `machine status`/`doctor` 均为 ready/ok |
| C2C-102 | 一次安装、跨项目使用 | Skill 已全局安装并与当前 checkout 匹配；工作区只负责注册和路由，不复制 Connector 或启动第二个 Gateway |
| C2C-103 | 并发模型 | 机器容量已从早期的 5 调整为最多 100 个未过期 `(projectId, localSessionId)` 页面租约；同一 session 内串行，不同 session 可并行 |
| C2C-104 | ChatGPT-first 分派 | `RESEARCH`、`PLAN`、`REVIEW` 的只读分析、外部资料和 Web Search 优先交给 ChatGPT；本地 Codex 保留文件写入、命令、测试、Git 和最终验证 |
| C2C-105 | 精确页面绑定 | 已规定只使用保存的 `tabId`，校验 Project/chat URL、generation 和 lease；禁止按标题、前台状态、最近使用或相似 URL 选页 |
| C2C-106 | 能力上下文隔离 | MCP 调用必须携带短期 `context_id`，并绑定 workspace、project、local session、task、iteration、phase 和 scopes；页面轮换、过期、重启或 compaction 后必须重新签发 |
| C2C-107 | Git 署名 | 先前临时克隆复制本地 `peak.crush` 配置，造成 `peak-xiong-crush` 署名；当前分支提交已核对为 `peak-xiong`，后续提交仍需在提交前复核 `git config user.name/user.email` |

## 本次归档链接只读测试

- 目标：`https://chatgpt.com/g/g-p-6a990cc1cae481918ea800db3932582b-codex-with-chatgpt/c/6a9bc923-7c24-83ec-8331-b436668e0e05`
- 方法：仅在内置 in-app browser 中以后台标签打开并读取语义页面状态；没有输入消息、没有调用 Connector/MCP、没有点击“取消归档”、没有提交新租约。
- 结果：页面仍属于 `codex-with-chatgpt` Project，原 Chat URL 可达；页面正文显示“此对话已归档。要继续，请先将其取消归档”，并提供“取消归档”按钮。因此该 URL 是“可访问但不可继续发送”，不能视为健康会话。
- 本地状态：当前 `session get` 返回 `projectUrl: null`、`chatUrl: null`、`surface: null`，没有可用的本地页面绑定；本次未修改该状态。
- 结论：后续自动恢复应创建并验证新的 ChatGPT Chat/page，再提交新路由；不应把归档页面直接当作可用页面，也不应未经用户要求自动取消归档。

## 恢复流程验收条件

1. 只影响失效的 `localSessionId`，其他工作区、session 和用户页面保持不变。
2. 新页面从已保存的 Project URL 创建，使用精确返回的 `tabId`，不按 URL 或标题抢占已有标签页。
3. 新 Chat 完成 BOOT 校验且 workspace 名称匹配后，才提交新的 `chatUrl` 和 generation。
4. 旧 context、lease、未完成 mailbox request 的处理结果可审计；不得继续使用旧 context_id。
5. 至少两个独立 session 并行测试通过，结果只能通过对应 mailbox request 关联回本地会话。
6. 归档、关闭、URL 错配、Gateway 重启和页面生成号变化均能触发同一套安全恢复门禁。

