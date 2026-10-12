# Windows CMD 下 setup 固定域名问题分析与改进方案

日期：2026-10-10。分析对象：当前仓库源码（package.json 版本 0.1.3）。

第 1—8 节记录初次分析时的源码行为及设计建议。当时尚未安装依赖或构建，也没有进行 Cloudflare 远端操作。后续现场定位、已实现功能与真实验证记录见第 9 节；建议参数中仅 `setup --domain` 在此次修复中落地，其余参数仍为设计建议。

## 1. 结论

**已经运行 cloudflared 登录并获得 cert.pem，并不意味着 c2c setup 会使用自有域名。主因是 setup 没有域名参数，也不负责创建固定域名配置；它只使用当前工作区已经保存的连接选择。**

调用链如下：

```text
c2c setup
  → ensureBridgeAndTunnel(workspace)
  → ensureBridge(workspace)：复用已有进程，或启动新进程
  → 新 Bridge 的 tunnelForWorkspace(workspaceId)
  → 读取 C2C tunnels/<workspaceId>.json
      有 named + tunnelName + hostname → CloudflaredNamedTunnel
      否则 → CloudflaredQuickTunnel（临时地址）
```

该分支没有检查 cert.pem，也没有从 Cloudflare 获取域名。因而即使证书路径完全正确，首次直接执行 setup 仍会选择临时地址。此前已经选用 quick、或者固定域名配置失败后被写成 quick 的工作区，也会继续使用临时地址。

现有自动化入口在 `skill/SKILL.md` 的 “Connection choice” 部分，会在 setup 之前执行 `c2c tunnel choose --mode named --zone <domain>`。直接在 CMD 输入 setup 不会执行这段 Skill 流程；CLI 自身并没有实现同样的配置步骤。这解释了手动命令与自动化使用方式的行为差异。

## 2. 已确认的代码问题

以下位置均为仓库相对路径，可按函数名定位。

| 位置 | 当前行为 | 对用户的影响 |
| --- | --- | --- |
| `src/cli/index.ts`：setup 命令 | 只有 workspace、no-tunnel、json 参数；直接调用 ensureBridgeAndTunnel | 无法通过 setup 告诉程序目标域名，登录证书不会触发 named 配置 |
| `src/bridge/server.ts`：tunnelForWorkspace | 只依据工作区保存的 namedTunnelBinding 选择提供器 | 未保存 named 配置时必然选择 quick |
| `src/tunnel/named-provision.ts`：fallbackState | 登录、域名或配置失败时写入 quick，并返回 `ok: true, fallback: true` | 固定域名失败被降级为“成功使用临时地址”，原有 named 状态也可能被覆盖 |
| `src/cli/index.ts`：tunnel choose | 输出中硬编码 `ok: true`；普通文本只显示通用降级提示 | 错误原因在 JSON 的 error 中，普通 CMD 输出无法直接看到真正原因 |
| `src/tunnel/named-provision.ts`：isBenignRouteError、routeDns | 包含 `already exists`、`duplicate` 等文本就视为成功 | 已有 A/AAAA/CNAME 记录冲突也可能被误报成功，域名实际未指向此隧道 |
| 同文件：createTunnel | 找到同名远端隧道后直接复用；解析到 UUID 就返回，未先要求创建命令成功退出 | 远端存在不代表本地有对应运行凭据；失败输出中的 UUID 也可能被误认为创建成功 |
| 同文件：provisionNamedTunnel | 创建和 DNS 路由后直接写 named，未检查 `<UUID>.json` | “配置就绪”后仍可能无法启动隧道 |
| `src/tunnel/state.ts`：isNamedTunnelReady | 只检查 named、名称、hostname；不检查 tunnelId 或凭据 | 表示“有 named 配置”，并不表示可运行或公网可达 |
| `src/tunnel/cloudflared-named.ts`：start | 用 tunnelName 启动；依赖环境变量及 cloudflared 默认配置，未显式传入凭据文件和独立配置 | 用户全局 config.yml、环境变量或同名隧道可能影响实际运行 |
| 同文件：start；`src/cli/index.ts`：setup | 看到 registered tunnel connection 即认为成功；setup 不验证目标域名的公网 health | 隧道连上 Cloudflare，并不证明目标域名路由正确 |
| `src/process/daemon.ts`：ensureBridge | 健康进程直接复用；启动时继承当时的环境 | 之后在 CMD 中修改变量，不会更新已运行 Bridge 的环境；仅改磁盘配置也不会更换其提供器 |

现有 `tests/tunnel.test.ts` 甚至断言“record already exists”属于成功，并测试 named 配置失败后自动写 quick。这些测试描述了当前行为，不能当作固定域名可靠性的证明。

## 3. Windows 凭据与环境：哪些是事实，哪些需要现场确认

### 3.1 两种凭据承担不同职责

Cloudflare 官方文档区分：`cloudflared tunnel login` 生成账号证书 cert.pem，用于管理隧道和 DNS；`cloudflared tunnel create <NAME>` 生成对应隧道的 JSON 凭据，用于运行该隧道。Windows 默认目录为 `%USERPROFILE%\.cloudflared`。账号证书不能替代某个隧道的 JSON 凭据。见 [Cloudflare：本地隧道术语与默认目录](https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/local-tunnel-terms/)。

项目使用 `os.homedir()` 拼接 `.cloudflared/cert.pem`，支持 `TUNNEL_ORIGIN_CERT` 覆盖；凭据路径支持 `TUNNEL_CRED_FILE`。因此当前代码并非简单地“在 Windows 只查 HOME，忽略 USERPROFILE”。证书已下载却仍被判缺失，可能是登录与 c2c 使用了不同用户、文件存储在非默认目录，或者覆盖变量指向错误位置，不能在没有现场证据时认定是哪一种。

另一个需要修正的点：`inspectNamedTunnelCredentials()` 先要求账号证书存在。将运行切换成 UUID + 明确 JSON 凭据后，应将“管理权限”和“运行凭据”分开诊断；运行已有隧道通常不需要账号证书，修改 DNS 时才需要管理授权。

### 3.2 CMD 的变量与可执行文件

CMD 中应使用 `set "NAME=value"`，而不是 PowerShell 的 `$env:NAME=...` 或 Unix 的 `export NAME=...`；CMD 也不会把 `~` 展开为用户目录。路径中有空格时需要引用，但环境变量值自身不要额外存入双引号。

`findBinary("cloudflared")` 优先检查 `C2C_CLOUDFLARED_PATH`，否则查找 `cloudflared.exe` 及少数常见目录。若用户下载的是 `cloudflared-windows-amd64.exe` 并直接用该文件名完成登录，C2C 不一定能发现它；可以用绝对路径覆盖。若 CMD 通过 doskey 别名或包装脚本运行工具，Node 的直接 spawn 也不会执行该别名。

环境变量只会传给之后启动的子进程；已有 Bridge 的环境不会随当前 CMD 更新。修改工具或凭据路径后应停止当前工作区 Bridge，再重新 setup。

### 3.3 登录不等于目标域名可管理

目标域名仍需具备有效的 Cloudflare DNS 配置和相应账号权限。登录过另一个账号、授权了错误的站点，或者目标主机名已有冲突 DNS 记录，都可能导致 route dns 失败。官方说明 `route dns` 创建指向 `<UUID>.cfargotunnel.com` 的 CNAME，参见 [Cloudflare：创建本地管理隧道](https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/create-local-tunnel/)。

## 4. 当前版本可用的 CMD 排查与配置方式

以下命令供用户在自己的 CMD 执行；本次分析没有实际执行这些有远端副作用的命令。

先在项目目录检查程序位置、证书是否存在和工作区连接选择：

```bat
where c2c
where cloudflared
cloudflared --version
node -p "require('node:os').homedir()"
if exist "%USERPROFILE%\.cloudflared\cert.pem" (echo cert.pem exists) else (echo cert.pem missing)
c2c tunnel status --json
```

若工具或证书在非默认目录，使用实际绝对路径，例如：

```bat
set "C2C_CLOUDFLARED_PATH=C:\Tools\cloudflared-windows-amd64.exe"
set "TUNNEL_ORIGIN_CERT=%USERPROFILE%\.cloudflared\cert.pem"
"%C2C_CLOUDFLARED_PATH%" tunnel list --output json
```

能够列出隧道说明这次管理命令至少可以使用账号证书；仍不能证明目标域名的 DNS 权限或某个隧道的 JSON 凭据有效。

当前版本支持通过两条命令配置**指定完整主机名**：

```bat
c2c tunnel choose --mode named --zone mydomain.cn --hostname c2c.mydomain.cn --json
```

先检查输出：必须 `fallback: false` 且 `state.preference: "named"`。若 fallback 为 true，阅读 error 并处理原因，不能仅看 ok。确认后再执行：

```bat
c2c setup --json
c2c doctor --json
```

若确实希望使用根域名，第一条命令改为：

```bat
c2c tunnel choose --mode named --zone mydomain.cn --hostname mydomain.cn --json
```

根域名可能已有网站记录，建议使用未被占用的子域名。遇到 DNS 冲突先确认现有记录用途，不能把“已存在”当作正确绑定。配置输出成功仍需 doctor 和公网验证，因为现有 DNS 错误识别存在上述缺陷。

若需要指定已有隧道的运行凭据：将下面示例 UUID 替换为该工作区实际 tunnelId，先确认文件存在，再执行：

```bat
set "TUNNEL_CRED_FILE=%USERPROFILE%\.cloudflared\11111111-1111-4111-8111-111111111111.json"
c2c stop
c2c setup --json
c2c doctor --json
```

账号登录不能修复缺失的 JSON 凭据，需要恢复对应隧道的凭据或重新配置隧道。不要将证书、JSON 内容或 TunnelSecret 贴入排查日志。

不在当前项目目录时，给每条工作区命令使用相同的 `-w "D:\Projects\My Project"`。C2C 状态按工作区 ID 保存；给另一个目录配置域名不会改变当前目录的 setup 行为。

## 5. 建议新增参数及准确语义

建议 `--domain <hostname>` 表示最终访问的**完整主机名**，不自动添加前缀：

```bat
rem 建议的新接口，当前版本尚不支持
c2c setup --domain mydomain.cn
c2c setup --domain c2c.mydomain.cn
c2c setup -w "D:\Projects\My Project" --domain c2c.mydomain.cn --json
```

第一条的 MCP 地址应为 `https://mydomain.cn/mcp`，第二条为 `https://c2c.mydomain.cn/mcp`。这样用户传入什么域名，程序就绑定什么域名。

沿用现有 `tunnel choose --zone mydomain.cn` 的自动生成规则；setup 如需支持自动生成，另提供 `--zone mydomain.cn`，不要让同一个 domain 参数有时表示 DNS zone、有时表示完整主机名。

| 建议参数 | 语义 |
| --- | --- |
| `--domain <hostname>` | 精确的公网主机名，隐含 named 模式；失败即失败 |
| `--zone <zone>` | 可选的 Cloudflare zone 提示；单独使用时生成 `c2c-<project>.<zone>` |
| `--origin-cert <path>` | 管理命令的账号证书路径，优先于 TUNNEL_ORIGIN_CERT |
| `--credentials-file <path>` | 对应 UUID 的本地运行凭据路径，优先于 TUNNEL_CRED_FILE |
| `--allow-quick-fallback` | 用户明确允许本次固定域名失败后使用临时地址；不能静默覆盖已有 named 配置 |

路径参数传给后续 Bridge 必须通过受保护的用户状态文件或内部配置机制持久化；只设置当前 CLI 的内存变量不能保证重启后可运行。文件内容及秘密不能存入项目仓库。

没有参数时保持兼容：保存了 named 就复用 named，否则使用 quick。有显式 domain/zone 时覆盖旧 quick 选择。domain/zone 与 `--no-tunnel` 冲突，应在任何配置副作用之前报错；credentials-file 单独使用则必须存在可复用的 tunnelId。

域名输入采用严格校验：去除首尾空白、转小写、移除一个末尾点，校验 DNS 标签和总长度；拒绝协议、路径、端口、IP、通配符及非法字符。首版可以明确只支持 ASCII 主机名，IDN 用户传入规范化的 punycode。

不能通过“最后两个标签”推断 zone，`example.com.cn` 等域名会被推错。仅指定 domain 时，本地管理模式直接将完整主机名交给 cloudflared route dns；建议将 provisionNamedTunnel 的 zone 改为可选，只有生成默认主机名时才要求 zone。需要精确校验 zone 所属账号或 DNS 目标时，应通过有明确权限的 Cloudflare API 获取，而不是从 cert.pem 推测。

## 6. 可靠的执行流程

仅为 setup 增加参数并调用现有 provisionNamedTunnel 不够，因为现有函数会降级、覆盖状态并误判 DNS 冲突。建议将“准备资源”和“提交工作区配置”分离。

1. **解析和预检。** 校验参数，解析工作区，取得该工作区配置锁并保存旧状态；查明 cloudflared 可执行文件及版本、证书与凭据绝对路径。已运行 Bridge 状态不确定时停止本次操作，沿用项目禁止启动重复 Bridge 的规则。
2. **验证管理授权。** 显式请求创建或更改路由时，证书不仅要存在，还要可读且能完成真实管理操作。证书缺失才进入登录流程；证书失效或权限不足时返回相应错误。登录 stdout/stderr 应让用户看见授权 URL，JSON 模式把进度写到 stderr，保留 stdout 为单个结果对象。
3. **创建或复用隧道。** 优先使用已保存的 UUID；首次使用工作区确定的 tunnelName 创建。仅在命令成功退出且结构化结果有效时认定成功。区分本地管理和远程管理隧道，首版只接受有匹配 JSON 凭据的本地管理隧道；不能把 token 模式隧道直接套入当前流程。
4. **检查运行凭据。** 验证 JSON 可读、大小合理、TunnelID 匹配，并检查运行所需字段（包括 AccountTag 和 TunnelSecret）；缺失凭据返回专门错误，不因远端同名隧道存在而继续。首次创建时控制凭据输出位置，复用时不自动重建或删除远端隧道。
5. **绑定 DNS。** 使用 UUID 执行 route dns；删除宽泛的 isBenignRouteError 判断。明确的命令成功才能进入下一步；“已存在”错误只有在可验证该记录指向当前 UUID 时才能视为幂等成功，否则返回 DNS_RECORD_CONFLICT。不默认使用 overwrite-dns，也不自动删除已有记录。Cloudflare 代理可能隐藏公开 CNAME，因此普通 DNS 查询不能可靠证明记录目标；可用 DNS API 验证，没权限时应报冲突而不是猜测成功。
6. **使用候选配置启动。** 为每个工作区生成独立 cloudflared 配置，以 UUID、凭据绝对路径、精确 hostname 的 ingress、实际 Bridge 端口及末尾 `http_status:404` 构建。通过显式 config 路径启动，避免加载用户全局 config.yml。保留 C2C_TUNNEL_PROTOCOL 支持，继续使用 spawn(executable, args)，不拼 CMD 命令字符串。
7. **处理旧 Bridge。** 提供内部候选配置入口，让 Bridge 能在最终状态提交前加载候选配置。旧运行配置与目标一致且真实健康时直接复用；不一致才停止旧 Bridge。stopBridge 当前返回不等于进程已经退出，应等待原进程和端口确认停止，再启动新实例；不能仅写磁盘配置后复用旧 quick 进程。
8. **验证完整连接。** 等待隧道连接后，对 `https://<domain>/health` 进行有超时、有限次数的重试，检查 service、status、workspaceId 与当前工作区相符，拒绝重定向到其他域名。需要 TLS 正常，不能禁用证书校验。仅 HTTP 200 或隧道连接日志不足以判断成功；另检查 MCP/OAuth 发现入口，不能用未经授权的 MCP 请求必须成功作为标准。
9. **提交并输出。** 验证完成后原子提交 named 状态、独立配置引用和 endpoint，再生成配对码。setup 输出实际验证过的 hostname、provider 和 mcpUrl，不能根据磁盘状态推断运行模式。保存的状态区分“配置存在”和“健康检查已通过”。
10. **处理失败和重试。** 默认返回非零退出码，保留旧状态与 endpoint，关闭本次新进程；如果停止了旧 Bridge，尝试按旧配置恢复并报告结果。保留远端已完成步骤以便重试，不宣称本地回滚等于远端 DNS 回滚。如果改动了同一 hostname 的路由，应报告该副作用及旧连接可能受影响，不自动覆盖回旧记录。远端新资源不要自动删除，错误中返回非敏感的 tunnelId 和失败阶段供恢复。

工作区锁防止同一工作区并发配置；独立 hostname 与 UUID 防止不同工作区互相混用。首次切换到固定域名后，需要更新 ChatGPT 连接器地址，文档应提示用户；后续同一 hostname 的重启不需要换地址。

## 7. 错误契约与降级策略

建议提供稳定的错误码：INVALID_DOMAIN、OPTION_CONFLICT、CLOUDFLARED_NOT_FOUND、ACCOUNT_CERT_MISSING、ACCOUNT_AUTH_FAILED、ZONE_PERMISSION_DENIED、TUNNEL_CREDENTIAL_MISSING、TUNNEL_CREDENTIAL_MISMATCH、DNS_RECORD_CONFLICT、TUNNEL_START_FAILED、PUBLIC_ENDPOINT_UNREACHABLE、PUBLIC_ENDPOINT_MISMATCH、BRIDGE_STATE_UNCERTAIN。

`--json` 失败示例：

```json
{
  "ok": false,
  "stage": "route_dns",
  "code": "DNS_RECORD_CONFLICT",
  "hostname": "c2c.mydomain.cn",
  "fallback": false,
  "message": "域名已有冲突的 DNS 记录。请确认现有记录用途，或指定其他子域名。"
}
```

成功示例：

```json
{
  "ok": true,
  "mcpUrl": "https://c2c.mydomain.cn/mcp",
  "tunnel": {
    "mode": "named",
    "hostname": "c2c.mydomain.cn",
    "fallback": false,
    "verified": true
  }
}
```

以上是相关字段示意；实际返回保留现有 workspaceId、connectorName、pairingCode 等字段。普通文本应显示同样明确的失败阶段和修复动作。对 cloudflared 输出做脱敏和长度限制，不能输出秘密。

只有用户传了 allow-quick-fallback 才允许本次降级；输出必须明确实际 quick 模式、临时地址和 namedError。保留既有固定域名配置，本次运行降级与长期偏好分开存储。doctor、Skill 及下次 setup 需要识别该状态，避免错误地把临时地址当成固定域名，也避免自动再覆盖用户选择。

## 8. 建议修改范围与验收

| 文件 | 改动 |
| --- | --- |
| `src/cli/index.ts` | setup 参数、统一配置编排、实际运行模式输出、错误码和退出码；tunnel choose 复用同一编排逻辑 |
| `src/tunnel/named-provision.ts` | 严格失败返回；资源准备与状态写入分离；凭据预检、UUID 路由、准确处理进程退出与超时 |
| `src/tunnel/cloudflared-named.ts` | UUID、显式独立配置及凭据路径；连接日志与公网可用性分离 |
| `src/tunnel/state.ts`、`src/config/paths.ts` | 候选配置、原子提交、锁和兼容旧状态；区分 configured 与 verified |
| `src/bridge/server.ts`、`src/process/daemon.ts` | 候选配置传递、配置一致性判断、确认停止、失败恢复 |
| `tests/tunnel.test.ts`、CLI/Windows 相关测试 | 替换宽泛 DNS 成功断言，增加错误和真实参数传递覆盖 |
| `README.zh-CN.md`、`README.md`、`docs/troubleshooting.md`、`skill/SKILL.md` | 新入口、参数准确语义、CMD 示例、严格失败及显式降级契约 |

验收至少覆盖：

- 只有账号证书、未保存 named 状态：新 setup --domain 必须进入 named 配置流程；旧无参数 setup 保持兼容。
- 已保存 quick 或已运行 quick Bridge：指定 domain 后正确切换，不能继续返回旧临时 URL。
- 已登录且凭据有效：不重复登录；仅运行既有 UUID 隧道时可不依赖账号证书。
- 远端同名隧道存在但本地 JSON 缺失/不匹配：明确失败并保留旧状态。
- DNS 记录指向其他服务或隧道：不得视为成功，不得覆盖记录。
- 同一 domain 重复 setup、电脑/Bridge 重启：复用原 UUID、稳定 URL 和正确凭据路径。
- 根域名、子域名、com.cn、多工作区、带空格/中文的 Windows 路径：解析及隔离正确。
- 修改 CMD 环境后旧 Bridge 尚在运行：重新启动后使用新配置，不能依赖旧进程刷新环境。
- 子进程启动错误、超时、失败日志含 UUID：不产生虚假成功状态。
- 隧道连上但公网 health 失败、返回其他 workspaceId、发生重定向：setup 返回非零，配对码及新 endpoint 不提交。
- 显式降级、JSON/stdout、普通文本/退出码保持一致，日志不泄漏凭据。

单元与 CLI 测试应使用模拟 account/进程和独立状态目录；Windows 端到端验收应在真实 CMD 中运行，并使用专用测试域名验证创建、复用、DNS 冲突及重启，不占用已有业务域名。

发布时必须重新构建。`bin/c2c.js` 优先加载 dist；只修改 src 而保留旧 dist 会使 CLI 看起来“没有更新”。还需通过 `where c2c` 确认用户运行的是这次发布的安装位置。

## 9. studyos 现场定位与修复记录

### 9.1 现场状态与配置文件

用户工作区为 `D:\develop\gitee\studyos`，目标完整主机名为 `sinojelly.kdns.fr`。2026-10-10 现场检查结果：

- `cloudflared.exe` 位于 `D:\Tools\cmd\cloudflared.exe`，版本为 2026.10.0。
- `C:\Users\Jelly\.cloudflared\cert.pem` 存在（282 字节），C2C 检查返回 `loggedIn: true`；没有读取或输出证书内容。
- `studyos` 的规范化路径计算出的工作区 ID 为 `a980b786ad95`。
- `c2c tunnel status -w D:\develop\gitee\studyos --json` 返回 `preference: "unset"`、`needsChoice: true`、`namedReady: false`。此时用户状态目录尚不存在，远端隧道列表为空。
- 旧构建执行 `setup --domain sinojelly.kdns.fr` 直接报 `unknown option '--domain'`，确认根因发生在 CLI 配置入口，而非证书未识别。

项目里的 `.c2c.json` 用于工作区名称及项目配置，`.c2cignore` 用于文件排除；它们不是公网域名配置。`studyos` 根目录检查时没有这两个文件，C2C 没有往项目目录写入隧道凭据。

真实连接状态位于用户目录，文件职责如下（只有对应操作执行后才会创建）：

| 文件 | 内容与职责 |
| --- | --- |
| `%LOCALAPPDATA%\codex-with-chatgpt\tunnels\a980b786ad95.json` | 固定域名选择：preference、provider、tunnelName、tunnelId、hostname、credentialsFile 等 |
| `%LOCALAPPDATA%\codex-with-chatgpt\endpoints\a980b786ad95.json` | 最近验证并保存的 publicUrl、mcpUrl、端口和连接器名称；不能用它替代隧道配置 |
| `%LOCALAPPDATA%\codex-with-chatgpt\runtime\a980b786ad95.json` | 当前 Bridge 的 PID、端口、publicUrl 等，含管理令牌，不应手工修改或公开内容 |
| `%LOCALAPPDATA%\codex-with-chatgpt\cloudflared\<UUID>.json` | 修复后生成的独立 cloudflared 配置，含凭据文件路径及 ingress；不包含 TunnelSecret |
| `%USERPROFILE%\.cloudflared\<UUID>.json` | 真正的隧道运行凭据，含秘密，不能提交 Git |

固定域名状态的字段示意（UUID 必须替换为真实存在且有对应凭据的隧道）：

```json
{
  "workspaceId": "a980b786ad95",
  "preference": "named",
  "provider": "cloudflare-named",
  "tunnelName": "c2c-a980b786ad95",
  "tunnelId": "真实的隧道 UUID",
  "hostname": "sinojelly.kdns.fr",
  "credentialsFile": "C:\\Users\\Jelly\\.cloudflared\\真实的隧道 UUID.json"
}
```

**能否直接修改文件？** 技术上可以在停止 Bridge 后编辑隧道状态，但必须先创建真实隧道、配置正确 DNS 并具有匹配凭据；仅写 hostname 或把 preference 改为 named 不会创建远端资源。修改 endpoint/runtime 也不会切换提供器。因此应使用修复后的 setup --domain 完成配置和验证，避免手工造成“状态看起来正确、实际访问错误”。

### 9.2 本次已实现的修复

- 新增 `c2c setup --domain <hostname>`，精确使用输入的完整主机名；与 no-tunnel 冲突时，在任何配置副作用之前失败。
- 显式域名采用 strict provisioning，失败抛出真实错误，不降级、不覆盖旧配置；zone 可省略，不从 kdns.fr 等后缀推断账号 zone。
- 隧道创建只在成功退出后解析 UUID；管理命令显式传入证书绝对路径，并保留启动/超时错误。DNS 通过 UUID 路由，不再把任意 already exists 错误当作成功。
- 在 DNS 配置前检查隧道 JSON 凭据；保存凭据绝对路径，doctor 也使用这个路径诊断。
- Named provider 通过 UUID 和独立 ingress 配置运行，避免用户全局 config.yml 影响当前工作区；保留旧状态中只有名称的兼容路径。
- 新增 setup-domain 编排：工作区独占锁、候选配置传给新 Bridge、等待旧 Bridge 停止、检查公网 health 的 service/status/workspaceId，验证通过后才保存 named 状态。endpoint 和配对码仍在验证之后生成。
- 验证失败时关闭候选进程，原状态和 endpoint 不变；有原运行进程时尝试恢复。Cloudflare 远端资源和 DNS 已完成的操作保留供重试，不能声称本地失败处理会自动回滚 DNS。

候选配置通过内部进程环境传递，仅包含工作区 ID、隧道 ID、主机名和凭据路径，不包含凭据内容。普通启动清除此覆盖变量，避免跨工作区继承。

本次实现没有一并推出第 5 节提出的 zone/path/fallback 新参数，也没有自动修改 ChatGPT 连接器。旧 `tunnel choose` 保留兼容的自动降级流程；显式 setup --domain 使用严格流程。

### 9.3 本地回归与构建验证

先新增 5 个回归测试，确认在旧代码上全部失败，分别复现：domain 参数不识别、精确主机名预配置失败、显式失败被降级、DNS 冲突误报成功、失败创建输出 UUID 被误认成功。修复后补充公网健康身份验证、不可达错误、失败恢复与成功提交时机的测试。

验证命令（直接使用 Node，避开当前 pnpm exec 在 Windows 下寻找 vitest 的问题）：

```bat
node node_modules\typescript\bin\tsc --noEmit
node node_modules\vitest\vitest.mjs run
node node_modules\typescript\bin\tsc -p tsconfig.json
node bin\c2c.js setup --help
git diff --check
```

结果：类型检查和构建成功；19 个测试文件、196 项测试全部通过；新 dist 的 setup 帮助已显示 domain 参数；差异格式检查通过。真实域名验证结果在后续小节追加。

第一阶段已提交：`2704602`（`fix: 支持 setup 显式配置并验证固定域名`）。提交说明包含行为修改、失败恢复与测试结果。

### 9.4 Windows CMD 真实域名验证

以下均为 2026-10-10 本机实际执行记录，时间使用北京时间（UTC+8）。Cloudflare 网络操作与用户状态目录写入通过沙箱外执行完成；初次沙箱内列隧道时曾出现 socket 权限拒绝，提升执行权限后正常，确认该错误属于验证环境的网络限制。

| 时间 | 验证 | 结果 |
| --- | --- | --- |
| 20:39 | 新 setup --domain，为 studyos 创建隧道并绑定 sinojelly.kdns.fr | `ok: true`、`mode: named`、`fallback: false`、`verified: true` |
| 20:40 | 通过 `cmd.exe /d /c` 重复执行同一 domain 配置 | 同一隧道 UUID、同一 MCP URL，DNS 幂等配置成功 |
| 20:41 | 通过 CMD 停止 Bridge，再执行不带 domain 的 setup | 从保存状态恢复 named，地址保持不变 |
| 20:41 | 从公网读取 health、OAuth 及 MCP 资源发现信息 | 工作区 ID 匹配；issuer、授权/令牌端点及 resource 都使用固定域名 |
| 20:41 | `doctor --no-fix --json` | node、sandbox、workspace、bridge、mcp、oauth、tunnel 全部 ok；未执行修复 |

创建并复用的资源：

```text
工作区：D:\develop\gitee\studyos
工作区 ID：a980b786ad95
隧道名称：c2c-a980b786ad95
隧道 UUID：f1dfd5c6-84fe-4fe7-b054-cdcf3276762b
访问域名：sinojelly.kdns.fr
MCP URL：https://sinojelly.kdns.fr/mcp
凭据文件：C:\Users\Jelly\.cloudflared\f1dfd5c6-84fe-4fe7-b054-cdcf3276762b.json
```

独立 cloudflared 配置经 `cloudflared tunnel --config <文件> ingress validate` 检查返回 OK。停止恢复之后通过 Windows 进程列表确认该 UUID 只有一个 cloudflared 进程；远端列表确认只有该工作区的一条隧道记录。没有强制覆盖已有 DNS，没有输出证书、TunnelSecret、管理令牌或配对码。

公网 health 的实际响应：

```json
{
  "service": "c2c-bridge",
  "version": "0.1.3",
  "workspaceId": "a980b786ad95",
  "status": "ok"
}
```

注意：doctor 的 `chatgptRepair.needed: false` 表示已保存的 URL 与当前 URL 相同，不证明 ChatGPT 连接器已经完成登录和授权。本次验证范围到公网 Bridge、MCP 未授权响应以及 OAuth 发现；没有操作 ChatGPT UI。

### 9.5 用户可直接复制的 CMD 命令

当前会话的 PATH 查找能发现 cloudflared.exe，但 `where c2c` 未发现入口。因此在 `studyos` 中可使用以下不依赖全局命令安装的形式：

```bat
cd /d D:\develop\gitee\studyos
node "D:\develop\gitee\codex-with-chatgpt\bin\c2c.js" setup --domain sinojelly.kdns.fr
```

配置已经保存，以后恢复连接只需：

```bat
node "D:\develop\gitee\codex-with-chatgpt\bin\c2c.js" setup
```

查看该工作区的选择与健康状况：

```bat
node "D:\develop\gitee\codex-with-chatgpt\bin\c2c.js" tunnel status --json
node "D:\develop\gitee\codex-with-chatgpt\bin\c2c.js" doctor --no-fix --json
```

若之后已把 c2c 安装到 PATH，上述 Node 入口可以直接替换为 c2c。当前 Bridge 保持运行，固定地址已可访问。ChatGPT 连接器应使用 `https://sinojelly.kdns.fr/mcp`，配对时再通过 `c2c pair` 生成新码。

本次没有把环境凭据、studyos 项目文件或机器状态文件提交 Git；Git 提交仅包含本项目的修复、测试和文档。

## 10. 2026-10-12：第二个工作区出现临时地址的复现与修复

WealthSail 工作区为 `D:\develop\gitee\WealthSail`，ID 为 `7d8d3c79bbbb`。`sinojelly.kdns.fr` 已属于 studyos 的 DNS 路由；直接为 WealthSail 执行 `c2c setup --domain sinojelly.kdns.fr` 时，Cloudflare 返回 1003：该主机名已经有 A、AAAA 或 CNAME 记录。这是正确的冲突拒绝，不能覆盖 studyos 的记录。改用 `wealthsail.sinojelly.kdns.fr` 后，复用失败尝试中创建的 `c2c-7d8d3c79bbbb` 隧道，固定域名配置及公网身份验证均成功。

用户随后报告无参数 `c2c setup` 又返回 `trycloudflare.com`。现场读取显示：隧道状态文件已保存 `preference: named` 和 `hostname: wealthsail.sinojelly.kdns.fr`，但正在运行的 Bridge 报告 `provider: cloudflare-quick`、`publicUrl` 为临时地址。使用与用户相同的 CMD 目录和 `c2c.cmd` 执行无参数 setup，确实复现了临时地址；JSON 输出甚至同时报告 `mode: named` 和临时 URL。

确认的缺陷位于 `ensureBridgeAndTunnel`：它调用 `ensureBridge` 时，只要发现同一工作区已有健康 Bridge 就直接复用，没有检查该进程的隧道提供器和公网地址是否与最新保存的配置一致。一个先前启动的 quick Bridge 因此可以覆盖普通 setup 的实际连接。该 quick 进程何时由哪个操作启动，并未从现存日志完全确定；本次修复针对已经证实的“运行配置与保存配置不一致时仍复用”的缺陷。

修复后，在需要公网连接时比较运行提供器、当前 URL 与目标工作区状态。若状态要求 named 而 Bridge 为 quick、或者 named 域名不同，先停止旧 Bridge 并等待确认退出，再按目标状态启动。若状态要求 quick 而旧 Bridge 为 named，也同样重启。启动后再次检查，未匹配则报错，不生成指向错误 URL 的配对结果。源码注释解释了为什么仅修改磁盘状态不会改变已运行进程。

新增两项回归测试覆盖 named 状态复用 quick Bridge、named 域名不一致及 quick 状态复用 named Bridge。测试先失败后通过。完整验证：19 个测试文件、198 项测试通过；TypeScript 类型检查和构建通过。随后从实际 quick Bridge 出发，在 WealthSail 目录执行普通 CMD `c2c setup`，恢复 `https://wealthsail.sinojelly.kdns.fr/mcp`。再停止 Bridge 并执行不带 domain 的 setup，冷启动仍返回同一固定域名。公网 `/health` 的 workspaceId 为 `7d8d3c79bbbb`，`doctor --no-fix` 的 Bridge、MCP、OAuth、Tunnel 均正常；studyos 的 `sinojelly.kdns.fr` 仍返回其原工作区 ID `a980b786ad95`。

两个工作区应分别使用不同主机名：

```text
studyos     → https://sinojelly.kdns.fr/mcp
WealthSail  → https://wealthsail.sinojelly.kdns.fr/mcp
```

在 WealthSail 目录中，今后运行 `c2c setup` 即可使用保存的固定地址，不必再传 domain。若命令输出 `trycloudflare.com`，应视为实际运行配置不一致，不要根据 JSON 里的 named 标签判断已恢复；升级到包含本次修复的构建后重试。

## 11. 2026-10-12：`cloudflared exited (code 1)` 再次排查

用户在 WealthSail 执行无参数 setup 后报告 `cloudflared exited (code 1) before establishing a tunnel`。精确匹配源码发现：`before establishing a tunnel` 由 **Quick Tunnel** 提供器抛出，Named Tunnel 的对应错误写作 `before establishing the named tunnel`。所以仅凭此报错，不能认定已保存的固定域名隧道本身退出。检查时本机默认用户状态文件仍为 `preference: named`，现存 Bridge 的 provider 为 `cloudflare-named`；两个固定域名的 `/health` 也都能返回正确的工作区 ID。这与报错所用的 Quick Tunnel 路径不一致。

后来取得报错的同一个 CMD 窗口的输出：`where c2c` 为 `D:\Tools\cmd\c2c.cmd`，该脚本调用本仓库的 `bin\c2c.js`；`C2C_STATE_DIR` 未设置；`LOCALAPPDATA` 为 `C:\Users\Jelly\AppData\Local`；`c2c workspace --json` 的 ID 为 `7d8d3c79bbbb`。CLI 入口、默认状态目录和工作区 ID 均与本机排查时一致，因此“使用了另一个 CLI／工作区／显式状态目录”的初步猜测已排除。

关键的现场证据是：报错窗口的 `c2c tunnel status --json` 返回 `preference: "unset"`、`namedReady: false`，所以这次无参数 setup 确实会选择 Quick Tunnel。这解释了为何出现 Quick 专属的 `before establishing a tunnel` 报错。用户在同一个 CMD 窗口再次运行 status，仍为 `unset`；随后 `dir "%LOCALAPPDATA%\codex-with-chatgpt\tunnels\7d8d3c79bbbb.json"` 返回“找不到文件”，列出 `tunnels` 目录也为空。故该 CMD 所见的直接原因是**该工作区的固定域名状态文件不存在**，与 cloudflared 是否登录无关。`readJsonIfExists` 在文件不存在时返回 `null`，调用者合成 `unset`。

本任务的执行环境在相同字面路径下能读到 `preference: "named"` 的状态文件，修改时间为 2026-10-12 20:34:29；即使进行只读提权检查也仍能读到。但这与用户当前 CMD 的目录结果矛盾，说明两边文件系统视图未一致，不能以本任务的状态文件作为用户机器上已经持久保存的证据，也不能声称其差异的底层原因已经查明。应以用户当前 CMD 的只读结果为准。

用户随后在原 CMD 窗口运行 `c2c setup --domain wealthsail.sinojelly.kdns.fr` 并反馈成功。显式 setup 的实现只有在连接 URL 与所请求域名一致、且公网 `/health` 返回当前工作区 ID 后才写入 named 状态；因此这一步是将固定域名配置保存到用户当前环境的可靠恢复方式。接着用户再次运行**无参数** `c2c setup`，确认连接地址正确，即 `https://wealthsail.sinojelly.kdns.fr/mcp`。这验证了原报错路径已恢复固定域名；用户没有提供新的 status JSON，故不将其列为额外的实测结果。若未来显式 setup 失败，应保留准确错误，不要把已存在的 DNS 记录强行改指向别的项目。

代码检查还发现 Quick Tunnel 处理进程退出时会把先前捕获的 `ERR` 行覆盖成通用的 `cloudflared exited (code 1)`。新增回归测试先复现这条诊断丢失，再修改退出处理保留原错误行，便于下一次准确定位 Cloudflare 返回的原因。

同时，在本机 CMD 显式重复运行 `setup --domain wealthsail.sinojelly.kdns.fr` 时，Cloudflare 管理 API 曾对更新路由请求返回 `EOF`。原实现每次显式 setup 都重新请求远端路由，即使同一工作区已经保存了相同 hostname 与 UUID。新增回归测试验证这一重复调用会不必要地触发 API 故障。修复后，相同 hostname 的重复 setup 复用已保存的隧道配置；仍检查当前 Bridge 的实际 URL 和公网工作区身份，首次配置或换域名才请求 Cloudflare 管理 API。修复后同一 CMD 命令返回固定地址 `https://wealthsail.sinojelly.kdns.fr/mcp`，`verified: true`。

如果报错窗口的 `tunnel status` 显示 `unset` 或 `quick`，使用该窗口执行 `c2c setup --domain wealthsail.sinojelly.kdns.fr` 可显式选择本工作区的固定地址；之后再用无参数 setup。不要传已属于 studyos 的 `sinojelly.kdns.fr`。如果同一窗口显示 named 却仍尝试 Quick Tunnel，需记录 `where c2c` 与状态目录后继续定位启动链，不能通过覆盖 DNS 或删除凭据掩盖问题。
