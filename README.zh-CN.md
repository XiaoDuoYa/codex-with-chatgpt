# Codex with ChatGPT

[English](README.md) | **简体中文**

> ChatGPT 负责思考，Codex 负责干活。

本项目把 ChatGPT 网页版作为本地 Codex 会话的规划与审查伙伴。Codex 始终掌握
工作区写入、命令执行、测试和 Git 操作；ChatGPT 通过 MCP 按需读取当前工作区，
再把结构化建议写回受保护的机器结果箱。

## 机器级一次配置

连接按机器配置一次：

- 只创建一个名为 **`Codex with ChatGPT`** 的连接器。
- 连接器的 **Authentication 必须是 `None`**。官方 OpenAI Secure MCP Tunnel
  提供连接认证，连接器不保存某个项目的凭据。
- Tunnel 独占并托管一个 `serve-machine --stdio` 子进程。这个子进程是机器上
  唯一的 MCP 网关，可以服务所有已注册工作区。
- 一个工作区对应一个 ChatGPT Project；一个本地 Codex 会话对应该 Project
  内一个持久 ChatGPT 对话/页面。
- 浏览器操作始终使用已认领的精确 `tabId`，不会因为某个页面恰好在前台就误发
  消息。
- 机器级最多同时持有 100 个未过期的会话/页面租约，按唯一的
  `(projectId, localSessionId)` 身份计数，每个身份对应一个工作区内的本地会话所有者。
  租约释放、过期或会话退役后会释放容量；最多 100 个
  独立会话可以并行运行。新的第 101 个会话认领会收到可重试的容量拒绝，必须等待、
  退避并在容量释放后重试。同一会话续租、幂等认领或换页都会复用原名额，不会增加
  计数。只有同一本地会话内部的轮次串行，因为一个对话需要保持顺序。

因此不会抢占用户普通的 ChatGPT 对话。C2C 只拥有本地会话记录的页面，不会接管
其他标签页。

## 安装与配置

环境要求：Node.js 20 或更高版本、Git，以及支持连接器的 ChatGPT 账号。安装并
构建仓库：

```sh
corepack pnpm install
corepack pnpm build
```

创建或复用一个 OpenAI Secure MCP Tunnel，然后运行：

```sh
node bin/c2c.js machine setup \
  --tunnel-id <OPENAI_TUNNEL_ID> \
  --runtime-key-file <RUNTIME_KEY_FILE>
```

`machine setup` 会自动安装或更新唯一的全局 Skill，不需要为每个工作区重复安装。
可随时运行 `c2c skill status --json` 验证安装状态。

在 ChatGPT 的连接器设置中只创建以下连接器：

| 字段 | 值 |
| --- | --- |
| 名称 | `Codex with ChatGPT` |
| OpenAI Secure Tunnel | 选择 `machine setup` 配置的 Tunnel |
| Authentication | `None` |

ChatGPT 会选择已经配置的 Secure Tunnel；没有需要复制或粘贴到连接器中的公网
Server URL。

运行时密钥会复制到机器状态目录，绝不打印或提交到 Git。Tunnel 会托管网关，因而
不要为某个工作区另起一个 MCP 网关。

请在工作区根目录中运行。工作区命令根据当前 `cwd` 确定目标；即使传入
`-w` 也只能指向同一个目录，不能用它选择其他路径。需要时注册当前工作区：

```sh
node bin/c2c.js machine workspace register --json
node bin/c2c.js machine status --json
node bin/c2c.js machine doctor --no-fix --json
```

每个工作区流程开始时，先检查更新并清理旧版全局沙箱写权限：

```sh
node bin/c2c.js update-check -w <workspace-root> --json
node bin/c2c.js sandbox-clean --json
```

项目可变状态始终位于仓库自身边界内：Git checkout 使用
`<git-common-dir>/codex-with-chatgpt`，非 Git 工作区使用
`<workspace-root>/.codex-with-chatgpt`。项目元数据由链接 worktree 共享；会话路由和
执行记录按 `workspaces/<workspaceId>/` 隔离。结果箱以及跨工作区的 Project URL、
物理 tab 与 generation 权威索引由 Gateway 保存在受保护的机器状态中；C2C checkout
也不在工作区边界内。

Skill 会在内置 ChatGPT 浏览器中完成 Project 和会话页面配置：机器已有该工作区的
Project URL 时直接复用，否则才要求创建一个 Project。每个本地 Codex 会话会在该
Project 中新建一个 ChatGPT 对话并独占一个页面。

### macOS 登录后自动启动（可选）

首次完成机器配置后，在 macOS 上只需启用一次机器级 LaunchAgent，并确认状态：

```sh
c2c autostart enable --json
c2c autostart status --json
```

LaunchAgent 会隐藏运行 `c2c autostart run --quiet`。这个命令只调用
`ensureMachineGateway`，复用官方 Tunnel 已托管的子进程，不会为工作区创建第二个
网关或第二个 Tunnel。关闭自动启动：

```sh
c2c autostart disable --json
```

自动启动只是机器级保活机制，不是页面调度器，也不会改变机器级 100 个活动会话/页面
租约的容量。

## 运行结构

```text
ChatGPT Project A                 ChatGPT Project B
  会话 A1 -> 页面 A1                 会话 B1 -> 页面 B1
  会话 A2 -> 页面 A2                 会话 B2 -> 页面 B2
            \                         /
             \                       /
              一个全局连接器（Authentication: None）
                              |
                官方 OpenAI Secure MCP Tunnel
                              |
               Tunnel 托管 node ... serve-machine --stdio
                              |
          机器网关：工作区注册表 + 能力令牌代理 + 结果箱
                              |
                       可信本地工作区
```

Skill 根据可信的本地 `cwd` 确定工作区。网关为工作区分配稳定的 `projectId`、
checkout-specific 的 `workspaceId` 和 `registrationId`，并把注册信息保存在机器
注册表中。Project 与对话 URL 只用于导航和记忆，不是文件系统授权边界。

每个控制轮次都会获得一个短时 `CONTEXT_ID`，绑定：

```text
machine boot + workspaceId + projectId + registrationId
localSessionId + taskId + iteration + phase
requestId（非 BOOT 必填，BOOT 不包含）
compactionEpoch + 页面 generation + 请求的 scopes
```

ChatGPT 必须在每一次 MCP 调用中传入 `context_id`。网关验证能力令牌、取得活动
租约，在长调用期间续租，并在调用结束后释放租约。令牌过期、取消、页面轮换、
上下文压缩或网关重启都会让旧令牌失效。

## 控制流程

正常状态流转为：

```text
RESEARCH -> INIT -> PLAN -> EXECUTED -> REVIEW -> DONE
```

Codex 只向精确认领的对话发送很短的控制消息，绝不把文件内容、diff 或日志粘贴
到 ChatGPT。ChatGPT 通过 MCP 读取数据，并把结构化结果写到受保护的机器结果箱：

- `report_control_progress` 只能报告向前推进的进度。
- `submit_control_result` 只能为一个精确的 `RESULT_REQUEST_ID` 和关联元组提交
  一次结果。
- Codex 等待该请求、确认结果，然后才推进会话。

受保护的机器结果箱是唯一结果传输方式。页面中可见的回复不能作为结果，
即使它是该会话中的最新消息也不例外。

## 页面所有权

ChatGPT 操作使用内置浏览器。配置时 Skill 以 browser、surface、Project URL、
chat URL 和 `tabId` 精确认领页面。租约带有 generation 和 owner epoch；替换存活
页面必须提供精确的当前 generation，其他会话的页面不能被认领。

每个本地会话的处理顺序：

1. 执行 `c2c session get --json`，记录 `sessionIdentity.id`。
2. 读取该会话的 route 和 surface lease。
3. 只打开或返回该会话保存的 chat URL。
4. 每条控制提示都带上 `CONTEXT_ID` 和 `RESULT_REQUEST_ID`。
5. 等待精确的结果箱请求完成后，才能发送下一条控制消息。

Computer Use 通过稳定 URL 和语义化 DOM/浏览器 API 驱动每个独立的内置浏览器
页面，并始终使用精确 `tabId`。正常操作不使用截图坐标点击；轮次结束后保留页面
为待机状态，不关闭或挪作其他会话用途。

`surface release` 只结束当前租约，并保留会话路由以便下次继续使用。只有在本地
Codex 会话被永久丢弃时，才执行
`c2c surface retire --local-session <id> --json`。退役会撤销该会话的 context、
结束活动结果箱请求，并删除页面绑定和 checkout 路由；工作区的 ChatGPT Project
绑定仍供其他会话和未来会话复用。

## 安全边界

- MCP 工作区工具全部只读；结果写入同时受活动请求和能力令牌约束。
- 工作区路径会规范化并限制在注册根目录内，符号链接和目录穿越都会被拒绝。
- 能力令牌和活动租约均短时有效，并绑定会话、任务、轮次、阶段、压缩纪元、页面
  generation 与 scopes。
- 完成栅栏会先排空活动租约；结果箱写入失败时不会错误地标记完成，可以重试。
- 机器生命周期记录同时校验 machine id、boot epoch、pid 和精确运行时数据，第二
  个进程不能悄悄成为网关。
- 运行时密钥、管理令牌和原始能力令牌只保存在受保护的机器状态中，普通 CLI 输出
  会隐去它们。

详细契约见 [docs/architecture.md](docs/architecture.md)、
[docs/protocol.md](docs/protocol.md)、[docs/security.md](docs/security.md)。

## 常用命令

```sh
node bin/c2c.js machine start
node bin/c2c.js machine status --json
node bin/c2c.js machine doctor --no-fix --json
node bin/c2c.js machine stop
node bin/c2c.js workspace --json
node bin/c2c.js surface --json
node bin/c2c.js session --json
node bin/c2c.js control status \
  --request <id> --task <id> --iteration <n> --phase <phase> --json
```

检查命令：

```sh
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
```

## 许可证

MIT
