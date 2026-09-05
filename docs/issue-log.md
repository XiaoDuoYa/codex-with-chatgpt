# Issue Log

记录日期：2026-09-05。提交目标：PR #409。

状态只表示已实现和实际验证的范围；自动化测试与真实 ChatGPT 验证分别记录。

## 恢复与结果回写

| ID | 问题 | 收口状态与证据 |
| --- | --- | --- |
| C2C-001 | 归档或删除后恢复 | 已实现宿主语义观察与 `surface check` 门禁。真实归档页面已确认不可发送，保持归档；独立测试 session 在原 Project 创建新 Chat、完成 BOOT 和 MCP 回写。真实删除场景尚未实测，明确不可用状态已有自动化覆盖。 |
| C2C-002 | 恢复生命周期与任务保留 | 已实现精确 tab/generation 替换、旧 context 撤销、未收敛请求阻止轮换。Skill 规定每次恢复最多创建一个替代页面，保留任务和 checkpoint，不使用永久退役进行恢复。 |
| C2C-003 | 归档、关闭与暂时失败混淆 | 归档/明确不可用创建 Project 内新 Chat；关闭/URL 错配重开原 Chat；登录/同意需要用户操作；加载/生成等待；不明确时继续诊断。空路由不等于归档或删除。 |
| C2C-004 | 真实 MCP 回写 | 主会话 PLAN 与恢复测试会话 PLAN 均通过 ChatGPT 的 `submit_control_result` 到达本地 mailbox，按精确 request/session/task/iteration/phase 读取、保存 checkpoint 并 ack。不是以页面最新文本作为验收结果。 |
| C2C-005 | mailbox 与页面职责 | `surface get/check` 返回活动请求，即使 checkpoint 尚未写入。received 结果在 ack 前不随请求 TTL 被清理。页面只负责发送、BOOT 与健康诊断，业务结果只从受保护 mailbox 读取。 |
| C2C-006 | 多项目、多会话后台配对 | 真实同 Project 两个独立 session 已分别写回；自动化覆盖跨工作区隔离、精确页归属及 100 个活动会话流程。两个不同 ChatGPT Project 的同时真实回写及 100 个真实网页同时生成尚未验收。 |
| C2C-007 | UI 创建和授权阻塞 | Skill 已定义逐会话恢复、一次明确用户操作和重验流程；CLI 评估宿主观察，本身不能调用宿主 CUA 或独立判断 ChatGPT 页面是否被删除。登录、验证码和同意页仍需用户处理。 |
| C2C-008 | 模型选择 | 明确默认使用页面当前模型。`modelId`/`effort` 只记录意图，不操作选择器；明确指定模型时由宿主选择并验证。不保证历史 Chat 自动切换到官方最新模型。 |

## 收口中发现的缺陷

| ID | 根因 | 修复与验证 |
| --- | --- | --- |
| C2C-009 | Tunnel 子进程设置 `C2C_STATE_DIR` 后，把仓库会话状态转向机器目录；CLI 的 checkpoint 与 Gateway 的路由分裂 | 已注册仓库的数据目录优先于机器状态覆盖。新增独立进程测试：CLI 写 checkpoint、Tunnel 环境写 route、CLI 更新元数据、另一进程重读，验证同一文件和完整进度。 |
| C2C-010 | 注册表清理时复用同一个 Map/Set，先 clear 后遍历丢失其他项目 | 提交后复制新集合；覆盖注销一个项目、注册第三个项目、保留首个项目并重建注册表的回归测试。 |
| C2C-011 | 部分 Gateway 单测未隔离机器状态，且临时非 Git 目录继承了真实仓库的项目身份 | 每项 Gateway 测试隔离机器状态；测试目录设置 Git 搜索边界，临时目录不再继承本仓库身份。该问题曾在本机测试时清除页面绑定，并中断一次 REVIEW；中断结果未计为通过。 |
| C2C-012 | 一个会话首次绑定共享 Project 后，另一会话先前保存的无路由 checkpoint 被误判为损坏 | 读取时从共享 Project 状态刷新 checkpoint 的 Project 镜像，不从镜像生成路由；保留 task、iteration、goal 和结果 ID。覆盖双会话先存进度再分别绑定，以及旧镜像不能覆盖共享路由。 |

## 保留的基础能力

| ID | 项目 | 状态 |
| --- | --- | --- |
| C2C-101 | 一个全局连接器 | `Codex with ChatGPT`、Authentication None、一个官方 OpenAI Secure MCP Tunnel、一个机器 Gateway。 |
| C2C-102 | 全局安装更新 | Skill 与托管 runtime 一次安装；各项目只注册和保存本项目状态，无需复制插件或逐项目维护版本。 |
| C2C-103 | 并发 | 最多 100 个未过期的 `(projectId, localSessionId)` 页面租约；同 session 串行，不同 session 独立。101 个新 session 需等待容量释放，不抢占已有页面。 |
| C2C-104 | ChatGPT-first | RESEARCH/PLAN/REVIEW 优先交给网页和只读 MCP；Web Search 使用 ChatGPT 自带能力。编辑、命令、测试、Git 与最终验证留在本地。 |
| C2C-105 | 精确页面绑定 | 只使用保存或新创建返回的 tabId，核验 Project/chat URL 与 generation；不按名称、最近使用或前台状态选页。 |
| C2C-106 | 能力隔离 | MCP 必须携带短期能力，绑定工作区、session、任务、阶段、generation 和 scopes；重启、轮换或过期后重新签发。 |
| C2C-107 | Git 署名 | 本轮使用 `Xiong Feng <16359576+peak-xiong@users.noreply.github.com>`，未改写已合并历史。 |

## 尚需单独验收

- Windows 原生安装、运行、升级与恢复；本轮环境是 macOS。
- 旧 OAuth/Cloudflare 配置切换至机器级方案的完整用户流程。旧运行路径已移除，不提供双栈兼容。
- 真正删除 Chat 后恢复、两个不同 ChatGPT Project 的同时真实 MCP 写回。
- ChatGPT 页面与账号的额度、生成并发、登录有效期不由本地 100 租约容量保证。
- 上游作者仍需确认机器级架构与安全边界变更；作者的 Agent 留言不是人工批准。

## 归档测试边界

原对话显示“此对话已归档。要继续，请先将其取消归档”。测试未取消归档，未在原对话
发送消息。恢复测试使用独立本地 session，创建原 Project 内的新 Chat 后通过真实 MCP
写回并确认结果。主会话也完成过精确缺失 tab 的原 Chat 重开和 BOOT 验证。详细状态机
及重放约束见 [protocol.md](protocol.md#page-recovery)。
