# Codex with ChatGPT

[English](README.md) | **简体中文** | [安装流程](#安装与配置)

> ChatGPT 负责思考，Codex 负责干活。

本项目把 ChatGPT 网页版作为本地 Codex 会话的优先研究、分析、规划、整理与审查伙伴。
凡是 ChatGPT 页面或只读 MCP 能完成的任务，默认优先交给 ChatGPT；Codex 始终掌握
工作区写入、命令执行、测试和 Git 操作。ChatGPT 通过 MCP 按需读取当前工作区，
也可以使用自身的联网搜索能力。当前对比模式由 Computer Use 从精确绑定的页面
回复中读取并校验精简的结构化结果。

### ChatGPT-first 分派

`CHATGPT_FIRST` 只适用于证据闭包的子任务：ChatGPT 页面或当前已授权工具必须能够
取得交付结论所需的全部输入，不能只根据“审查 PR”“检查后端”这样的任务名称分派。

- `RESEARCH`：联网检索、外部文档、资料比较和工作区只读发现。
- `PLAN`：架构、实现方案、迁移步骤、接口设计和文档整理。
- `REVIEW`：只审查当前工作区相对 `HEAD` 的未暂存/已暂存变更，以及同一
  本地会话、任务和迭代已经登记的执行记录。
- 本地 Codex 只执行文件修改、命令、测试、Git 和最终验证。

当前 Connector 不能读取任意 commit、分支、tag、PR Diff、父提交或历史源码快照，
也不能读取工作区外或敏感数据；ChatGPT 不能执行命令/测试、修改文件或 Git/PR、
部署服务、切换账号/权限，或宣称最终运行状态已经验证。混合任务由 Codex 先解析 ref、
收集并登记缺失证据；ChatGPT 只承担具备完整输入的研究、规划或审查；最后由 Codex
执行和验收。已知能力缺口不得为了得到可预期的 `BLOCKED` 而先行派发。

网页的 Web Search 是 ChatGPT 自身能力，不是 Connector 暴露的本地 MCP 工具；
搜索结果和其他分析结果统一由 Computer Use 从精确回复读取。为节省本地
上下文，控制消息只携带任务目标和关联字段，不复制仓库内容、Diff 或日志。

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

这是供用户自行部署的开源项目。每位用户在自己的电脑上安装，并使用自己的 OpenAI
账号、Tunnel 和密钥；公开 Git 仓库不代表共享维护者的电脑、Tunnel 或凭据。

当前使用 **OpenAI Secure MCP Tunnel**，不再部署本地 OAuth 服务或公网 MCP URL。
本地客户端主动通过 HTTPS 连接 OpenAI，不需要开放入站端口、配置公网域名或为
每个项目配置 OAuth。`Authentication: None` 只是不用连接器级 OAuth，不代表取消
Tunnel 认证或 C2C 的短期任务授权。本项目不调用模型 API，但仍需要用于认证传输的
**Tunnel runtime API key（运行密钥）**。

### 让 Codex 执行安装

首次安装使用 **Codex 桌面端的普通本地任务**，不要先调用 `$codex-with-chatgpt`：
此时 Skill 还没有安装，也不能依赖尚未连通的 ChatGPT 来安装它自己。可以先发给 Codex：

```text
请为当前系统用户安装 https://github.com/peak-xiong/codex-with-chatgpt 的 main 分支。
先阅读 README.zh-CN.md 的安装说明，检查操作系统、Git、Node.js、Corepack、
当前任务的内置浏览器能力，以及已有的 C2C 安装。
确认源码目录后再克隆和构建；保留已有修改、安装配置和会话，不覆盖或清理它们。
如果已有健康的 C2C 安装正在使用官方 Secure MCP Tunnel，通过
`machine setup --reuse-existing` 复用已安装的 Tunnel ID 和受保护运行密钥；不要
重建 Tunnel，也不要再次索要密钥。否则，完成前置检查和干净源码构建后暂停，指导我
创建自己的官方 Secure MCP Tunnel，并等待我提供 Tunnel ID 和私有运行密钥文件的
绝对路径。
不要猜测账号、组织、工作区、Tunnel ID 或凭据，不要查看、回显或上传密钥内容。
缺少权限或遇到登录、授权步骤时，说明需要我完成的操作；不要自行切换账号、
扩大权限，或改用公网 URL、OAuth、其他隧道方案。
```

下面第 1–6 步也是 Codex 应遵循的安装顺序。**Codex 已完成的本地命令不需要用户
再执行一遍**；命令块供 Codex 执行或用户核对。

| 操作 | 谁来完成 |
| --- | --- |
| 选择账号/组织/工作区，创建或选择云端 Tunnel，关联工作区 | 首次安装时由用户在 OpenAI 官方页面确认；缺少权限时联系管理员 |
| 获取运行密钥并存入私有文件，完成登录和授权 | 首次安装或轮换密钥时由用户操作；只把文件路径交给 Codex |
| 检查环境、构建源码、全局安装、诊断 | Codex 在本地执行，不在 ChatGPT 对话中执行 |
| 创建/复用 ChatGPT 连接器 | 用户在已确认的 ChatGPT 工作区中完成，随后由 Codex 验证 |

### 1. 检查前置条件

- Git、满足 Node.js >= 20 要求的受支持 Node.js LTS 版本，以及 Corepack。
  先运行 `node --version`、`git --version`、`corepack --version`。缺少 Corepack
  时，先安装适合当前 Node.js 版本的 Corepack；仓库的 `package.json` 已固定 pnpm 版本。
- Codex 桌面端，当前会话能够使用内置浏览器和 Computer Use。只安装命令行工具
  不会自动获得网页操作能力。
- ChatGPT 账号/工作区能够使用开发者模式的自定义应用和 Secure Tunnel。
  请在自己的账号中确认入口和管理员授权，不能仅凭订阅名称认定功能可用。
- 在目标 Platform 组织中创建/使用 Tunnel，并将其关联到目标 ChatGPT 工作区的权限。
- 电脑能够出站访问 `api.openai.com:443`，安装时还需访问 GitHub 和包仓库。
  ChatGPT 调用本地工具期间，电脑必须保持唤醒、联网，相关服务持续运行。

当前真实验证环境是 **macOS + Codex 桌面端**。代码包含其他平台目标，但 Windows/Linux
原生安装和完整浏览器流程尚未完成验收。下面命令使用 macOS/POSIX Shell 语法，不能
当作 PowerShell 命令直接执行。

账号、权限和网络要求以 [OpenAI Secure MCP Tunnel 官方文档](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
为准。官方 Tunnel 用于私有连接和开发者模式应用，**不满足公开插件商店的提交要求**。
“公开源码供别人自行部署”与“发布一个所有人都能直接安装的 ChatGPT 公共插件”是两件事。

### 2. 下载并构建干净的源码仓库

对于 [PR #409](https://github.com/XiaoDuoYa/codex-with-chatgpt/pull/409) 中的机器级方案预览，
下面个人 fork 的 `main` 已包含实现。不要假设其他仓库或分支也已包含它。使用
`git clone`，不要使用 Download ZIP；安装器要求从干净、已提交的 Git 版本构建。

```sh
git clone --branch main --single-branch https://github.com/peak-xiong/codex-with-chatgpt.git
cd codex-with-chatgpt
corepack pnpm install --frozen-lockfile
corepack pnpm build
node bin/c2c.js machine setup --help
git status --short
```

保留这个源码目录以便后续升级。安装前 `git status --short` 应无输出。已有修改时，
先妥善保存，或另外克隆一份干净源码；不要为通过安装检查而重置或删除自己的工作。

### 3. 创建自己的 Tunnel 并准备密钥文件（仅首次安装）

这一阶段在 OpenAI 官方页面完成，**不是本地 `machine setup` 的功能**。
如果前置检查已经确认存在由官方 Secure MCP Tunnel 支撑的健康 C2C 安装，则跳过本节。
升级时复用 C2C 已经保护保存的密钥，不重建 Tunnel，也不再次索要密钥。

1. 打开 [Platform 的 Tunnel 设置](https://platform.openai.com/settings/organization/tunnels)，
   确认当前账号和左上方/组织选择器中的目标组织。页面位置可能变化，应以实际 UI 为准。
   为这台电脑创建一个 Tunnel，名称可自行设置；已有本机专用 Tunnel 则复用。
   不要选用另一台电脑正在使用的 Tunnel。
2. 在该 Tunnel 的配置中关联之后使用连接器的 **ChatGPT 工作区**。不要把 Platform
   组织、Platform API Project 与 ChatGPT 工作区混为一谈；业务代码对应的 ChatGPT
   Project 则在后续配对时创建，不是在这里创建。
3. 保存配置后，记录页面返回的真实 `tunnel_id`，不要用显示名称、Project ID 或 URL
   代替。仅完成这一步还没有启动本地客户端，不能据此判断连接已经可用。
4. 按目标组织的凭据管理流程取得用于该 Tunnel 的 **runtime API key**。官方指南要求
   运行密钥，但没有规定所有账号都在 Tunnel 页面提供“生成运行密钥”按钮；不要假定
   创建 Tunnel 就会返回密钥。找不到入口或无法确认权限时，先请组织管理员确认。
5. 用可信编辑器或密钥管理器，把**密钥本身**保存到所有仓库之外的私有 UTF-8 文本文件。
   文件中不要包含 JSON、`export`、变量名或包裹密钥的引号。macOS 上可让 Codex
   只检查文件存在性并执行 `chmod 600 "/absolute/private/path/tunnel-runtime.key"`，
   无需通过 `cat` 等命令查看内容。安装器会在本地读取并私密保存该文件中的密钥。

权限属于 **Platform 组织级**：创建/编辑需要 Tunnels `Read + Manage`，运行客户端
和在 ChatGPT 选择 Tunnel 需要 `Read + Use`。只有 Platform Project 权限或 ChatGPT
开发者模式权限并不够。详见 [官方权限说明](https://developers.openai.com/api/docs/guides/rbac)。
缺少权限时停止安装并联系组织管理员，不要让 Codex 自动提升权限。

将原始密钥安全保存，供后续升级使用。不要放入命令行参数、聊天提示词、Project
指令、截图或 Git。不要复制维护者的密钥、Tunnel ID 或 ChatGPT Project URL。

后续示例都是占位值：将 `<YOUR_TUNNEL_ID>` 替换为自己的 Tunnel ID，将示例文件路径
替换为私有密钥文件的绝对路径。Tunnel ID 不是密钥，也不能用 ChatGPT 登录令牌替代
运行密钥。`Authentication: None` 也不能省略这个密钥。

### 4. 为当前系统用户全局安装一次

完成第 3 步后，在**同一个 Codex 安装任务**中回复下面内容，先替换两个占位值，
不要粘贴密钥正文：

```text
已确认目标账号、Platform 组织和 ChatGPT 工作区，并完成 Tunnel 的工作区关联。
Tunnel ID：<YOUR_TUNNEL_ID>
运行密钥文件（绝对路径）：/absolute/private/path/tunnel-runtime.key
请从刚才构建的干净源码目录执行 machine setup，为当前系统用户安装。
仅将密钥文件路径传给安装器，不要输出、上传或在聊天中展示文件内容。
然后检查全局 Skill、machine status 和 machine doctor --no-fix，报告实际结果。
本地安装完成后，等待我在 ChatGPT 创建或确认连接器，再进行工作区配对和回传验收。
```

Codex 应在第 2 步构建好的源码目录执行下面命令，不使用 `sudo`。首次安装时全局
`c2c` 可能不存在，必须使用源码入口。所有占位值须先替换；路径带空格时保留引号：

```sh
node bin/c2c.js machine setup \
  --tunnel-id "<YOUR_TUNNEL_ID>" \
  --runtime-key-file "/absolute/private/path/tunnel-runtime.key" --json
```

已有健康安装时，改用更新后源码入口的显式复用模式。该模式不会把密钥读入对话，
也不接受任意替换路径：

```sh
node bin/c2c.js machine setup --reuse-existing --json
```

没有有效机器配置时，`--reuse-existing` 会拒绝执行；它也不能和 `--tunnel-id`、
`--runtime-key-file` 同时使用。需要更换 Tunnel 或轮换密钥时，必须使用同时提供
两个显式参数的首次安装形式。

预期返回 `ok: true`、`configured: true`。安装器会部署经校验的运行时，安装全局
Skill 和 `c2c` 命令入口，安装本项目固定版本的官方 Tunnel 客户端，并启动唯一的
Tunnel 托管网关。首次安装形式会私密复制用户提供的密钥；复用模式保留已经保护保存的
密钥。**安装器不会创建云端 Tunnel、关联 ChatGPT 工作区，也不会在 ChatGPT 中创建
连接器**；首次安装时，前两项必须已在第 3 步完成。

官方通用教程中的 `tunnel-client init/run` 和示例 MCP 服务用于独立接入。
本项目由 `machine setup` 管理这些本地组件，**不要再并行执行那套示例**，也不要为
单个项目另外启动 `tunnel-client` 或 `serve-machine`。

命令入口位于 `~/.local/bin/c2c`。若终端找不到 `c2c`，在自己的 Shell 启动配置中
加入下面一行，再重新加载该 Shell：

```sh
export PATH="$HOME/.local/bin:$PATH"
```

也可以不改 PATH，直接执行 `"$HOME/.local/bin/c2c" machine status --json` 检查。

### 5. 在 ChatGPT 中连接一次

切换到预期的 ChatGPT 账号/工作区，按需开启开发者模式（当前入口为设置中的
Security and login，可能需管理员先授权）。打开 [ChatGPT 插件页](https://chatgpt.com/plugins)，
通过加号/创建入口新建开发者模式应用，配置如下。不同 UI 版本可能称其为应用、
插件或连接器。

| 字段 | 值 |
| --- | --- |
| 名称 | `Codex with ChatGPT` |
| Connection（连接方式） | `Tunnel` |
| OpenAI Secure Tunnel | 选择第 4 步配置的同一个 Tunnel |
| Authentication | `None` |

已有该连接器时直接复用，不重复创建。这里不需要公网 Server URL，运行密钥应留在
本机，不能填进这个表单。工具发现期间保持网关运行。列表中没有 Tunnel 时，先检查
ChatGPT 工作区关联和 Read + Use 权限。页面若支持手动输入 Tunnel ID，也必须填同一个
已关联且有权使用的真实 ID；手动输入不能绕过权限。没有 Tunnel 连接方式时停止并确认
账号功能/管理员设置，不改选公网 URL 或 OAuth。完成后通知 Codex“连接器已配置”，
再继续第 6 步；看到连接器卡片不等于回传验收已通过。

### 6. 先验证安装，再验证真实回传

从现在起使用全局命令：

```sh
c2c skill status --json
c2c machine status --json
c2c machine doctor --no-fix --json
```

预期 Skill 的 `installed`、`matches` 为 `true`，机器 `ready: true`，doctor
`ok: true`。这些检查不能证明 ChatGPT 已经能够回写结果。

在 Codex 桌面端打开实际要使用的项目，新建本地会话并提出：

```text
请使用 $codex-with-chatgpt 配对当前工作区，验证本地读取和结构化结果回传。
在本会话专属的 ChatGPT 对话中连续完成两轮只读问题，每轮都必须从精确关联的
页面回复中由 Computer Use 校验结构化标记。不要修改业务代码，也不要接受未关联的
页面文字。
```

Skill 会注册当前工作区，在首次配对时为它创建 ChatGPT Project，或者使用用户明确
认可的现有精确 Project URL，再验证本地会话专属的 Chat。已有权威绑定时直接复用。
控制问题使用 Chat 模式，且当前消息能调用这个连接器。若找不到 Skill，可重新打开
Codex 桌面端；已有会话需要重新读取新版 Skill，而不是逐项目重新安装。

验收分为三个独立层级：

| 层级 | 必须看到的证据 |
| --- | --- |
| 已安装并连接 | 全局 Skill 匹配、机器 ready、doctor 通过 |
| 本地读取可用 | BOOT 返回预期 workspace/project ID 和真实本地证据 |
| 回传可用 | Computer Use 校验精确 tab/chat/generation/response 和结构化结果标记 |

mailbox 回调代码和历史真实回传记录继续保留，供后续对比；生产 MCP 当前不注册
这些回调工具。只有经过精确页面关联和 schema 校验的结果标记才会被接受，普通页面
文字不能替代结果。详见 [当前验收边界](docs/issue-log.md#最新回传验收修复)。

### 在其他项目或会话中使用

“全局”指**当前系统用户和 Codex 配置下共用一份安装**，不是所有用户、电脑和
ChatGPT 账号自动共享。

| 范围 | 要做什么 |
| --- | --- |
| 当前机器/系统用户 | 一份运行时、Skill、Tunnel 和连接器 |
| 新工作区 | 首次注册并配对自己的 ChatGPT Project |
| 新本地会话 | 在该 Project 中绑定一个专属 Chat/页面 |
| 同一会话的后续任务 | 复用页面，只生成新的任务授权 |

在实际要让 ChatGPT 访问的项目根目录中执行：

```sh
cd /absolute/path/to/your-project
c2c machine workspace register --json
c2c workspace --json
```

Skill 会按需执行注册，上面的命令用于检查。不要在不包含 C2C 源码的业务项目中
运行 `node bin/c2c.js`。工作区命令按可信的当前目录确定目标，`-w` 不能选择其他路径。
其他项目不需要新的连接器、Tunnel 或复制 Skill；换电脑/系统用户则需各自配置。

### 安装位置与升级

macOS 默认位置如下，均属于当前系统用户：

| 项目 | 位置 |
| --- | --- |
| 命令入口 | `~/.local/bin/c2c` |
| 全局 Skill | `~/.codex/skills/codex-with-chatgpt/SKILL.md` |
| 托管运行时 | `~/Library/Application Support/codex-with-chatgpt/installation/current` |
| Git 项目状态 | `<git-common-dir>/codex-with-chatgpt` |
| 非 Git 项目状态 | `<workspace-root>/.codex-with-chatgpt` |

`CODEX_HOME` 可改变 Skill 的配置根目录。`C2C_STATE_DIR` 改变机器状态位置，不改变
已注册的仓库本地状态；通常无需设置。托管运行时不是 Git 源码目录，不要直接修改或
在其中 `git pull`。Gateway 管理受保护的结果箱和跨工作区页面索引；项目自身保存
路由、checkpoint 和执行记录。

升级前先让活动任务结束：安装可能重启共享网关，使旧授权失效。在最初克隆的干净
源码目录中执行：

```sh
cd /absolute/path/to/codex-with-chatgpt
git status --short
git pull --ff-only
corepack pnpm install --frozen-lockfile
corepack pnpm build
node bin/c2c.js machine setup --reuse-existing --json
c2c skill status --json
c2c machine doctor --no-fix --json
```

只有状态检查无输出时才继续。复用已安装的 Tunnel 和密钥，保留现有连接器；升级时
不需要原始密钥文件路径，也不必逐项目升级。只有主动更换 Tunnel 或轮换密钥时才使用
同时提供两个参数的首次安装形式。安装命令必须使用上述**更新后源码的入口**，不要改为
旧的全局 `c2c`，否则会复用它自身的旧运行时。重启后 Skill 取得新授权，既有
Project/Chat 映射仍保留。
`c2c update-check --json` 只检查更新，不执行安装；`checked: false` 也不能证明已是最新版。

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

### 常见安装问题

| 现象 | 先检查什么 |
| --- | --- |
| 找不到 `corepack` 或 `c2c` | 安装适合当前 Node.js 的 Corepack；检查第 4 步的入口和 PATH |
| 没有 `machine setup` 命令 | 检查仓库/分支并按第 2 步重新构建；旧 OAuth 版本是另一套架构 |
| `--reuse-existing` 提示没有配置或密钥 | 当前机器没有可复用的官方 Tunnel 配置；使用自己的 Tunnel ID 和私有密钥文件路径完成第 3–4 步 |
| 安装器要求干净 Git 源码 | 使用 Git 克隆并先保存自己的修改，不能用 ZIP 代替 |
| ChatGPT 中看不到 Tunnel | 检查账号/工作区、Tunnel 关联和 Read + Use 权限 |
| 机器未 ready | 执行 `c2c machine doctor --no-fix --json`，检查网络、密钥权限和唯一的托管客户端 |
| 能读文件但收不到结果 | 检查当前消息的回传工具可用性，不能宣称完整成功或绕过平台授权 |

受控修复和精确会话恢复详见 [故障排查](docs/troubleshooting.md)。

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
到 ChatGPT。ChatGPT 通过只读 MCP 工具读取数据，并在精确回复末尾输出
`C2C_HOST_OBSERVED_RESULT` 结构化标记。Computer Use 校验 tab、chat、generation、
response id、request id、阶段和 payload schema 后，Codex 才推进会话。

这是临时对比模式。mailbox 回调实现仍保留在源码中，但生产 MCP 不注册
`get_control_result_status`、`report_control_progress` 和 `submit_control_result`，
`control open` 也不会授予 `c2c.result.write`。

## 页面所有权

ChatGPT 操作使用内置浏览器。配置时 Skill 以 browser、surface、Project URL、
chat URL 和 `tabId` 精确认领页面。租约带有 generation 和 owner epoch；替换存活
页面必须提供精确的当前 generation，其他会话的页面不能被认领。

每个本地会话的处理顺序：

1. 执行 `c2c session get --json`，记录 `sessionIdentity.id`。
2. 读取该会话的 route 和 surface lease。
3. 只打开或返回该会话保存的 chat URL。
4. 每条控制提示都带上 `CONTEXT_ID` 和 `RESULT_REQUEST_ID`。
5. 等待精确的 Computer Use 结果完成后，才能发送下一条控制消息。

Computer Use 通过稳定 URL 和语义化 DOM/浏览器 API 驱动每个独立的内置浏览器
页面，并始终使用精确 `tabId`。正常操作不使用截图坐标点击；轮次结束后保留页面
为待机状态，不关闭或挪作其他会话用途。

`surface release` 只结束当前租约，并保留会话路由以便下次继续使用。只有在本地
Codex 会话被永久丢弃时，才执行
`c2c surface retire --local-session <id> --json`。退役会撤销该会话的 context、
结束活动控制请求，并删除页面绑定和 checkout 路由；工作区的 ChatGPT Project
绑定仍供其他会话和未来会话复用。

### 会话不可用时

Skill 检查精确标签页的语义状态，再交给 `c2c surface check` 判断。标签页关闭时
重新打开原 Chat；明确归档或不可用时，在原 Project 中创建新 Chat，不自动取消归档。
登录或授权需要用户操作；加载和生成中只等待，不重复发送。CLI 评估宿主观察，
本身不独立探测 ChatGPT 页面。

连接器元数据 Refresh 后，旧 Chat 可能不再提供该应用，但同一 Project 的新 Chat
仍可选择。Skill 会在旧 Chat 的应用选择器中使用真实键盘事件搜索完整名称，并等待
异步候选；推荐列表和页面里的普通文字都不算可用证据。只有旧 Chat 确认没有可选
连接器、且同一 Project 的新 Chat 入口搜索后出现可选连接器和可点击的内联标签，
才复用原物理标签页创建替代 Chat。证据不明确时保留原绑定并继续检查。

替换前先将已验证的 Computer Use 结果保存到本地 checkpoint。只有确认页面失败后，
才取消精确的 pending 请求。未收敛的
请求会阻止页面轮换。恢复保留任务进度，新页面通过 BOOT 后才能提交路由，旧
generation 不能继续写回。一次恢复只自动创建一个替代页面，不使用会话退役来恢复。
详见 [恢复协议](docs/protocol.md#page-recovery)。

默认使用页面当前模型。模型和推理强度元数据不会操作选择器，也不保证始终为最新
模型；明确指定模型时，必须在页面中选择并验证。

## 安全边界

- MCP 工作区工具全部只读；Computer Use 结果受活动请求、精确页面/回复身份和 schema 约束。
- 工作区路径会规范化并限制在注册根目录内，符号链接和目录穿越都会被拒绝。
- 能力令牌和活动租约均短时有效，并绑定会话、任务、轮次、阶段、压缩纪元、页面
  generation 与 scopes。
- 保留的 mailbox 完成栅栏在当前生产传输中停用，仅继续由测试覆盖以便后续对比。
- 机器生命周期记录同时校验 machine id、boot epoch、pid 和精确运行时数据，第二
  个进程不能悄悄成为网关。
- 运行时密钥、管理令牌和原始能力令牌只保存在受保护的机器状态中，普通 CLI 输出
  会隐去它们。

详细契约见 [docs/architecture.md](docs/architecture.md)、
[docs/protocol.md](docs/protocol.md)、[docs/security.md](docs/security.md)。

## 常用命令

```sh
c2c machine start
c2c machine status --json
c2c machine doctor --no-fix --json
c2c machine stop
c2c workspace --json
c2c surface get --local-session <session-id> --json
c2c session get --local-session <session-id> --json
c2c control status \
  --local-session <session-id> --request <id> --task <id> \
  --iteration <n> --phase <phase> --json
```

`machine stop` 会停止所有工作区共享的连接，请先等待活动任务结束。
下面源码检查命令应在 C2C 源码目录中执行：

```sh
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
```

## 许可证

MIT
