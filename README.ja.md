# Codex with ChatGPT

<p align="center">
  <a href="README.md">English</a> | <strong>日本語</strong> | <a href="README.zh-CN.md">简体中文</a> | <a href="README.zh-TW.md">繁體中文</a>
</p>

> **ChatGPT thinks. Codex works.**  
> ChatGPT を計画・レビューの頭脳として使い、実行は Codex が担当します。

---

## 解決する課題

ChatGPT Plus/Pro などの有料サブスクリプション Web 版の枠が余っている一方で、コーディングエージェント（Codex）が高価で限られた API トークンを高レベルな計画やコードレビューで消費してしまう問題があります。

本プロジェクトは、「思考」をすでに支払っている Web 版 ChatGPT に委託し、Codex はローカルでの実行（ファイル編集、テスト実行、エラー修正）に専念させます。

API キーは不要で、リバースプロキシも不要です。公式の ChatGPT Web 画面と、安全な読み取り専用 MCP ブリッジを連携させます。

## これは何ですか？

**Codex with ChatGPT** は、ChatGPT Web 版をローカルの Codex コーディングセッションの「計画・レビューの頭脳」として接続し、実行権限は完全に Codex に保持させる仕組みです。

リポジトリ全体が一括アップロードされることはありません。ChatGPT は OAuth 2.1 で保護された**読み取り専用** MCP（Model Context Protocol）ブリッジを通じて、必要なコード行だけをオンデマンドで取得します。

## ワンプロンプト導入（非エンジニア向け）

Git、Node.js、ターミナル操作に詳しくなくても大丈夫です。以下のプロンプトをそのままコーディングエージェント（Codex）に貼り付けて実行してください：

```text
Please install and configure "Codex with ChatGPT" for me, fully automatically.
I am a non-technical user — do everything yourself:

1. Check the environment: git and Node.js >= 20 must be available. Install
   anything missing yourself (macOS: Homebrew, Windows: winget). Also install
   cloudflared.
2. Download: clone https://github.com/XiaoDuoYa/codex-with-chatgpt into
   ~/codex-with-chatgpt (if it already exists, git pull to update).
3. Build: inside that folder run `corepack pnpm install` then `corepack pnpm build`.
4. Install the Skill: copy skill/SKILL.md to
   ~/.codex/skills/codex-with-chatgpt/SKILL.md, and update the line
   "The codex-with-chatgpt checkout lives at:" to the actual clone path.
5. First-time setup: follow the SKILL.md "first-time setup" workflow
   (run c2c setup, configure the ChatGPT connector in the BUILT-IN browser,
   enter the pairing code). Never open a third-party browser.
6. Only interrupt me for logins (ChatGPT / Cloudflare), CAPTCHAs or 2FA —
   and give me exactly ONE action at a time.
7. When done, show me the ✓ checklist and confirm the file-read test passed.
   I don't know what MCP, OAuth, tunnels or ports are. Don't explain them.
   If anything breaks, fix it yourself first.
```

**自動更新**: Skill は 1 日に 1 回 GitHub をチェックし、最新バージョンがあれば自動で更新されます。いつでも Codex に「Update Codex with ChatGPT」と指示して更新することも可能です。

---

## 手動セットアップと使い方

1. **Skill の配置**: `skill/` ディレクトリを `~/.codex/skills/codex-with-chatgpt/` にコピーします。
2. **初期設定**: Codex に **「Set up Codex with ChatGPT.」** と指示します。
3. **通常使用**: Codex に **「Use Codex with ChatGPT to implement [タスク内容].」** と指示します。

設定は Codex が自動で行い、以下のように表示されます：

```
Codex with ChatGPT

✓ Project detected
✓ Workspace Bridge started
✓ Secure connection established
✓ ChatGPT connected
✓ File read test passed

Ready.
```

手動での操作が必要になる可能性があるのは、ChatGPT へのログイン画面が表示された場合のみです。

---

## アーキテクチャと動作原理

```
             ┌───────────────────────────┐
             │       ChatGPT Web         │
             │  推論 / 計画 / レビュー   │
             └──────────┬──────────▲─────┘
                        │          │
               MCP      │          │ Computer Use
            データ面    │          │ 制御面（メッセージ < 1 KB）
                        ▼          │
             ┌─────────────────────┐
             │      C2C Bridge     │   ローカルループバックのみリッスン
             │  読み取り専用 MCP   │   OAuth 2.1 + ワンタイムペアリングコード
             │  OAuth + ペアリング │   Cloudflare Quick Tunnel
             │  Tunnel 管理        │
             └──────────┬──────────┘
                        │  読み取り専用
                        ▼
             ┌─────────────────────┐          ┌─────────────────────┐
             │  ローカルワークスペース│◀─────────│    Codex Harness    │
             └─────────────────────┘ 編集/git │  Shell / テスト / 修正│
                                              └─────────────────────┘
```

- **制御面（状態メッセージ）**: Codex と ChatGPT 間では、極小の構造化された `[C2C]` 状態メッセージ（`INIT → PLAN → EXECUTED → REVIEW → DONE`）のみをやり取りします。チャット欄にファイル全文やログ、差分を貼り付けることはありません。
- **データ面（MCP）**: ChatGPT は必要な情報を以下の 8 つの読み取り専用ツール経由で自律的に取得します：
  `workspace_info`, `list_directory`, `read_file`, `search_workspace`, `git_status`, `git_diff`, `test_status`, `execution_summary`。
- **独立レビュー**: Codex の実行完了後、ChatGPT は MCP を通じて実際の `git_diff` やテスト結果を直接検査し、「テストが通った」という主張を鵜呑みにせず検証します。

---

## セキュリティモデル

- **構造的読み取り専用**: ファイル書き込み、削除、シェル実行、コミットなどの破壊的ツールはサーバー上に存在しません。プロンプトインジェクションによって不正操作が実行されるリスクを排除しています。
- **ワークスペース境界**: 各 OAuth トークンは単一の `workspace_id` に紐づけられます。パス検証は正規化された `realpath` を使用し、シンボリックリンクや相対パス（`../`）、絶対パスによる脱出を遮断します。
- **機密ファイルの保護**: `.env*`、秘密鍵、SSH 認証情報、クラウド認証情報などはデフォルトでアクセス拒否されます（`.env.example` は許可）。`.c2cignore` でカスタムルールを追加可能です。
- **保護されたエンドポイント**: パブリック MCP エンドポイントは OAuth 2.1（PKCE S256、動的クライアント登録、リフレッシュトークンローテーション）を要求します。未認証リクエストは `401`、別ワークスペースのトークンは `403` を返します。
- **使い捨ての資格情報**: 長期的な資格情報がブラウザに露出することはありません。接続にはワンタイムペアリングコード（有効期限 5 分、レート制限あり、使用後即座に破棄）を使用します。

詳細は [docs/security.md](docs/security.md) をご覧ください。

---

## 開発者向け情報

```bash
pnpm install
pnpm build          # -> dist/ をビルドし、c2c コマンドを公開
pnpm test           # vitest: 単体テストおよび統合テスト

c2c setup           # ブリッジ + トンネル + ペアリングコード発行を一括実行
c2c sandbox-allow   # Codex サンドボックスの許可リストに設定ディレクトリを追加
c2c status / doctor / pair / unpair / logs / stop
```

**要件**: Node.js >= 20、git、`cloudflared`（自動検出または Skill が自動インストール）。

**ドキュメント**:
- [アーキテクチャ](docs/architecture.md)
- [プロトコル仕様](docs/protocol.md)
- [セキュリティ](docs/security.md)
- [トラブルシューティング](docs/troubleshooting.md)

---

## プロジェクト構成

```
src/
  bridge/     ローカル HTTP サーバー、ポート自動復旧、管理 API
  mcp/        8 つの読み取り専用ツール、ステートレス Streamable HTTP
  auth/       OAuth 2.1（PKCE、動的登録、リフレッシュローテーション、失効）
  pairing/    ワンタイムペアリングコード（CSPRNG、TTL、レート制限）
  workspace/  パス境界制御、機密ファイルポリシー、検索、git
  tunnel/     TunnelProvider 抽象化 + Cloudflare Quick Tunnel
  execution/  レビューサイクル用の実行記録管理
  process/    デーモンプロセスのライフサイクル
  cli/        c2c コマンドラインツール
skill/        Codex Skill 定義ファイル
tests/        単体および統合テストスイート
docs/         各種技術仕様およびドキュメント
```

---

## 免責事項・ライセンス

**非公式のコミュニティプロジェクトです。OpenAI との提携や承認はありません。**

[MIT License](LICENSE) のもとで公開されています。
