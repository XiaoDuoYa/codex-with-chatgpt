# Issue Log

记录日期：2026-09-05。提交目标：PR #409。

状态只表示已实现和实际验证的范围；自动化测试与真实 ChatGPT 验证分别记录。

## 最新回传验收修复

- 针对 crush 工作区的验收报告，确认纯本地 RESEARCH 被 `sources.min(1)` 错误要求提供外部 URL。现在允许 `sources: []`，本地证据写入 conclusions 的相对文件路径/行号；仍拒绝 `workspace:/`、`file://` 和带凭据的外部 URL，不伪造引用。
- `control open --json` 返回当前阶段的 `resultContract`，包含必需回传工具、合法 payload 示例和失败处理约束；Skill 与协议同步更新。逐消息检查 `submit_control_result` 实际可用性；状态工具可选，Codex 仍以精确 mailbox received/acknowledged 为准。
- 本地 MCP SDK 测试覆盖两个工作区并行、每个工作区连续两轮本地读取和回传确认，验证工具仍列出且写入标注未被改为只读。这不等同于网页工具持续可用。
- 修复后 `corepack pnpm exec vitest run --maxWorkers=2`：37 个文件、491 项测试完整通过，退出码 0；类型检查、构建、Skill 校验、生产依赖审计和 diff 检查通过。首次默认测试进程数运行虽全部用例通过，但 undici 出现 Node/macOS `setTypeOfService EINVAL` 未处理错误，退出码 1，不计为通过；未修改产品并发或屏蔽错误。隔离修复后检查真实 mailbox，没有新的测试请求泄漏。
- 本轮真实网页仍复用 tab 9、原 Project Chat，generation 14。BOOT 读取通过；2026-09-05T13:42:24Z 创建的 `local-research-return` PLAN 请求，网页随后报告当前消息无法发现回传工具，并在分析前停止。这是模型报告，未取得原始平台发现 trace；本地没有 received 结果，精确请求及能力已取消。没有切换账号、模型或插件，也未绕过平台检查。
- 当前结论仍为“本地格式与协议已修复，真实网页持续回传未验收”。下方历史成功回传记录仅证明相应历史请求，不覆盖本次失败。恢复当前消息的工具可用性后，还需同 Chat 连续两轮真实 received/acknowledged 验证。

| ID | 问题 | 修复与验证范围 |
| --- | --- | --- |
| C2C-020 | 纯本地 RESEARCH 强制外部引用，促使无效来源 URL | 允许空外部来源，保留非空结论和 URL 安全校验；覆盖本地回传确认、非法 URL 拒绝且请求保持 pending。 |
| C2C-021 | 历史工具可用不代表后续消息可回传 | 增加逐消息 Connector 检查、结构化返回契约、失败停机和精确请求收敛说明。真实网页工具发现仍失败，根因未确定，不标记为已解决。 |
| C2C-022 | linked-worktree 测试未隔离机器 mailbox | 为该用例设置独立 C2C_STATE_DIR 并恢复原环境，验证两个请求实际位于临时机器目录。仅移出本轮两次全量运行产生的四组测试请求，保留可恢复副本；未清理其他历史记录或真实会话。 |

## 本机收口结果

- 页面复用/插件工具收口：全量运行 36 个文件、482 项用例，其中 481 项通过、1 项原有 CLI 流程超过 30 秒；调整该文件子进程等待至 30 秒、两个长流程至 90 秒后，整个 CLI 文件 11 项复跑通过。类型检查、构建、Skill 校验和生产依赖审计通过。早期还遇到一次临时测试服务启动超时，单独复跑通过；没有更改产品超时或权限来掩盖测试问题。
- 本轮 PLAN 与 REVIEW 均复用原 tab 9 / generation 12 / 同一 Chat，并通过 MCP 写回本地；REVIEW 返回定向通过。未新开标签，未关闭其他用户页面。原标签内归档恢复、helper 关闭和第三方插件实际调用仍未实测，不以代码测试替代这些验收。
- 本轮 Project/插件账号收口：36 个测试文件、469 项测试完整通过；类型检查、构建、Skill 校验和生产依赖审计通过。新增 Gateway 正向插件预检、身份发现及拒绝错误身份时保留原有效请求的测试。
- ChatGPT 通过真实 MCP 回写本轮 REVIEW，提出的身份发现入口缺口已修复；iteration 1 定向复核返回 DONE。结果按精确关联保存 checkpoint 并确认，仍保留下述网页插件身份及 quant-insight 的实测边界。
- 代码提交 `61be691`：`corepack pnpm exec vitest run --maxWorkers=1` 完整通过，33 个文件、452 项测试；类型检查、构建、Skill 校验与生产依赖审计通过。
- ChatGPT 的最终 REVIEW 已通过真实 MCP 到达本地 mailbox，未发现阻塞性实现缺陷；要求补齐的最终全量测试证据已完成并记录。
- 同 Project 两个独立会话同时持有活动请求，测试会话在主会话 REVIEW 尚未完成时独立写回；两个结果均已确认并保存关联 checkpoint。
- 新运行时受控重启后，两个会话的 Chat URL、tabId、generation、task、iteration 和 checkpoint 与重启前一致。一次全局安装仍为生效方式。
- 测试会话租约已释放，路由和结果记录保留；原归档对话未取消归档。下列未实测范围继续保留，不视为已验收。

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
| C2C-013 | 未配对工作区可能把任意 Project URL 当作首次绑定，例如用户报告的 quant-insight | 首次绑定必须有新建项目的真实宿主观察，或用户明确选择的精确 URL。创建标题需匹配工作区；五分钟内校验来源，并在归属锁内记录到候选租约，提交时再检查。既有权威绑定保留，不自动改绑或移动聊天。自动化已验证拒绝无来源、过期、错标题/URL及其他工作区占用；quant-insight 真实新建仍待验收。 |
| C2C-014 | 已知 chatUrl 的候选可能在同一 generation 提交同 Project 内另一个 Chat | 提交必须保留已知的精确 Chat URL；换 Chat 必须显式替换并生成新的 generation。新增回归测试。 |
| C2C-015 | 插件目录已安装不代表当前 Project Chat 可调用，目录试用可能跳入 Work 模式 | 增加逐任务插件集合和新鲜预检，核对工作区、会话、任务、阶段、页面、generation、Gateway epoch。只使用当前 Project Chat 可调用的所需插件；未知、Work-only 或需授权时阻止该插件任务。不自动安装、切模式或切账号。该预检是宿主分派约束，不是第三方插件权限沙箱。 |
| C2C-016 | 仓库 owner、gh 登录人、提交署名、Git 传输凭据及 ChatGPT 插件身份混淆 | 新增 repository-identity，按实际推送 remote 优先级解析脱敏目标与 SSH 别名，分别检查 gh 的 login/稳定 ID、作者和提交者。GitHub 插件需经过认证的自身档案 login/ID 与本地 actor 匹配；个人 fork owner 错配阻止，组织仓库另查访问权。邮件/昵称不能替代身份，SSH/HTTPS 推送身份需独立核验。正向、错配、未知、跨任务和旧观察均有测试。 |
| C2C-017 | ChatGPT REVIEW 指出：普通插件任务要求已知账号，但文档中的首次身份发现没有可表达的权限入口 | 新增 identity-discovery 意图，仅限 RESEARCH、一个 GitHub 相关插件和实际可用的认证自身档案工具；返回精确操作白名单、禁止仓库访问，C2C 仅授予结果回写。核验结果保存并确认后，普通任务使用新关联和真实匹配身份。空白插件白名单不隐含核验例外；新增 CLI、Gateway 和评估器回归测试。 |

## 页面复用与插件工具收口

| ID | 问题 | 修复与验证范围 |
| --- | --- | --- |
| C2C-018 | 每次任务/阶段或恢复重复开标签，临时设置页未明确回收 | Skill 明确同一 local session 复用同一标记进度页，任务结束不关闭它。surface check 返回 tabAction，已确认归属的归档/失效 Chat 在原 tab 内以新 generation 恢复；缺失/被导航的页使用一次受控替代，不覆盖用户页面。设置 helper 仅本轮保存确切创建句柄，用完检查并关闭；无证据的历史标签不清理，不引入后台回收服务。 |
| C2C-019 | 普通插件任务只有 app 白名单，不能表达可读工具与写工具并存 | 分离 requestedOperations 与观察到的 tools；仅放行所选且实际可用的 read 工具，输出精确 allowedOperations。缺失、重复、通配符、未知、写入及需授权的操作均拒绝。身份发现仍单独限制为认证自身档案，GitHub 业务身份门禁保持不变。此机制是宿主分派约束，不是第三方传输沙箱。 |

## 插件实测边界

- 本次页面复用/操作级插件收口：在同一 tab 9、同一 Project Chat 完成新任务 PLAN 与 REVIEW，未新开标签；当前工具入口展示网页搜索及插件搜索提示，但未取得可用于验证 GitHub 身份的实际工具证据。未执行第三方插件操作。

- 当前专属 Project Chat 使用页面显示的 `6 Pro`。GitHub 插件目录展示读、写工具，不能笼统称其为只读；本项目当前分派策略仍仅允许已核验的只读插件任务，写入和提交由本地执行。
- 连接设置只展示连接邮件，当前 Chat 未暴露可用于核验的 GitHub 认证自身档案工具。插件账号仍为 UNKNOWN，没有执行 GitHub 插件仓库操作，也没有自动重连或切账号。
- 本地本仓库目标为 `peak-xiong/codex-with-chatgpt`，有效 gh actor 为 `peak-xiong`，Git 作者和提交者均为 `Xiong Feng` 的对应 noreply 身份。此事实不证明网页插件账号相同。

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
