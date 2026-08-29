# Codex with ChatGPT · Plus 兼容模式 V0.2 架构设计

版本：V0.2 design v2

目标仓库：`XiaoDuoYa/codex-with-chatgpt`

设计日期：2026-08-29

状态：待用户评审，尚未进入实现

## 1. 目标与边界

V0.2 将 C2C 从 MCP 专用工作流升级为 Transport-independent 的双模型协作框架：

```text
Protocol（产品核心）
    │
    ├── Transport（可替换的数据通道）
    │     ├── MCPTransport（兼容现有行为）
    │     └── GitHubTransport（Plus 主路径）
    │
    └── Codex Execution（唯一执行层）
```

V0.2 的交付范围：

1. 可运行的 C2C Protocol：parse、validate、serialize、状态迁移校验。
2. 最小 Transport 抽象。
3. 现有 MCP 调用链的兼容封装，不重写 Bridge、Tunnel、OAuth、Pairing。
4. GitHubTransport branch 模式。
5. `.c2c/current.json` 机器真源与 `.c2c/current.md` 展示投影。
6. ChatGPT PLAN / DONE / BLOCKED 的人工复制导入。
7. Plus 模式完整生命周期和 Skill UX。
8. 现有 MCP 回归测试保持原行为。
9. 在真实 Plus 环境完成一轮端到端验收。

FilePackTransport 的完整实现推迟到 V0.3。V0.2 不创建空目录、空类或未使用的配置；Transport 的接口只保留实现 GitHub 和 MCP 所需的扩展能力。

### 1.1 Design v2 评审修订

Design v2 在不扩大 V0.2 范围的前提下修正七项实现前问题：

1. DONE 先记录为待最终验证的 review decision，final tests 通过后才成为终态。
2. Review 使用 taskBaseCommit、iterationBaseCommit、codeHeadCommit 与 declared paths，不把裸 commit range 称为纯代码 diff。
3. 单次 task 使用 `--transport` 覆盖，不因写 `.c2c.json` 制造 dirty workspace。
4. 只保证 `current.json` 单文件原子；Markdown 和 task 最新副本均可重建。
5. `tasks/<taskId>.json` 明确定义为最新状态副本，不声称保存历史。
6. BLOCKED 持久化 blockedFrom，并通过显式 resume 或合法 PLAN 恢复。
7. taskId 扩为 8 hex；所有非删除 declared files 均执行 sensitive path 检查。

## 2. 当前架构与实际调用链

### 2.1 CLI 与 MCP 启动链

当前 `src/cli/index.ts` 同时承担命令注册、用户输出、MCP 生命周期编排和部分状态存储。

```text
c2c setup/start/doctor
    → resolveWorkspace()
    → ensureBridgeAndTunnel()                    src/cli/index.ts
        → ensureBridge()                         src/process/daemon.ts
            → 启动 c2c serve
                → startBridge()                  src/bridge/server.ts
                    → Workspace
                    → AuthStore
                    → PairingManager
                    → CloudflaredQuickTunnel
                    → createMcpServer()
        → /admin/info
        → /admin/tunnel/start
    → /admin/pairing
    → 输出 mcpUrl + pairingCode
```

Bridge 内部调用链：

```text
ChatGPT
    → Cloudflare Quick Tunnel
    → Express /mcp
    → bearerAuth（OAuth token + workspace scope）
    → Streamable HTTP MCP
    → createMcpServer()
    → Workspace / Git read / Execution records
```

现有安全边界位于以下模块：

- `src/workspace/manager.ts`：真实路径收敛、越界防护、文本读取限制。
- `src/workspace/ignore.ts`：敏感文件与 `.c2cignore`。
- `src/workspace/git.ts`：只读 status / diff，diff 路径排除。
- `src/auth/*`：OAuth、scope、token 绑定和撤销。
- `src/pairing/*`：一次性配对码。
- `src/bridge/server.ts`：loopback-only 管理接口和 MCP 入口。
- `src/tunnel/*`：公网连接。

### 2.2 当前 C2C 控制链

当前协议并没有运行时对象，只存在于：

- `docs/protocol.md` 的消息模板与状态说明。
- `skill/SKILL.md` 的工作流提示。
- `src/execution/records.ts` 的松散执行摘要。
- `src/cli/index.ts` 的 `session` 与 `record` 命令。

因此当前没有统一组件能够回答：

- ChatGPT 返回的是不是一个合法 C2C 消息。
- PLAN 是否属于当前 task。
- PLAN / DONE 的 iteration 是否正确。
- 当前状态是否允许迁移到目标状态。
- 同一消息如何稳定地序列化回文本。

### 2.3 MCP 耦合点清单

| 耦合点 | 当前表现 | V0.2 处理方式 |
| --- | --- | --- |
| CLI setup/start/doctor | 直接依赖 Bridge、Tunnel、OAuth、Pairing | 迁入 MCPTransport 兼容门面 |
| Skill first-time setup | 默认启动 MCP setup | 先选择 transport；Plus 直接走 GitHub |
| Skill coding workflow | 指令写死“通过 MCP 读取工作区” | 由 transport descriptor 生成访问说明 |
| Protocol 文档 | Control/Data plane 均写死 MCP | 改为 transport-independent 核心 + MCP 示例 |
| EXECUTED 记录 | 只写本机 JSONL，依赖 MCP tool 读取 | 保留 JSONL；GitHub 模式另写 task snapshot |
| doctor/status | 只描述 Bridge/MCP 状态 | 保持旧命令语义；新增 transport/task status |
| session 管理 | 假设 Codex 自动操作 ChatGPT 会话 | MCP 保留；Plus 不自动操作网页，只提示复用同一对话 |

## 3. 目标模块边界

V0.2 采用以下结构：

```text
src/
  protocol/
    types.ts          运行时消息与 task snapshot 类型、schema
    parser.ts         容错文本解析
    validator.ts      语义校验与状态迁移
    serializer.ts     稳定文本序列化
    instructions.ts   基于 transport descriptor 生成 PLAN / REVIEW 指令

  task/
    store.ts          current.json 真源读写、原子更新、current.md 投影
    projection.ts     JSON snapshot → Markdown（单向）
    lifecycle.ts      task 状态机编排，不执行 git 或 MCP 细节

  transport/
    types.ts          最小 Transport interface 与 receipts
    select.ts         配置读取和 auto 选择
    mcp.ts            现有 MCP 生命周期兼容门面
    github.ts         GitHub branch 发布实现

  github/
    repository.ts     repo/remote/branch/commit/push 原语
    security.ts       待发布路径和敏感文件检查

  cli/
    index.ts          Commander 入口与向后兼容命令
    task.ts           task/transport/publish/import 命令注册
```

不把 GitHub 特判写进 Protocol，也不把 Protocol 解析写进 GitHubTransport。CLI 只组合 application services，不持有业务状态机。

## 4. Protocol 运行时模型

### 4.1 消息对象

Protocol v1 使用判别联合，而不是只有 interface 声明：

```ts
type C2CState =
  | "INIT"
  | "PLAN"
  | "EXECUTING"
  | "EXECUTED"
  | "DONE"
  | "BLOCKED";

interface C2CMessageBase {
  protocolVersion: 1;
  taskId: string;
  iteration: number;
  state: C2CState;
  sections: Record<string, string>;
}

interface PlanMessage extends C2CMessageBase {
  state: "PLAN";
  sections: {
    GOAL?: string;
    RATIONALE?: string;
    ACTIONS: string;
    TESTS: string;
    SUCCESS_CRITERIA: string;
    [key: string]: string | undefined;
  };
}

interface DoneMessage extends C2CMessageBase {
  state: "DONE";
  sections: { SUMMARY?: string; [key: string]: string | undefined };
}

interface BlockedMessage extends C2CMessageBase {
  state: "BLOCKED";
  sections: { REASON: string; NEEDS?: string; [key: string]: string | undefined };
}

interface AcceptedReviewDecision {
  state: "DONE";
  taskId: string;
  iteration: number;
  acceptedAt: string;
  requiresFinalValidation: true;
}
```

运行时 schema 使用项目已有的 `zod`，确保 JSON snapshot 和解析后的消息都经过实际校验。`protocolVersion` 在序列化时总是显式写出；导入旧消息时可在缺省情况下推断为 `1` 并产生 warning。

### 4.2 parse / validate / serialize 分层

`parseC2CMessage(text)` 只解决语法提取：

1. 允许 `[C2C]` 前后存在普通说明文字或 Markdown code fence。
2. 支持 CRLF / LF。
3. Header 名称大小写不敏感，规范化为 `STATE`、`TASK_ID`、`ITERATION`、`PROTOCOL_VERSION`。
4. Section 标题以独占行 `NAME:` 识别，保留未知 section，避免因 ChatGPT 多说内容而失败。
5. 不执行 task 上下文校验，也不写任何文件。
6. 返回 `{ ok, message?, diagnostics[] }`，diagnostic 带 `code`、`severity`、`message`。

`validateImportedMessage(message, expected)` 解决语义约束：

```ts
interface ImportExpectation {
  taskId: string;
  currentState: TaskState;
  currentIteration: number;
  allowedIncoming: Array<"PLAN" | "DONE" | "BLOCKED">;
}
```

硬错误：

- 缺少或无法识别 `STATE`。
- 明确给出的 `taskId` 与当前 task 不一致。
- 明确给出的 `iteration` 与预期不一致。
- 当前状态不允许目标状态。
- PLAN 缺少 `ACTIONS`、`TESTS` 或 `SUCCESS_CRITERIA`。
- BLOCKED 缺少 `REASON`。
- 未知协议版本。

可恢复 warning：

- 缺少 `[C2C]` 标识但关键 header 完整。
- 缺少 `protocolVersion`，按 v1 处理。
- 允许推断的 iteration 未写出。
- 存在未知 section 或额外说明文字。

`serializeC2CMessage(message)` 只接受通过 schema 的对象，输出确定性格式：固定 header 顺序、固定空行、CRLF 无关、section 使用稳定顺序；parse → serialize → parse 必须保持语义等价。

ChatGPT 返回的 `DONE` 首先是 review decision，不会让公开 task state 立即进入 DONE。`task import` 返回 `acceptedDecision: DONE` 和 `requiresFinalValidation: true`，并在 snapshot 中记录 `pendingDecision` 以支持进程重启后的恢复。只有 `lifecycle.finalizeDone()` 在 final tests 通过后才真正写入 `state: DONE`。

### 4.3 iteration 定义

`iteration` 表示已进入或完成的执行轮次：

- `INIT`：iteration 0。
- 初次 `PLAN`：iteration 1。
- `EXECUTING` / `EXECUTED`：iteration n。
- 对 EXECUTED n 的复审结果：
  - `DONE` / `BLOCKED` 必须是 iteration n。
  - 新一轮 `PLAN` 必须是 iteration n + 1。

若 ChatGPT 未写 iteration，解析器可根据当前 task 推断；若明确写错则硬失败，不能静默改正。

### 4.4 状态机

允许的状态迁移：

| 当前状态 | 输入/动作 | 下一状态 |
| --- | --- | --- |
| 无任务 | start | INIT(0) |
| INIT(0) | 导入 PLAN(1) | PLAN(1) |
| INIT(0) | 导入 BLOCKED(0) | BLOCKED(0) |
| PLAN(n) | Codex 开始执行 | EXECUTING(n) |
| EXECUTING(n) | 发布执行结果 | EXECUTED(n) |
| EXECUTED(n) | 导入 PLAN(n+1) | PLAN(n+1) |
| EXECUTED(n) | 导入 DONE(n) | 保持 EXECUTED(n)，记录 pendingDecision=DONE |
| EXECUTED(n) | 导入 BLOCKED(n) | BLOCKED(n) |
| EXECUTED(n) + pendingDecision=DONE | final tests 通过 | DONE(n) |
| EXECUTED(n) + pendingDecision=DONE | final tests 失败 | 清除 pendingDecision，保持 EXECUTED(n) |
| BLOCKED(n) | `task resume` | 精确回到 blockedFrom.state / iteration |
| BLOCKED(n) | 导入新的合法 PLAN | PLAN(n+1)，清除 blockedFrom |
| DONE(n) | 无 | 终态；新目标必须创建新 task |

状态迁移由 `task/lifecycle.ts` 唯一执行。Transport 无权自行改变 task 状态。`PENDING_DONE` 不是公开 Protocol state；它只是 EXECUTED snapshot 上的待验证 decision，避免 final tests 失败时发生 DONE → EXECUTED 倒退。

## 5. Task Snapshot 与投影

### 5.1 `current.json` 是唯一机器真源

建议 schema：

```json
{
  "protocolVersion": 1,
  "taskId": "c2c_f81a9c2d",
  "transport": "github",
  "state": "EXECUTED",
  "iteration": 3,
  "goal": "Fix runtime assembly contract",
  "createdAt": "2026-08-29T00:00:00.000Z",
  "updatedAt": "2026-08-29T01:00:00.000Z",
  "repository": {
    "provider": "github",
    "owner": "org",
    "name": "repo",
    "remote": "origin",
    "branch": "c2c/c2c-f81a9c2d-runtime-contract"
  },
  "taskBaseCommit": "full-sha",
  "iterationBaseCommit": "full-sha",
  "codeHeadCommit": "full-sha",
  "declaredChangedFiles": ["src/a.ts", "tests/a.test.ts"],
  "tests": {
    "status": "passed",
    "summary": "83 passed",
    "command": "corepack pnpm test"
  },
  "reviewFocus": "Check protocol compatibility and state transitions.",
  "lastImported": {
    "state": "PLAN",
    "receivedAt": "2026-08-29T00:30:00.000Z"
  },
  "pendingDecision": null,
  "blockedFrom": null
}
```

规则：

- 只从 JSON 恢复任务。
- 每次写入前后都通过 zod schema。
- 使用临时文件 + rename 原子替换 `current.json`，避免真源半写状态。
- 不在 JSON 中保存 ChatGPT 全文、源码、diff、token 或凭据。
- `.c2c/current.json` 是活动任务唯一机器真源。
- `.c2c/tasks/<taskId>.json` 是该 task 的最新持久状态副本，不宣称保存 iteration 历史；活动期间若两者不一致，以 `current.json` 为准并重建 task 副本。
- V0.2 不做 event sourcing。完整历史目录留待真正出现审计需求时另行设计。

### 5.2 `current.md` 是确定性展示投影

`current.md` 只能由 `renderCurrentTask(snapshot)` 生成：

- 程序永不解析 `current.md`。
- 用户手改 Markdown 不影响机器状态；下一次发布会重新生成。
- 内容仅包含任务元数据、提交范围、文件列表、测试摘要、review focus 和指令。
- 不复制源码、完整 diff 或长日志。
- Markdown 末尾声明：机器状态以 `.c2c/current.json` 为准。

`writeTaskSnapshot()` 不宣称提供跨文件事务。崩溃一致性顺序固定为：

1. 在内存中构造并校验新 snapshot。
2. 使用 temp + rename 原子写入 `current.json`。
3. 重新读取已经落盘的 `current.json`。
4. 从该 JSON 确定性生成 `current.md` 和 `tasks/<taskId>.json` 最新副本。
5. `start`、`status`、`publish` 若发现投影缺失或内容不一致，自动从 `current.json` 重建。

因此只保证真源单文件原子；Markdown 和 task 最新副本是可重建投影。投影生成失败时不进入 Git commit，并保留已校验的 `current.json` 供下一次命令恢复。

## 6. Transport interface 的最小职责

Transport 只负责“如何使 task snapshot 对 ChatGPT 可见”，不负责协议解析、状态迁移或 Codex 执行。

```ts
type TransportKind = "mcp" | "github";

interface TransportDescriptor {
  kind: TransportKind;
  locator: Record<string, string>;
  capabilities: {
    directRead: boolean;
    requiresManualRelay: boolean;
  };
}

interface TransportReceipt {
  descriptor: TransportDescriptor;
  publishedAt: string;
  revision: string | null;
}

interface C2CTransport {
  readonly kind: TransportKind;
  prepare(input: PrepareTransportInput): Promise<TransportReceipt>;
  publish(input: PublishTransportInput): Promise<TransportReceipt>;
  status(input: TransportStatusInput): Promise<TransportStatus>;
  doctor(input: TransportDoctorInput): Promise<DoctorResult>;
}
```

边界说明：

- `prepare`：建立 transport 所需的可见上下文。MCP 启动连接；GitHub 创建分支并发布 INIT snapshot。
- `publish`：发布已由 lifecycle 验证的 snapshot。MCP 记录 execution summary；GitHub commit/push。
- `status` / `doctor`：只检查该通道，不改变 protocol state。
- Transport 不解析 ChatGPT 消息。
- Transport 不运行用户测试。
- Transport 不决定 changed files。
- Transport 不自行进入 DONE。
- ChatGPT 指令由 `protocol/instructions.ts` 基于 descriptor 和 snapshot 生成，避免各 transport 漂移协议格式。

## 7. MCPTransport 无行为变化迁移

V0.2 的 MCPTransport 是兼容门面，不是内部重写。

### 7.1 保持不动的模块

原则上不改变：

- `src/bridge/server.ts`
- `src/bridge/runtime.ts`
- `src/process/daemon.ts`
- `src/auth/*`
- `src/pairing/*`
- `src/mcp/*`
- `src/tunnel/*`
- Workspace containment 与 sensitive-file policy

### 7.2 迁移方式

把当前 `src/cli/index.ts` 中的 `ensureBridgeAndTunnel()` 及相关 MCP 响应类型移动/封装到 `src/transport/mcp.ts`，形成应用级方法：

```ts
prepare()   ≈ 现有 setup 的 bridge + tunnel + pairing
publish()   ≈ 现有 appendExecutionRecord
status()    ≈ 现有 status 的 bridge/admin info
doctor()    ≈ 现有 doctor 的 MCP 部分
```

旧命令继续存在并保持：

- 命令名和参数不变。
- `--json` 字段名不变。
- 非 JSON 用户文案原则上不变。
- `c2c setup` 仍明确表示 MCP 首次配置，不被 auto transport 改写。
- `c2c pair`、`unpair`、`start`、`stop`、`restart`、`doctor` 继续服务 MCP。

新增的通用入口使用 `c2c task ...` 和 `c2c transport ...`，不复用或改变旧命令语义。

### 7.3 回归门槛

进入 GitHubTransport 实现前必须满足：

1. MCP 原测试无新增失败。
2. setup/start/status/doctor/pair/unpair 的 CLI contract 测试通过。
3. `/mcp` 未授权仍返回 401。
4. OAuth、pairing、scope、token rotation 测试通过。
5. Bridge 仍只监听 loopback。

Windows 现有 symlink 权限和跨平台路径断言问题要单独修成平台稳定测试，不能把它们当作 V0.2 新功能失败，也不能通过跳过安全测试来“通过回归”。

## 8. GitHubTransport 数据生命周期

### 8.1 前置条件

GitHub 模式启动 task 前必须检查：

1. workspace 位于 Git 工作树内。
2. 能解析 Git top-level。
3. 当前不是 detached HEAD。
4. 配置 remote 存在，默认 `origin`。
5. remote 是可识别的 GitHub HTTPS 或 SSH 地址。
6. 当前工作树无未归属改动。
7. 当前分支不是待创建的 C2C task branch。
8. base commit 可解析为完整 SHA。

V0.2 不自动 stash、不自动提交已有脏改动、不自动切换或修改 main/master。工作区脏时返回 BLOCKED，列出文件路径并让用户先处理。

### 8.2 task 与 branch

- task id：`c2c_` + 8 个小写十六进制字符（32-bit 随机空间）。
- branch：`c2c/<task-id-with-hyphen>-<slug>`。
- slug 来自 goal，限制 ASCII 小写、数字和短横线；空 slug 使用 `task`。
- 从当前 HEAD 创建分支，不从远端默认分支猜测。
- 若同名本地/远端分支存在：只有其 `.c2c/current.json` taskId 完全一致时才允许恢复，否则 BLOCKED。

### 8.3 INIT publish

```text
clean repo at TASK_BASE
    → 创建 task branch
    → snapshot INIT(0)
       taskBaseCommit=TASK_BASE
       iterationBaseCommit=TASK_BASE
       codeHeadCommit=TASK_BASE
    → 生成 current.json/current.md
    → 只 stage .c2c/current.* 和 .c2c/tasks/<task>.json
    → commit: c2c: start <taskId>
    → git push -u <remote> <branch>
    → 返回 repository/branch descriptor
    → 生成 PLAN instruction
```

### 8.4 PLAN import 与执行

```text
用户粘贴 ChatGPT PLAN
    → parse
    → schema validate
    → taskId / iteration / transition validate
    → 保存 PLAN 结构摘要，不保存不必要的原始全文
    → snapshot 进入 PLAN(n)
    → Codex 开始执行时进入 EXECUTING(n)
```

Protocol 导入本身不 commit/push。执行层决定实际修改、测试和 changedFiles；Transport 只接收经过确认的结果。

### 8.5 EXECUTED publish：两阶段提交

`codeHeadCommit` 不能被定义成“包含自身 SHA 的状态提交”，否则形成不可满足的自引用。因此采用两阶段：

```text
阶段 A：代码提交
    → 确认只有 declared changedFiles + .c2c 状态改动
    → 敏感文件检查
    → stage declared changedFiles
    → commit: <正常功能提交信息>
    → 得到 CODE_HEAD

阶段 B：状态投影提交
    → snapshot EXECUTED(n)
       taskBaseCommit = TASK_BASE
       iterationBaseCommit = 上一轮 codeHeadCommit（首轮为 TASK_BASE）
       codeHeadCommit = CODE_HEAD
       declaredChangedFiles = declared changed files
       tests = 本轮测试结果
    → 更新 current.json/current.md/tasks/<id>.json
    → 只 stage .c2c 文件
    → commit: c2c: publish <taskId> iteration <n>
    → push（禁止 force）
```

Git commit 图中仍会包含 INIT 和各轮 `.c2c` 元数据提交，因此不能把裸 `taskBaseCommit..codeHeadCommit` 称为“纯代码 diff”。ChatGPT 的审查对象明确为：

```text
累计任务语义：taskBaseCommit..codeHeadCommit
本轮语义：iterationBaseCommit..codeHeadCommit
路径约束：仅 declaredChangedFiles
排除：.c2c/**
```

生成 REVIEW 指令时必须同时提供三个 commit 字段和 `declaredChangedFiles`，并要求 ChatGPT 忽略 `.c2c/**`。程序侧用于验证 review 范围的 Git 命令也按 declared paths 传递 pathspec；这样即使祖先链包含状态提交，审查内容仍只覆盖声明的代码文件。

如果 push 失败，本地 task state 与提交保留，返回可重试的 `PUBLISH_FAILED`；不得 reset、force push 或自动回滚用户提交。再次执行 publish 应识别已有本地提交并幂等重试。

### 8.6 DONE

导入 DONE 后：

1. 先校验 DONE 属于当前 task 和当前 EXECUTED iteration。
2. `task import` 保持 snapshot 为 EXECUTED，只持久化 `pendingDecision: DONE`，并返回 `requiresFinalValidation: true`。
3. Codex 执行最终测试后调用 `lifecycle.finalizeDone(result)`。
4. 测试失败：清除 pendingDecision，保持 EXECUTED，记录失败摘要并生成新 REVIEW/PLAN 指令。
5. 测试通过：snapshot 才进入 DONE，清除 pendingDecision。
6. 生成状态投影提交并普通 push。
7. 不 merge、不关闭分支、不删除分支、不自动创建 PR。

## 9. Git 安全与变更归属

GitHubTransport 写操作必须具备显式路径集合：

- `declaredChangedFiles` 来自 Codex Execution 结果。
- `.c2c/current.json`、`.c2c/current.md`、`.c2c/tasks/<id>.json` 由 task store 管理。
- stage 时逐个传递路径，禁止 `git add .` 和 `git add -A`。

发布前检查：

1. `git status --porcelain=v2` 枚举 staged、unstaged、untracked、conflicted。
2. conflicted 文件直接 BLOCKED。
3. 不在 declared 集合中的脏文件直接 BLOCKED。
4. 对所有非删除的 `declaredChangedFiles` 执行现有 `IgnoreRules.isSensitive()`：新增、修改和 rename target 一律检查；纯删除可允许。
5. 尊重 `.gitignore`；被忽略文件不主动加入。
6. 检测明显敏感路径后返回 `SENSITIVE_FILE_BLOCKED`，不自动修改文件或 `.gitignore`。
7. 禁止在 `main` / `master` 上 publish execution。
8. 禁止 force push、merge、branch delete。

V0.2 不实现完整 secret 内容扫描器；只复用路径策略并阻止明显敏感文件进入自动发布集合。

## 10. 配置与 Transport 选择

`.c2c.json` V0.2 schema：

```json
{
  "transport": "auto",
  "github": {
    "remote": "origin",
    "push": true,
    "createBranch": true
  },
  "maxIterations": 12
}
```

规则：

- `transport`: `auto | mcp | github`。
- 缺省配置保持现有项目可读，不能让旧 `.c2c.json` 失效。
- `auto` 不猜测 ChatGPT 账号权限：
  - 用户明确说 Plus → 优先 GitHub。
  - 用户明确要求自定义连接器/MCP → MCP。
  - 无明确上下文时，Skill 根据 GitHub remote 给出推荐并只询问一次。
- GitHub 不可用时，V0.2 返回明确阻塞；不自动落入尚未实现的 FilePack。
- `c2c setup` 始终保留 MCP 旧语义；新的通用首次配置由 Skill + `c2c task start --transport ...` 完成。
- `.c2c.json` 只是项目默认配置。单次 task 的 `--transport` 是内存级覆盖，不修改配置文件，优先级高于项目默认值。
- `c2c transport set` 是显式持久化项目默认值的命令，会修改 `.c2c.json`；Skill 不在 task start 前调用它，避免自行制造 dirty workspace。

## 11. CLI 与 Skill UX

### 11.1 V0.2 CLI

保留全部旧命令，新增最小命令面：

```text
c2c transport get [-w <workspace>] [--json]
c2c transport set <auto|mcp|github> [-w <workspace>] [--json]

c2c task start <goal> [--transport <auto|mcp|github>] [-w <workspace>] [--json]
c2c task status [-w <workspace>] [--json]
c2c task import [--file <path>] [-w <workspace>] [--json]
c2c task publish [-w <workspace>] [--json]
c2c task resume [-w <workspace>] [--json]
```

`task import` 在未提供 `--file` 时从 stdin 读取，适合用户直接粘贴。它统一处理 PLAN / DONE / BLOCKED，不额外创建 `c2c plan` 和 `c2c done` 的重复命令。

命令实现放在 `src/cli/task.ts`；`src/cli/index.ts` 只注册，避免继续膨胀。

### 11.2 Plus Skill 流程

用户明确 Plus 时：

1. 运行 update check 和 sandbox allow（维持现有安装行为）。
2. 检查 Git repo、GitHub remote、工作区状态。
3. 直接运行 `c2c task start "<goal>" --transport github`；不修改 `.c2c.json`。
4. GitHub task start 自行完成 transport override、clean check 和 INIT publish。
5. 把短 PLAN 指令展示给用户，让用户发送到同一个 ChatGPT 对话。
6. 用户粘贴 PLAN 后调用 `c2c task import`。
7. Codex 执行、测试并调用 `c2c task publish`。
8. 输出 REVIEW 指令。
9. 用户粘贴 DONE 后导入，运行 final test，再发布 DONE。

Plus 模式不得自动打开 ChatGPT、输入 prompt、读取 DOM、抓取回答、访问 Cookie 或私有接口。

## 12. 导入异常与恢复策略

| 情况 | 行为 | 是否修改状态 |
| --- | --- | --- |
| 普通前后缀文字 | warning，继续解析 | 校验通过后修改 |
| 缺 `[C2C]` | warning | 校验通过后修改 |
| 缺 protocolVersion | 推断 v1，warning | 校验通过后修改 |
| 缺 iteration | 按当前状态唯一推断，warning | 校验通过后修改 |
| PLAN 缺核心 section | 返回模板和缺失项 | 否 |
| taskId 不匹配 | `TASK_ID_MISMATCH` | 否 |
| iteration 明确错误 | `ITERATION_MISMATCH` | 否 |
| 非法状态迁移 | `INVALID_TRANSITION` | 否 |
| task 已 DONE 又导入 PLAN | 拒绝，新目标需新 task | 否 |
| 导入 DONE | 记录 pendingDecision，要求 final validation | 保持 EXECUTED |
| final tests 失败 | 清除 pendingDecision，记录失败摘要 | 保持 EXECUTED |
| current.json 损坏 | BLOCKED，保留文件并报告 | 否 |
| current.md 被手改 | 从 JSON 重建投影 | JSON 不变 |
| push 失败 | 保留本地提交，提示重试 | 本地状态保留 |
| remote branch 冲突 | 校验 taskId；不一致则 BLOCKED | 否 |

解析失败输出必须包含：错误码、可读说明、当前期望状态和可复制的最小响应模板，避免用户来回猜格式。

### 12.1 BLOCKED 的可恢复状态

进入 BLOCKED 时必须持久化来源，不允许运行时猜测：

```json
{
  "state": "BLOCKED",
  "iteration": 2,
  "blockedFrom": {
    "state": "EXECUTED",
    "iteration": 2,
    "code": "CHATGPT_NEEDS_CONTEXT",
    "reason": "Review requires a missing product decision."
  }
}
```

恢复仅有两条合法路径：

1. `c2c task resume`：恢复到 `blockedFrom.state` / `blockedFrom.iteration` 并清除 blockedFrom。
2. 导入符合当前上下文的新 PLAN：进入下一轮 PLAN 并清除 blockedFrom。

如果 `blockedFrom` 缺失或 schema 无效，resume 返回 `BLOCKED_CONTEXT_MISSING`，不修改 current.json。

## 13. Plus 模式完整状态流

```text
User goal
    ↓
task start
    ↓
INIT(0) ── GitHub publish ──> branch + current.json/current.md
    ↓                               ↓
PLAN instruction               ChatGPT reads GitHub
    ↓                               ↓
User copies ChatGPT PLAN(1) <───────┘
    ↓
parse → validate → import
    ↓
PLAN(1) → EXECUTING(1)
    ↓
Codex edit / shell / tests / git
    ↓
EXECUTED(1) ── GitHub publish ──> CODE_HEAD + state projection
    ↓                                  ↓
REVIEW instruction                 ChatGPT reviews iterationBase..codeHead
                                   for declared paths; ignores .c2c/**
    ↓                                  ↓
User copies PLAN(2) or DONE(1) <───────┘
    ├── PLAN(2) → next execution loop
    └── DONE(1) decision → pendingDecision
                              ↓
                         final tests
                       ├── fail → remain EXECUTED
                       └── pass → DONE publish → summary
```

人工复制是 Plus 模式有意保留的决策闸门，不视为缺陷。

## 14. Backward compatibility

### 14.1 CLI

- 所有现有命令保留。
- 旧命令参数、默认值和 JSON 字段保持。
- `c2c setup` 仍是 MCP setup。
- `c2c status` 仍是 Bridge 状态；通用状态使用 `c2c task status`。
- `c2c record` 和 `session` 继续可用。

### 14.2 配置

- 旧 `.c2c.json`（仅 name/maxIterations）继续有效。
- 新字段均有默认值。
- 不执行破坏性配置迁移。

### 14.3 MCP 安全

- OAuth scopes、token TTL、pairing、loopback、sensitive policy 不降低。
- GitHubTransport 不复用 OAuth token 或 MCP URL。
- GitHub mode 不启动 Tunnel/Bridge，除非用户另行调用 MCP 命令。

### 14.4 文档与产品定位

README 更新为 Protocol-first，但仍保留 MCP 用户原安装和使用说明；不得把现有用户引导到 GitHub，除非其选择 Plus/GitHub 模式。

## 15. V0.2 明确不做

- 不实现 FilePackTransport。
- 不创建 FilePack 空类、空 CLI 或未使用配置。
- 不实现 PR 模式。
- 不依赖 `gh` CLI。
- 不自动 merge、force push、删除分支或修改 main/master。
- 不自动 stash 或提交用户已有脏改动。
- 不实现 GitHub API client；只使用本机 Git remote 和普通 push。
- 不实现完整 secret 内容扫描器。
- 不自动操作 ChatGPT 网页。
- 不访问 Cookie、Session Token、私有 API。
- 不自动抓取或解析网页 DOM。
- 不重写 Bridge、Tunnel、OAuth、Pairing。
- 不把 ChatGPT 原始长回复永久写入仓库。
- 不把源码、完整 diff 或日志复制进 `current.md`。

## 16. 文件变更规划

### 16.1 新增文件

| 文件 | 职责 |
| --- | --- |
| `src/protocol/types.ts` | 协议 schema、消息与 task 类型 |
| `src/protocol/parser.ts` | 容错文本解析与 diagnostics |
| `src/protocol/validator.ts` | 上下文校验、iteration 和状态迁移 |
| `src/protocol/serializer.ts` | 确定性消息输出 |
| `src/protocol/instructions.ts` | PLAN / REVIEW 指令生成 |
| `src/task/store.ts` | current.json 真源原子写入、task 最新副本与投影修复 |
| `src/task/projection.ts` | current.md 单向投影 |
| `src/task/lifecycle.ts` | task 状态机应用服务 |
| `src/transport/types.ts` | 最小 transport contract |
| `src/transport/select.ts` | 配置与 auto 选择 |
| `src/transport/mcp.ts` | MCP 兼容门面 |
| `src/transport/github.ts` | GitHub publish orchestration |
| `src/github/repository.ts` | Git 原语与 GitHub remote 解析 |
| `src/github/security.ts` | 变更归属与敏感路径检查 |
| `src/cli/task.ts` | 新 CLI 命令注册 |
| `tests/protocol.test.ts` | parse/validate/serialize/state tests |
| `tests/task-store.test.ts` | JSON 真源与 Markdown 投影 |
| `tests/transport-selection.test.ts` | transport config/selection |
| `tests/mcp-transport.test.ts` | 旧 MCP contract 兼容 |
| `tests/github-transport.test.ts` | branch/state/commit/push/security |
| `tests/plus-workflow.test.ts` | 本地 bare remote 的完整生命周期 |

### 16.2 修改文件

| 文件 | 修改目的 |
| --- | --- |
| `src/cli/index.ts` | 抽出 MCP 编排，注册 task CLI，保留旧 contract |
| `src/workspace/manager.ts` | 扩展并校验 ProjectConfig |
| `src/workspace/git.ts` | 保留只读 API；写 Git 能力放到 github/repository，不混入 MCP read API |
| `src/execution/records.ts` | 与 task execution summary 对齐但保持旧格式可读 |
| `skill/SKILL.md` | transport-first UX 与 Plus 人工闸门 |
| `docs/protocol.md` | transport-independent 协议规范 |
| `docs/architecture.md` | Multi-Transport 架构与两条数据通道 |
| `docs/security.md` | GitHub publish 威胁和限制 |
| `README.md` | 新产品定义、两种模式、兼容说明 |
| `README.zh-CN.md` | 中文同步 |
| `src/version.ts` / `package.json` | V0.2 版本一致性（实施末期） |

## 17. 测试迁移与实施顺序

实施严格遵循 TDD，每个 production 行为先有失败测试。

### Phase 0：建立基线

1. 固化当前 CLI JSON contract 测试。
2. 修复现有 Windows-only 测试基建问题，使安全测试在支持/不支持 symlink 的环境中给出明确结果，而非整套跳过。
3. 记录完整 baseline：build、typecheck、test。

### Phase 1：Protocol 解耦

1. parser red/green。
2. runtime schema 与 semantic validation red/green。
3. serializer round-trip red/green。
4. state transition / taskId / iteration red/green。
5. malformed input 和恢复模板。

### Phase 2：Transport 抽象与 MCP 封装

1. Transport contract tests。
2. MCP adapter contract tests。
3. CLI 旧命令委托到 MCPTransport。
4. 运行全量 MCP 回归；未恢复基线不得进入 Phase 3。

### Phase 3：Task store

1. snapshot schema。
2. current.json 单文件原子写入。
3. tasks/<id>.json 最新状态副本及不一致修复。
4. current.md 确定性投影、崩溃后检测与重建。

### Phase 4：GitHubTransport

1. GitHub remote 解析、missing remote、detached HEAD。
2. branch 创建与冲突恢复。
3. INIT 两文件生成、commit、bare remote push。
4. dirty workspace 和 unrelated changes 阻塞。
5. sensitive path 阻塞。
6. EXECUTED 两阶段提交与普通 push。
7. push failure 幂等恢复。
8. DONE decision 延迟生效、finalizeDone 与状态发布。

### Phase 5：CLI 与 Plus Skill

1. transport get/set。
2. task start/status/import/publish/resume。
3. PLAN/REVIEW 指令快照测试。
4. Skill 对 Plus 直接选择 GitHub；MCP 路径保持。
5. README / architecture / protocol / security 更新。

### Phase 6：自动化 E2E 与真实 Plus 验收

1. 本地自动化：临时工作仓库 + bare remote，完整模拟 INIT → PLAN import → execution → publish → DONE import → final tests。
2. 真实 GitHub：使用专用测试仓库或用户明确指定的安全仓库，创建真实 branch 并 push。
3. 真实 ChatGPT Plus：同一 ChatGPT 对话读取 GitHub branch，返回 PLAN，人工复制到 Codex。
4. Codex 执行一个最小、可验证改动并 push。
5. ChatGPT 重新读取 `current.md` 和 commit range，返回 DONE。
6. Codex 导入 DONE、运行 final test、发布 DONE snapshot。

## 18. 真实 Plus E2E 验收方法

E2E 必须使用一个允许测试提交和分支的真实 GitHub 仓库。不能在未获用户确认的正式仓库 main/master 上执行。

### 18.1 验收前置

- ChatGPT Plus 已连接并可读取目标 GitHub repository。
- 本机 Git 对目标 remote 有 branch push 权限。
- 目标 repo 工作区 clean。
- 使用可删除的测试 branch，不使用 main/master。
- 验收目标是最小改动，例如增加受测试覆盖的 health endpoint 或等价 fixture 功能。

### 18.2 验收步骤与证据

| 阶段 | 操作 | 必须保存的证据 |
| --- | --- | --- |
| INIT | `c2c task start` | taskId、branch、taskBaseCommit、push 成功 |
| GitHub publish | 检查远端 branch | `.c2c/current.json` 与 `.md` 可见 |
| PLAN | ChatGPT 读取仓库并输出 PLAN | 原始 PLAN 文本（不写入 repo） |
| Import | `c2c task import` | parse/validate 成功、taskId/iteration 匹配 |
| Execution | Codex 修改并测试 | changedFiles、测试命令、退出码 |
| Publish | `c2c task publish` | codeHead、state commit、push 成功 |
| Review | ChatGPT 按 iterationBase..codeHead + declared paths 检查 | DONE 或下一轮 PLAN 文本 |
| DONE decision | 导入 DONE | pendingDecision 写入，task 仍为 EXECUTED |
| Final test | 重跑完整测试 | 新鲜命令输出、0 failures |
| Finalize/publish | finalizeDone 后发布 | 远端 current.json state=DONE |

### 18.3 成功标准

以下全部满足才可声明 Plus 主路径成立：

- 没有 Developer Mode。
- 没有自定义 MCP Connector。
- 没有 API Key、Cookie、Session Token 或私有 API。
- ChatGPT 只通过其正常 GitHub 能力读取 branch。
- 用户只负责 PLAN / REVIEW 的可见复制闸门。
- taskId、iteration、state 全程由运行时校验。
- Codex 是唯一代码执行者。
- 远端 branch 可审计地包含状态投影和代码提交。
- final test 新鲜运行且无失败。
- 现有 MCP 回归保持基线。

## 19. Backward compatibility 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| 抽取 CLI 改变旧 JSON 输出 | 先写 contract tests，adapter 原样返回字段 |
| ProjectConfig schema 使旧配置失效 | 所有新字段可选并提供默认值 |
| Protocol iteration 与旧 Skill 文案不同 | v1 parser 允许缺省字段，文档和 Skill 同步升级 |
| MCP doctor 被通用 doctor 污染 | 保留 `c2c doctor` 旧语义，通用状态另设命令 |
| Git 写操作误带用户文件 | 显式 changedFiles、逐路径 stage、unrelated dirty BLOCKED |
| state commit 与 code head 混淆 | 两阶段提交；taskBase/iterationBase/codeHead + declared paths 明确 review 语义 |
| push 中断留下本地提交 | 幂等重试，不 reset、不 force push |
| current.md 被当作真源 | 程序只读 JSON，Markdown 每次从 JSON 重建 |
| Plus UI 或 GitHub 连接变化 | 人工闸门 + 普通 Git，不依赖网页 DOM 或私有 API |
| Windows 测试继续误报 | 单独修测试基建，不降低安全断言 |

## 20. 设计自审结论

- 无 FilePack 空壳或提前抽象。
- Protocol 具备实际 parse / validate / serialize 和状态机，不止类型声明。
- MCPTransport 只做兼容封装，Bridge/Tunnel/OAuth/Pairing 不重写。
- GitHub 逻辑位于 transport/github 与 github 原语层，不进入 Protocol、CLI 或 Skill 特判堆。
- JSON/Markdown 真源关系唯一且可恢复；只保证 JSON 单文件原子，投影可重建。
- commit 自引用与元数据混入问题通过两阶段提交、三 commit 语义和 declared path review 解决。
- 导入失败不改变 task 状态。
- DONE decision 延迟到 final tests 通过后才生效，不发生终态倒退。
- BLOCKED 精确持久化 blockedFrom，resume 不依赖猜测。
- 单次 transport override 不修改 `.c2c.json`，不会自行制造 dirty workspace。
- taskId 使用 8 hex，所有非删除 declared files 都执行 sensitive policy。
- E2E 明确需要真实 Plus、真实 GitHub branch 和新鲜 final test。
- V0.2 范围可拆成按阶段独立回归的实施计划。

本文件通过用户评审后，再转换为逐任务、逐测试、逐提交的实施计划；在评审前不进入生产代码修改。
