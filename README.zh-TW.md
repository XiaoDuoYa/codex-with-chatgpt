# Codex with ChatGPT

<p align="center">
  <a href="README.md">English</a> | <a href="README.ja.md">日本語</a> | <a href="README.zh-CN.md">简体中文</a> | <strong>繁體中文</strong>
</p>

> **ChatGPT 負責思考，Codex 負責幹活。**  
> 將 ChatGPT 作為規劃大腦，同時保留 Codex 的本地執行能力。

---

## 解決什麼問題

ChatGPT Plus/Pro 付費訂閱的網頁版額度大量閒置，Codex 卻在消耗緊張的 API 額度做高層規劃和程式碼審查。

本專案把「思考」交給你已付費的網頁版 ChatGPT，Codex 只負責本地執行（修改程式碼、跑測試、修復錯誤）。

無需 API Key、不搞逆向代理——官方網頁介面直接連接安全、唯讀的 MCP 橋接服務。

## 這是什麼

**Codex with ChatGPT** 把 ChatGPT 網頁版變成 Codex 編程工作階段的「規劃與審查大腦」，而執行權完全保留在 Codex 手裡。

你的儲存庫永遠不會被整包上傳：ChatGPT 透過一條安全的、OAuth 2.1 保護的**唯讀** MCP（Model Context Protocol）連接，按需讀取當前工作區裡真正需要的程式碼片段。

## 一段話安裝（純新手專用）

不懂 git、Node、終端機？完全不需要懂。把下面這段話原樣複製給你的編程 Agent（Codex），然後去倒杯咖啡：

```text
請幫我完整安裝並設定 Codex with ChatGPT，全程自動，我是不懂技術的新手，
所有事情你自己做：

1. 環境自檢：需要 git 和 Node.js ≥ 20，缺什麼就自動安裝
  （macOS 用 Homebrew，Windows 用 winget），同時安裝 cloudflared。
2. 下載：把 https://github.com/XiaoDuoYa/codex-with-chatgpt 複製到
   ~/codex-with-chatgpt（已存在就 git pull 更新）。
3. 建置：在該目錄裡執行 corepack pnpm install 和 corepack pnpm build。
4. 安裝 Skill：把儲存庫裡的 skill/SKILL.md 複製到
   ~/.codex/skills/codex-with-chatgpt/SKILL.md，並把檔案中
   "The codex-with-chatgpt checkout lives at:" 那一行的路徑改成實際複製路徑。
5. 首次設定：按 SKILL.md 裡的 first-time setup 流程執行
  （執行 c2c setup，用內建瀏覽器打開 ChatGPT 設定連接器並輸入配對碼）。
   全程只用內建瀏覽器，禁止打開任何第三方瀏覽器。
6. 只有遇到需要我登入（ChatGPT / Cloudflare）、驗證碼或兩步驟驗證時才叫我，
   而且一次只告訴我一個動作。
7. 完成後給我看 ✓ 清單，並確認檔案讀取測試通過。我不懂 MCP、OAuth、
   Tunnel、連接埠這些詞，不要向我解釋；出了問題先自己修。
```

**自動更新**：Skill 每天自動檢查一次 GitHub，有新版本會自動更新並繼續任務，無需任何操作；也可以隨時對 Codex 說「更新 Codex with ChatGPT」。

---

## 安裝 → 設定 → 使用（手動版）

1. **安裝 Skill**：把 `skill/` 目錄複製到 `~/.codex/skills/codex-with-chatgpt/`。
2. **首次設定**：對 Codex 說：**「使用 Codex with ChatGPT 完成首次設定。」**
3. **日常使用**：對 Codex 說：**「使用 Codex with ChatGPT，幫我實現 [某功能/任務]。」**

說明書到此結束。Codex 會自動完成所有設定，你只會看到：

```
Codex with ChatGPT

✓ 當前專案已識別
✓ Workspace Bridge 已啟動
✓ 安全連接已建立
✓ ChatGPT 已連接
✓ 檔案讀取測試通過

Ready.
```

唯一可能需要你動手的步驟：登入 ChatGPT。僅此而已。

---

## 工作原理

```
             ┌───────────────────────────┐
             │      ChatGPT 網頁版       │
             │   推理 / 規劃 / 審查      │
             └──────────┬──────────▲─────┘
                        │          │
               MCP      │          │ Computer Use
              數據面    │          │ 控制面（訊息 < 1 KB）
                        ▼          │
             ┌─────────────────────┐
             │      C2C Bridge     │   僅監聽本機回環地址
             │  唯讀 MCP           │   OAuth 2.1 + 一次性配對碼
             │  OAuth + 配對       │   Cloudflare Quick Tunnel
             │  Tunnel 管理        │
             └──────────┬──────────┘
                        │  唯讀
                        ▼
             ┌─────────────────────┐          ┌─────────────────────┐
             │     本地工作區      │◀─────────│    Codex Harness    │
             └─────────────────────┘ 編輯/git │  Shell / 測試 / 修復 │
                                              └─────────────────────┘
```

- **控制面（狀態訊息）**：Codex 與 ChatGPT 之間只交換極小的結構化 `[C2C]` 狀態訊息（`INIT → PLAN → EXECUTED → REVIEW → DONE`）。絕不在聊天框中貼上 diff、日誌或檔案內容。
- **數據面（MCP）**：ChatGPT 缺什麼自己按需拉取，共 8 個唯讀工具：
  `workspace_info`、`list_directory`、`read_file`、`search_workspace`、`git_status`、`git_diff`、`test_status`、`execution_summary`。
- **獨立審查**：Codex 執行完畢後，ChatGPT 透過 MCP 親自檢查真實的 `git_diff` 和測試記錄——絕不盲目相信「測試全過」的口頭聲明。

---

## 安全模型（簡版）

- **從構造上唯讀**：伺服端根本不存在寫檔案、刪除、Shell 執行、程式碼提交類工具，任何提示注入都無法啟用它們。
- **一個工作區 = 一道邊界**：每個令牌綁定單一工作區；路徑校驗基於規範化 `realpath`（symlink、`../`、絕對路徑逃逸全部被攔截並有測試覆蓋）。
- **敏感檔案永不外洩**：`.env*`、金鑰、SSH、各類雲端憑證預設拒絕（`.env.example` 放行）；`.c2cignore` 可追加自訂規則。
- **知道 URL 不等於有權限**：公網 MCP 端點強制 OAuth 2.1（PKCE S256、動態客戶端註冊、refresh token 輪換）。無令牌：401；令牌屬於別的工作區：403。
- **模型永遠接觸不到長期憑證**：唯一會出現在瀏覽器裡的秘密是一次性配對碼（5 分鐘有效、限 5 次嘗試、限速、用後即毀）。

完整威脅模型見 [docs/security.md](docs/security.md)。

---

## 開發者

```bash
pnpm install
pnpm build          # 產出 dist/，暴露 c2c 指令
pnpm test           # vitest：單元與整合測試

c2c setup           # 一條指令：Bridge + 隧道 + 配對碼
c2c sandbox-allow   # 把本地設定目錄加入 Codex 沙箱白名單（macOS / Windows）
c2c status / doctor / pair / unpair / logs / stop
```

**環境要求**：Node.js >= 20、git；公網連接需要 `cloudflared`（自動檢測，Skill 會替你安裝）。

**詳細文件**：
- [架構設計](docs/architecture.md)
- [協議規範](docs/protocol.md)
- [安全模型](docs/security.md)
- [疑難排解](docs/troubleshooting.md)

---

## 目錄結構

```
src/
  bridge/     本機回環 HTTP 服務、連接埠自動恢復、管理 API
  mcp/        8 個唯讀工具、無狀態 Streamable HTTP
  auth/       OAuth 2.1（PKCE、動態註冊、refresh 輪換、撤銷）
  pairing/    一次性配對碼（CSPRNG、TTL、限速）
  workspace/  路徑收斂、敏感檔案策略、搜尋、git
  tunnel/     TunnelProvider 抽象 + Cloudflare Quick Tunnel
  execution/  審查閉環所需的執行記錄
  process/    守護進程生命週期
  cli/        c2c 命令列
skill/        Codex Skill 定義
tests/        單元與整合測試
docs/         架構、協議、安全與疑難排解文件
```

---

## 聲明與授權條款

**非官方社群專案，與 OpenAI 無關聯或背書。**

遵循 [MIT 授權條款](LICENSE)。
