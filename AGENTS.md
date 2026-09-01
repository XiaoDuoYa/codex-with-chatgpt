# codex-with-chatgpt — AGENTS.md

## 概要

GitHub の `XiaoDuoYa/codex-with-chatgpt` を正本とする、ChatGPT Web とローカルワークスペースを接続する read-only MCP ブリッジです。
ChatGPT が計画・読解・レビューを担当し、OMP が編集・テスト・build・依存関係変更・Git 操作・最終統合を担当します。

OMP からの実行規約は [`skill/omp/SKILL.md`](skill/omp/SKILL.md) に置きます。

## コマンド

Node.js は PATH のものを優先し、無ければ ChatGPT アプリ同梱版を使います。

```sh
./scripts/omp-c2c.sh --version
./scripts/omp-c2c.sh doctor -w /Users/arica/Data/OMP --no-fix --json
./scripts/omp-c2c.sh status -w /Users/arica/Data/OMP --json
PATH=/Applications/ChatGPT.app/Contents/Resources/cua_node/bin:$PATH corepack pnpm typecheck
PATH=/Applications/ChatGPT.app/Contents/Resources/cua_node/bin:$PATH corepack pnpm test
```

状態変更の前に、`session lock acquire`で正規workspaceの排他を取得し、返されたtokenを
`setup`、`doctor`（修復あり）、`pair`、`unpair`、`tunnel`、`session set/clear`、`record`
などへ`--lock-token`で渡します。完了時は`session lock release`を実行します。

通常の重い依頼は OMP のグローバル自動ルーティングからChatGPTへ委譲します。OMP配下のC2Cワークスペースは `/Users/arica/Data/OMP` を正とし、現在のcwdやサブプロジェクトをworkspace境界にしません。`/chatgpt` は強制委譲、`/chatgpt-diagnostic` はL2診断、`/chatgpt-setup` は初回設定・復旧に使います。

## アーキテクチャ

- `src/bridge/`、`src/mcp/`: loopback HTTP と ChatGPT 向け read-only MCP。
- `src/session/lock.ts`: workspaceのセッション排他とBridge起動時のプロセス排他。
- `src/auth/`、`src/pairing/`: OAuth 2.1、配対コード、トークン境界。
- `src/workspace/`: canonical path、機微ファイル拒否、探索、Git 読み取り。
- `src/execution/`: OMP が記録した実行摘要を ChatGPT のレビューへ公開する。
- `src/tunnel/`: Cloudflare Quick Tunnel。
- `scripts/omp-c2c.sh`: OMP 用の Node.js 起動ラッパー。upstream の Codex 用設定は C2C 状態ディレクトリ内へ隔離し、`~/.codex/config.toml` を変更しない。
- ChatGPT との接続は ChatGPT 側から C2C の HTTP MCP へ行います。OMP の `.omp/mcp.json` に C2C を stdio MCP として登録しません。

## 規約

- 通常経路は `TOKEN_SAVING` / `L1_READ_ONLY`。探索、長文読解、設計、根本原因分析、レビュー、要約だけを委譲します。
- `L2_DIAGNOSTIC_COMMANDS` は `git_status`、`git_diff`、`test_status`、`execution_summary` などの read-only 状態確認に限定します。
- L3 以上の経路、ChatGPT からのファイル編集・コマンド実行・install・Git 状態変更は追加しません。
- 制御メッセージへファイル本文、diff、ログ、秘密情報を貼りません。ChatGPT は MCP で必要な範囲だけ読みます。
- OMP の変更は通常の OMP セッションで実行し、ChatGPT の回答をテストや最終判断の代用にしません。
- 接続は一つのC2Cワークスペースにつき一つのconnectorと一つの会話を再利用します。OMP配下の通常ワークスペースは `/Users/arica/Data/OMP` です。プロジェクト単位の分離は明示的に指定した場合だけ行います。
- C2C の認証・実行状態は OS 標準の状態ディレクトリに保持します。秘密情報をリポジトリへ複製しません。
- upstream の更新は `git pull --ff-only` と依存関係・build・テストの順で確認します。ローカル適応層の変更を上書きしません。
- 同じworkspaceで複数のC2Cセッションを同時に動かしません。ブラウザ操作と状態変更の前に`session lock acquire`を行い、期限切れ以外のlockを手動削除しません。

## 落とし穴

- C2C は ChatGPT Web が読む側のブリッジです。旧実装のように OMP から別の Codex CLI を起動するものではありません。
- Quick Tunnel の URL は再起動で変わるため、正規ワークスペースの `doctor` が `chatgptRepair` を示した場合だけ、対象 connector を削除して同じ名前で再作成します。削除と再作成で connector の identity が変わるため、保存済み会話は再利用せず、新しい会話へ現行 connector を追加して `workspace_info` を確認してからURLを保存します。
- `sandbox-allow` は upstream の Codex 用機能です。OMP 用ラッパー経由では C2C 状態ディレクトリ内の隔離設定だけを使います。
- cloudflared が無いと公開 MCP 接続を作れません。macOS arm64 では `~/.local/bin/cloudflared` を検出対象にします。
- ChatGPT の接続成功は実装成功を意味しません。実行摘要、実際の diff、OMP 側のテストで独立に確認します。
