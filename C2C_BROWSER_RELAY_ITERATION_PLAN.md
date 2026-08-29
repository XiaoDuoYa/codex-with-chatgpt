# Codex with ChatGPT · Browser Relay V0.3 架构设计

状态：Proposal，等待评审后才进入实施计划与代码阶段  
前置版本：V0.2 Plus + GitHubTransport + Manual Relay  
核对基线：`codex/c2c-plus-v0.2`，HEAD `4e9da9f`  
核对日期：2026-08-29

## 0. 结论

V0.3 应把 Browser Relay 放在现有 instruction 输出与 protocol import 之间，作为可拔除的 Control Relay。它不能成为新的 Data Transport，也不能直接写 TaskStore、Git、`.c2c/current.json` 或任何任务状态。

当前仓库已经具备完整的 Protocol、Task Lifecycle、GitHubTransport、Instruction Builder、Manual Relay 命令链和一个最小 session URL 存储；这些都可以直接复用。当前仓库没有可执行的 ChatGPT browser adapter，`skill/SKILL.md` 只有操作说明。当前 Codex 宿主在本任务中只暴露页面 URL 上下文，没有可调用的输入、提交、等待和读取 ChatGPT 回复能力，因此不能把一个无法连接真实官方浏览器能力的 `browser.ts` 空壳当成完成。

推荐采用“宿主驱动、仓库裁决”的最小方案：

```text
GitHubTransport publish
        │
        ▼
Instruction Builder
        │
        ▼
Codex Skill / official browser capability   ← Control Relay driver
        │ raw visible reply text
        ▼
existing task import application service
        │
        ├── parseC2CMessage
        ├── validateImportedMessage
        └── TaskLifecycle.importMessage
```

仓库负责 relay 配置、选择、有限重试政策、session store、导入裁决和可测试契约；Codex Skill 只在官方 Computer Use 能力实际可用时完成页面操作。能力不可用或操作失败时，原 instruction 原样返回 Manual Relay，任务不进入 BLOCKED。

V0.3 只有在真实 Browser 成功 E2E 和真实 Manual fallback E2E 都通过后才能发布。在当前宿主没有可调用 Computer Use 接口的情况下，可以完成设计、纯逻辑和回归测试，但不能宣称 Browser Relay 成功路径已经成立。

## 1. 当前版本可直接复用的组件

| 现有组件 | 真实位置 | 当前能力 | V0.3 处理 |
| --- | --- | --- | --- |
| Protocol runtime | `src/protocol/types.ts`, `parser.ts`, `validator.ts`, `serializer.ts` | 解析 PLAN/DONE/BLOCKED，校验 taskId、iteration、state、必填 section | 原样复用，不新增 Browser 协议 |
| Task Lifecycle | `src/task/lifecycle.ts` | 唯一执行 PLAN、BLOCKED、pending DONE、finalize DONE 状态迁移 | 原样复用；Relay 无状态写权限 |
| TaskStore | `src/task/store.ts` | `.c2c/current.json` 机器真源，重建 Markdown 和 task 投影 | 原样复用；Relay 不直接调用 `write()` |
| Instruction Builder | `src/protocol/instructions.ts` | 根据 TaskSnapshot 和 TransportDescriptor 生成 PLAN/REVIEW instruction | 直接复用；只允许加强“从 GitHub 独立读取”的文案 |
| GitHubTransport | `src/transport/github.ts` | INIT、代码、EXECUTED、DONE 的显式路径提交和 push | 原样复用，不感知 relay kind |
| MCPTransport | `src/transport/mcp.ts` | 封装旧 Bridge/Tunnel/Pairing 路径 | 原样回归，不感知 relay kind |
| Transport selection | `src/transport/select.ts` | 在 `mcp` / `github` 中选择数据通道 | 原样保留；禁止加入 manual/browser |
| Manual import | `src/cli/task.ts` 的 `task import` | 从文件或 stdin 读取文本，经 parse/validate/lifecycle 导入 | 作为 Browser 和 Manual 的统一导入终点 |
| Session CLI | `src/cli/index.ts` 的 `session get/set/clear` | 按 workspaceId 保存一个 conversation URL 和最近 task/iteration/state | 提取成可测试 store，保持 CLI 兼容 |
| Plus E2E | `tests/plus-workflow.test.ts` 与 `artifacts/c2c-plus-v0.2-e2e-report.md` | 已验证 Manual Relay 的 INIT → DONE 事实链 | 保留为回归基线 |
| Skill UX | `skill/SKILL.md` | 已规定内置浏览器、单会话复用、手工发送/导入和安全边界 | 扩展为 auto/browser/manual，Browser 失败时展示同一 instruction |

当前基线测试实测为 22 个测试文件通过，138 项通过，2 项因 Windows symlink 能力跳过。

## 2. 原项目的 browser/session 能力还剩多少

### 2.1 Session：有持久化雏形，但尚未模块化和自动接入

`src/cli/index.ts` 已实现：

```ts
interface SavedSession {
  url: string;
  title?: string;
  taskId?: string;
  iteration?: number;
  lastState?: string;
  savedAt: string;
}
```

它按 `Workspace.id` 写入全局 C2C state directory 的 `sessions/<workspaceId>.json`，没有写入项目仓库，也没有保存 Cookie、Token 或 conversation 内容。`session get/set/clear` 已可用。

当前缺口：

- `SavedSession`、路径函数和读写逻辑私藏在大型 `src/cli/index.ts`，其他模块无法复用。
- 没有 Zod/运行时校验；损坏 JSON 会在 CLI 中直接抛错。
- `--url` 没有限制为 `https://chatgpt.com/c/...`。
- 没有 session 单元测试或 CLI 回归测试。
- `task start`、`task publish`、`task import` 不会自动更新 session 的 task/iteration/state。
- 当前工作区实测 `c2c session --json` 返回 `session: null`，说明 V0.2 真实 Plus E2E 没有形成持久化 conversation 映射。

因此，session 能力约等于“可用的安全本地记录格式和三个 CLI 动作”，不是完整 conversation manager。

### 2.2 Browser：只有 Skill 流程文字，没有仓库运行时

当前 `skill/SKILL.md` 已规定：

- 只使用 Codex 内置浏览器。
- 一个 workspace 复用一个 conversation。
- 新会话发送 Boot Prompt，失效时发送 HANDOFF。
- 只允许用户处理登录、验证码、2FA 和确认页面。
- 不读取 Cookie、Session Storage 或凭据。

但代码库中不存在：

- Browser/Computer Use capability detection。
- ChatGPT navigation、send、submit、wait、read 的可调用实现。
- 生成完成状态判断。
- response extraction。
- browser retry、protocol repair、session recovery 计数。
- browser failure → manual fallback 的运行时结果类型。
- 任何 browser/session 自动化测试。

当前 Codex 工具集只提供了环境附带的页面 URL 上下文，没有可调用的网页输入、点击、等待和读取回复工具。因此本轮宿主上的 Browser 成功 E2E 当前不可执行；这必须成为显式 release gate，而不能通过 Playwright、DOM scraping 或私有接口绕过。

## 3. Manual Relay 当前真实调用链

### 3.1 PLAN

```text
c2c task start
  → selectTransport(mcp | github)
  → GitHubTransport.prepare
  → TaskStore.write(INIT)
  → Git commit/push .c2c projections
  → buildPlanInstruction
  → CLI JSON 输出 instruction
  → Skill/用户把 instruction 发送给 ChatGPT
  → 用户保存或粘贴 ChatGPT PLAN
  → c2c task import --file 或 stdin
  → parseC2CMessage
  → TaskStore.read current snapshot
  → validateImportedMessage
  → TaskLifecycle.importMessage
  → TaskStore.write(PLAN)
```

### 3.2 REVIEW / DONE

```text
c2c task publish
  → TaskLifecycle.startExecution / completeExecution
  → GitHubTransport.publish
  → 显式代码 commit
  → EXECUTED metadata commit/push
  → buildReviewInstruction
  → CLI JSON 输出 instruction
  → Skill/用户发送给同一 ChatGPT conversation
  → 用户保存或粘贴 PLAN / DONE / BLOCKED
  → c2c task import
  → 同一 parse/validate/lifecycle 链
  → DONE 只记录 pendingDecision
  → Codex 运行 fresh final test
  → c2c task publish --finalize passed
  → GitHubTransport 发布最终 DONE
```

Manual Relay 当前不是一个 `ManualRelay` 类，而是“CLI 输出 instruction + Skill/用户搬运文本 + `task import`”的组合行为。V0.3 应先把这条行为定义为 Control Relay contract，再增加 Browser 实现，不改变它的可见输出和导入语义。

## 4. 方案比较

### 方案 A：宿主驱动的 Control Relay，仓库保留裁决与策略（推荐）

Codex Skill 调用官方 Browser/Computer Use；仓库提供 relay mode、session store、有限重试政策和统一 import service。Browser 获取的纯文本仍进入现有 Protocol。

优点：符合官方能力边界；不引入第三方浏览器依赖；Browser 可完全拔除；真实 Skill 路径可 E2E。缺点：Browser 操作本身只能在具备官方能力的 Codex 宿主验收，普通 Node 单测只能用 capability fixture 验证策略和边界。

### 方案 B：全部写在 Skill 中，不增加仓库 relay 模块

只修改 `skill/SKILL.md`，让 Codex 自己决定是否调用 Browser，然后继续调用现有 CLI。

优点：代码增量最小。缺点：relay selection、重试次数、session recovery 和 fallback 无法形成可靠运行时测试；规则容易在 Skill 文本里漂移；不满足本需求的测试强度。

### 方案 C：CLI 内置 Playwright/Selenium/私有 ChatGPT client

Node 进程自行登录、定位页面、抓取回复。

此方案明确拒绝。它违反 Proposal 的安全边界，增加凭据和 UI 逆向风险，并使 Browser 成为系统依赖。

最终选择方案 A。方案 B 只作为宿主动作层的一部分，不能单独承担所有策略；方案 C 不进入实施计划。

## 5. Browser Relay 最小插入点

唯一插入点是：

```text
task start/publish 返回 instruction
                 ↓
          Control Relay
                 ↓ raw text
             task import
```

不允许在以下位置插入：

- `GitHubTransport.prepare()` 或 `publish()` 内部。
- `TaskLifecycle` 状态迁移内部。
- `TaskStore.write()` 前后。
- `parseC2CMessage()` 内部。
- `TransportKind` 选择逻辑内部。

Browser Relay 输入必须只包含：workspace identity、taskId、instruction、expectedStates、可选 conversation URL 和受限次数预算。输出只能是可见回复文本或失败结果。Browser Relay 不接收源码、diff、测试日志、TaskStore 写句柄或 Git 对象。

## 6. Control Relay 最小契约与宿主边界

建议仓库定义：

```ts
export type RelayMode = "auto" | "manual" | "browser";
export type RelayKind = "manual" | "browser";

export type RelayFailureCode =
  | "BROWSER_UNAVAILABLE"
  | "NAVIGATION_FAILED"
  | "SESSION_NOT_FOUND"
  | "LOGIN_REQUIRED"
  | "RESPONSE_TIMEOUT"
  | "RESPONSE_MALFORMED"
  | "PROTOCOL_REPAIR_EXHAUSTED";

export interface RelayRequest {
  workspaceRoot: string;
  workspaceId: string;
  taskId: string;
  iteration: number;
  instruction: string;
  expectedStates: Array<"PLAN" | "DONE" | "BLOCKED">;
}

export type RelayResult =
  | { ok: true; kind: RelayKind; text: string; conversationUrl?: string }
  | {
      ok: false;
      kind: RelayKind;
      fallbackRequired: true;
      errorCode: RelayFailureCode;
      instruction: string;
    };
```

选择函数必须是纯函数：

```ts
selectRelay({ mode, browserAvailable }): "manual" | "browser"
```

规则：

| mode | browserAvailable | effective relay |
| --- | --- | --- |
| manual | 任意 | manual |
| browser | true | browser |
| browser | false | manual，并报告 fallback |
| auto | true | browser |
| auto | false | manual |

为了避免 CLI 与 Skill 各自复制选择和次数规则，`c2c relay get` 是唯一的策略读取入口：

```text
c2c relay get -w <workspace> --browser-capability <available|unavailable> --json
```

`--browser-capability` 是宿主在本次调用中报告的瞬时能力，不持久化。省略时按 `unavailable` 处理，安全降级。JSON 返回 requestedMode、effectiveKind、fallbackRequired、browserRetries、protocolRepairAttempts、sessionRecoveryAttempts 和 savedSession 摘要。`src/cli/relay.ts` 必须调用 `src/relay/select.ts` 与 `src/relay/policy.ts` 生成该结果；Skill 只执行返回结果，不自行复制判断规则。

`c2c relay set <auto|manual|browser>` 是唯一会持久化项目 relay 默认值的命令，只在用户明确调用时修改 `.c2c.json`。正常 Skill 流程不调用 `relay set`，因此不会为一次 task 制造 dirty workspace。

官方 Browser/Computer Use 是 Codex 宿主能力，不是当前 Node CLI 的 npm API。因此：

1. `src/relay/*` 只拥有类型、选择、次数预算和可测试的结果政策。
2. `skill/SKILL.md` 是生产 Browser driver 的宿主绑定，调用官方工具完成 open/send/wait/read。
3. 不创建不能连接真实官方能力的假 `src/relay/browser.ts`。只有宿主提供正式可调用接口时，才把该接口注入一个可执行 BrowserRelay adapter。
4. Unit test 使用 fake capability 驱动相同政策；真实 E2E 必须使用官方 Browser 能力，fake 不能替代 release gate。

这项收敛比 Proposal 中直接在 Node 中定义 `sendAndReceive()` 更符合当前真实宿主边界，也避免出现只在测试里能工作的空壳子系统。

## 7. Session 设计

把现有私有逻辑提取为 `src/session/store.ts`，不新建第二套会话系统。

建议运行时 schema：

```ts
const SavedSessionSchema = z.object({
  workspaceId: z.string().min(1),
  conversationUrl: z.string().url().refine(isAllowedChatGptConversationUrl),
  title: z.string().optional(),
  lastTaskId: TaskIdSchema.optional(),
  lastIteration: z.number().int().nonnegative().optional(),
  lastState: C2CStateSchema.optional(),
  savedAt: z.string().datetime(),
});
```

兼容读取现有 `{ url, taskId, iteration }` 格式，并在下次显式写入时升级。只允许：

```text
https://chatgpt.com/c/<conversation-id>
```

不得保存 Cookie、Token、页面 HTML、完整回复或 conversation dump。

新会话与恢复规则：

- 没有 session：创建一次新 conversation，发送现有 Boot Prompt，保存 URL。
- 已有 session：只复用该 URL，不为 task/iteration 新建会话。
- 404/已删除：最多恢复一次；创建新 conversation，发送最小 HANDOFF 并覆盖 URL。
- 第二次失败：立即 Manual Relay，不再创建新会话。
- retry/session recovery 计数属于单次 relay operation 的内存上下文，不写入 TaskSnapshot。

## 8. Protocol 接入与格式修复

Browser 层只返回纯文本。统一导入服务应从当前 `src/cli/task.ts` 中提取，但语义保持不变：

```text
raw text
  → parseC2CMessage
  → validateImportedMessage(current task expectation)
  → success 才调用 TaskLifecycle.importMessage
```

Manual 和 Browser 都调用同一个 import service。不得复制 parser/validator 逻辑到 relay 目录。

Protocol repair 只允许一次，并且发生在任何 lifecycle 写入之前：

```text
Browser response
  → parse/validate fails
  → 发送固定 repair instruction 一次
  → 第二个 response 再次 parse/validate
  → success：正常 import
  → failure：Manual fallback，TaskSnapshot 保持原值
```

wrong taskId、wrong iteration、非法 state 不应让 Browser 自动“猜测修正”；它们可使用同一次固定 repair 请求，仍失败后转 Manual。

## 9. 自动降级如何保证 task state 不受污染

采用“先取得并验证，后一次性导入”的边界：

1. Browser navigation/send/wait/read 全部发生在 `task import` 之前。
2. Browser 失败只产生 `RelayResult`，不持有 TaskStore 或 Lifecycle。
3. parse 或 validate 失败时不调用 `TaskLifecycle.importMessage()`。
4. protocol repair 也不写 TaskSnapshot。
5. fallback 使用原始 instruction，不重新 `task start` 或 `task publish`，因此不会重复 INIT、commit 或 push。
6. retry/recovery 计数写全局短期 operation state或只存内存，绝不写 `.c2c/current.json`。
7. session URL 更新写全局 C2C state directory，不进入目标 Git 仓库。
8. 浏览器失败代码不得映射成 C2C `BLOCKED`；只有 ChatGPT 返回并通过 Protocol 的 BLOCKED 才能改变任务状态。

测试必须在每个失败场景前后比较：

- `TaskStore.read()` 深度相等。
- `git status --porcelain` 相等。
- `git rev-parse HEAD` 相等。
- 返回的 manual instruction 与原 instruction 字节一致。

## 10. 文件影响清单

### 10.1 需要新增

| 文件 | 职责 |
| --- | --- |
| `src/relay/types.ts` | RelayMode/RelayKind/RelayRequest/RelayResult/错误代码与次数预算 |
| `src/relay/select.ts` | 纯函数选择 auto/manual/browser，不引用 TransportKind |
| `src/relay/policy.ts` | browser retry ≤ 2、repair ≤ 1、session recovery ≤ 1 的纯状态政策 |
| `src/session/store.ts` | 从 CLI 提取、校验并兼容迁移 workspace → conversation 持久化 |
| `src/task/import.ts` | 从 `task import` 提取统一 parse/validate/lifecycle application service |
| `src/cli/relay.ts` | 提供 `relay get/set`；get 接受宿主瞬时 capability 并复用选择/政策模块，不操作网页、不修改 task state |
| `tests/relay-selection.test.ts` | manual/browser/auto/capability unavailable 选择测试 |
| `tests/relay-policy.test.ts` | retry、repair、recovery 上限与 fallback 测试 |
| `tests/relay-cli.test.ts` | get/set、瞬时 capability、不隐式写配置和 JSON contract 测试 |
| `tests/relay-protocol-integration.test.ts` | Browser fixture 返回 PLAN/DONE/BLOCKED/错误上下文后的统一导入测试 |
| `tests/session-store.test.ts` | reuse/create/legacy migration/URL allowlist/corrupt file 测试 |
| `tests/session-cli.test.ts` | 现有 session get/set/clear JSON 和人类输出回归 |
| `artifacts/c2c-browser-relay-v0.3-e2e-report.md` | 完成两类真实 E2E 后写入的证据报告；不能通过预先创建文档代替执行 |

只有当 Codex 宿主提供正式可调用的 Browser capability API 时，才新增 `src/relay/browser.ts` 作为该 API 的薄适配器，并在同一任务内提供真实测试。当前不创建空文件。

### 10.2 需要修改

| 文件 | 最小修改 |
| --- | --- |
| `src/cli/index.ts` | session 命令委托 `SessionStore`；注册 relay CLI；其余旧命令不动 |
| `src/cli/task.ts` | `task import` 委托统一 import service；start/publish JSON 继续返回同一 instruction |
| `src/workspace/manager.ts` | `ProjectConfig` 增加可选 `relay.mode` 和有上限的配置字段；缺省 auto，不主动写 `.c2c.json` |
| `src/protocol/instructions.ts` | 只加强 REVIEW 必须读取 GitHub `.c2c/current.md/current.json` 和真实 review range；不改消息协议 |
| `skill/SKILL.md` | 实现宿主 Browser driver 流程、能力探测、单动作人工介入和字节一致 manual fallback |
| `README.md`, `README.zh-CN.md` | 描述 Browser 为可选 UX 层，明确失败自动手动化 |
| `docs/architecture.md` | 区分 Data Transport 与 Control Relay |
| `docs/security.md` | 固化 chatgpt.com allowlist、无凭据/无 DOM/private API 边界 |
| `docs/protocol.md` | 说明 Relay 不改变 Protocol；补固定 repair instruction |
| `docs/troubleshooting.md` | Browser failure 不阻塞 task，展示 manual fallback |
| `tests/docs-contract.test.ts` | 锁定 Skill、README 与安全边界文案 |
| `package.json`, `src/version.ts` | 仅在全部 release gate 通过后更新为 V0.3 |

### 10.3 明确不应修改

以下模块不属于 Browser Relay 实施面：

- `src/protocol/types.ts`
- `src/protocol/parser.ts`
- `src/protocol/validator.ts`
- `src/protocol/serializer.ts`
- `src/task/lifecycle.ts`
- `src/task/store.ts`
- `src/task/projection.ts`
- `src/transport/types.ts`
- `src/transport/select.ts`
- `src/transport/github.ts`
- `src/transport/mcp.ts`
- `src/github/**`
- `src/bridge/**`
- `src/auth/**`
- `src/pairing/**`
- `src/mcp/**`
- `src/tunnel/**`

若实施中必须修改这些文件，应先停止并重新评审架构；不能以“方便接 Browser”为由扩大 Data Transport 或 Protocol。

## 11. 测试设计

### 11.1 Relay selection

覆盖 manual、browser、auto、browser unavailable → manual；还要证明 relay mode 不改变 `transport` 字段和 `.c2c/current.json` schema。

### 11.2 Protocol integration

使用 fake host capability 返回纯文本，依次覆盖：

- 合法 PLAN → PLAN。
- 合法 DONE → 保持 EXECUTED + pendingDecision。
- 合法 BLOCKED → BLOCKED。
- malformed → repair 一次后成功。
- malformed 两次 → manual fallback、snapshot 不变。
- wrong taskId → repair/fallback、snapshot 不变。
- wrong iteration → repair/fallback、snapshot 不变。

这些测试必须调用真实 `parseC2CMessage`、`validateImportedMessage` 和统一 import service，不能 mock Protocol。

### 11.3 Browser failure

通过 capability fixture 模拟 unavailable、navigation failure、session 404、login required、timeout、malformed response。每个场景验证：

- 没有 lifecycle import。
- TaskSnapshot、HEAD 和 git status 不变。
- retry/recovery 不超过配置上限。
- fallback 返回原 instruction。
- login required 标记为人工介入，不尝试处理凭据。

### 11.4 Session

覆盖现有 URL 复用、首次创建后的保存、legacy JSON 迁移、一次恢复、第二次失败转 Manual、非 chatgpt.com URL 拒绝、损坏 JSON 的稳定错误。

### 11.5 Regression

每个阶段至少运行：

```powershell
corepack pnpm typecheck
corepack pnpm test
```

并保持现有以下测试不改语义：

- `tests/plus-workflow.test.ts`
- `tests/github-transport.test.ts`
- `tests/mcp-transport.test.ts`
- `tests/mcp-integration.test.ts`
- `tests/protocol-parser.test.ts`
- `tests/protocol-validation.test.ts`
- `tests/task-lifecycle.test.ts`
- `tests/task-cli.test.ts`

## 12. Browser 成功 E2E

前提：Codex 宿主必须实际提供官方 Browser/Computer Use 的 open/send/wait/read 能力；测试不允许安装 Playwright、Selenium、Puppeteer，也不允许私有接口。

建议复用一个用户明确授权的真实 GitHub 测试仓库，创建全新 `c2c/*` 分支和 taskId：

1. 记录初始 repo、branch、HEAD、clean status 和 relay mode=auto。
2. `c2c task start --transport github` 发布 INIT。
3. Skill 探测官方 browser capability，并把瞬时结果传给 `relay get`；CLI 返回唯一的 effective relay 和次数预算。
4. Browser 能力打开已保存 conversation；若无则创建一次、发送 Boot Prompt 并保存 URL。
5. 自动发送 PLAN instruction；用户不复制文本。
6. 等待官方“生成结束/输入框可提交”状态，读取可见回复。
7. 通过统一 import service 导入 PLAN，记录 taskId/iteration 校验成功。
8. Codex 按 PLAN 实施和测试，`task publish` 发布 EXECUTED。
9. Browser 在同一 conversation 自动发送 REVIEW instruction。
10. ChatGPT 从 GitHub 独立读取 `.c2c/current.md/current.json` 和声明的 commit range，返回 DONE。
11. 自动读取并导入 DONE，确认 pendingDecision。
12. Codex 运行 fresh final test，finalize/publish DONE。
13. 验证远端 current.json 为 DONE、pendingDecision cleared、remote HEAD 正确。
14. 验证全过程没有用户复制 PLAN/DONE，没有源码/diff/log 进入 Browser Relay。

必须留存：taskId、repository、branch、各状态 commit、测试命令和结果、session reuse 证明、Browser 操作开始/完成/错误代码时间线。不得留存 Cookie、Token、页面 HTML 或完整 conversation dump。

## 13. Manual fallback E2E

在同一套 V0.3 代码上，新建另一个 task，使用 `relay.mode=auto`，由宿主测试夹具或官方能力开关明确报告 `browserAvailable=false`；不得通过破坏用户浏览器配置制造故障。

1. `task start` 正常发布 INIT。
2. Browser Relay 返回 `BROWSER_UNAVAILABLE`。
3. 比较失败前后 TaskSnapshot、HEAD 和 git status，必须完全一致。
4. Skill 输出固定 fallback 文案和原始完整 instruction。
5. 用户手工把 instruction 发送给 ChatGPT，并把 PLAN 返回 Codex。
6. 继续真实 `task import → execution → publish`。
7. REVIEW 阶段再次可选择强制 unavailable，确认仍回到同一 Manual Relay。
8. 用户手工返回 DONE，Codex fresh test 后发布 DONE。
9. 验证最终远端状态 DONE，且 Browser failure 从未转成 C2C BLOCKED。

当前宿主没有可调用 Browser 控制能力，因此已经满足“可构造 unavailable”的前置条件，但只有完成一次真实人工续接至 DONE 才能作为 fallback E2E 证据。它不能替代成功路径 E2E。

## 14. 实施阶段与评审门

### Phase 0：真实能力核对

本设计文档即 Phase 0 交付物。评审通过前不写实现代码。

### Phase 1：Manual Relay 经新策略入口回归

提取 SessionStore 和 task import service；增加 relay mode/selection/policy；现有 Manual Relay 的 instruction 和 task 状态行为必须保持不变。

### Phase 2：Browser host binding

只有确认宿主存在官方可调用能力后，更新 Skill 并接入 open/send/wait/read。若能力不存在，auto 只能选择 manual，V0.3 不能宣称 Browser 完成。

### Phase 3：Protocol 集成

Browser 纯文本走统一 import service；验证 Browser 无状态权限。

### Phase 4：Session reuse

迁移现有 session CLI 到 SessionStore，接入同一 workspace conversation。

### Phase 5：有限恢复

固定 browserRetries ≤ 2、protocolRepairAttempts ≤ 1、sessionRecoveryAttempts ≤ 1；超限转 Manual。

### Phase 6：Skill UX 与文档

正常路径只展示产品状态；失败只展示一次 manual fallback 和完整 instruction。

### Phase 7：两类真实 E2E

先成功 Browser E2E，再故障 fallback E2E。两者任一缺失，版本保持 Proposal/预发布状态，不更新为正式 V0.3。

## 15. V0.3 明确不做

- 不新增第三种 Data Transport。
- 不修改 Protocol state 或 TaskSnapshot schema 来记录 browser 状态。
- 不实现 FilePackTransport。
- 不实现 ChatGPT API/client、Cookie/session token 管理。
- 不使用 DOM selector、页面源码、localStorage/sessionStorage。
- 不安装或调用 Playwright、Selenium、Puppeteer。
- 不自动操作 GitHub、Cloudflare 或其他网站。
- 不把普通测试失败发给 ChatGPT。
- 不做无限 protocol repair、browser retry 或 conversation recovery。
- 不以 mock Browser 测试替代真实 Browser E2E。

## 16. Release Gate

只有以下全部满足才允许标记 V0.3：

- RelayKind 没有进入 TransportKind。
- Protocol、Task Lifecycle、TaskStore、GitHubTransport 无 Browser 特判。
- Browser 只发送 instruction、只读取可见 C2C 文本。
- Browser failure 前后 task snapshot 和 Git 状态不变。
- Manual Relay 的 CLI JSON、instruction 和 import 语义保持兼容。
- session 仅保存允许的 ChatGPT conversation URL 和最小进度元数据。
- browser retry ≤ 2、protocol repair ≤ 1、session recovery ≤ 1。
- 全部现有回归测试通过。
- 新增 relay/session/protocol integration 测试通过。
- 真实 Browser E2E 完成，用户没有复制 PLAN/DONE。
- 真实 fallback E2E 完成，最终任务仍为 DONE。
- 没有 Cookie、Token、DOM scraping、私有 API 或第三方浏览器依赖。

架构最终不变量：

```text
Protocol 失败 → C2C 失败
GitHubTransport 失败 → Plus 数据通道失败
Browser Relay 失败 → 只失去自动复制粘贴 → Manual Relay 继续
```
