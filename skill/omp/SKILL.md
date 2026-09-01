---
name: codex-with-chatgpt
description: OMPでChatGPT Webを計画・レビュー担当として使い、実装はOMP側で行う
---

# Codex with ChatGPT（OMP版）

ChatGPT が考え、OMP が実装する。
この Skill は GitHub の `XiaoDuoYa/codex-with-chatgpt` を OMP から使うための適応層です。

## 固定境界

- ChatGPT は接続中のワークスペースを C2C の read-only MCP で読むだけです。
- ChatGPT への制御メッセージにファイル本文、diff、ログを貼りません。
- ChatGPT にファイル編集、テスト、build、lint、format、install、依存関係変更、Git 状態変更、ネットワーク通信をさせません。
- OMP が編集、テスト、build、依存関係変更、Git 操作、最終統合、最終検証を担当します。
- 通常経路は `TOKEN_SAVING` / `L1_READ_ONLY` です。探索、長文読解、設計、根本原因分析、レビュー、要約に使います。
- OMPのグローバル自動ルーティングが重い依頼を検出するため、通常利用でユーザーに `/chatgpt` を入力させません。
- 状態確認が必要なときだけ `L2_DIAGNOSTIC_COMMANDS` と明記し、`git_status`、`git_diff`、`test_status`、`execution_summary` などの read-only MCP ツールに限定します。
- L3 以上の経路は使いません。C2C サーバーに書き込み・実行ツールはありません。

## 固定パスと実行

- C2C の正本: `/Users/arica/Data/OMP/codex-with-chatgpt`
- OMP 用 CLI: `/Users/arica/Data/OMP/codex-with-chatgpt/scripts/omp-c2c.sh`
- OMP配下の通常C2Cワークスペースは `/Users/arica/Data/OMP` に固定します。現在のcwdやサブプロジェクトディレクトリを `-w` に渡しません。ユーザーが明示的に「このプロジェクトだけを見せる」と指定した場合だけ、サブディレクトリをworkspaceにします。
- `omp-c2c.sh` は PATH の Node.js を優先し、無ければ ChatGPT アプリ同梱 Node.js を使います。
- upstream の Codex 用 `sandbox-allow` は OMP の `~/.codex/config.toml` を変更しないよう、C2C 状態ディレクトリ内の隔離設定へ向けています。
- C2C のブラウザ操作は `c2c-chatgpt-chrome`（Chrome for Testing、CDP `http://127.0.0.1:9227`、永続プロファイル）に接続します。ユーザーの通常Chromeへ `app.relay` 接続しません。
- Cloudflare Quick Tunnelを既定とし、固定ドメインはユーザーが明示的に選んだ場合だけ設定します。選択状態はOSのC2C状態ディレクトリに保存し、プロジェクトへ資格情報を置きません。

## セッション排他

同じworkspaceのChatGPT会話、保存済み会話URL、実行摘要、Bridge復旧状態は共有状態です。
ブラウザを使う前に、正規workspaceのセッション排他を取得します。

```sh
/Users/arica/Data/OMP/codex-with-chatgpt/scripts/omp-c2c.sh session lock acquire \
  -w /Users/arica/Data/OMP --task <task_id> --json
```

返された`token`はエージェント内部だけで保持し、workspaceを変更するすべてのCLIへ
`--lock-token <token>`を渡します。
対象は`setup`、`start`、`restart`、`stop`、修復を行う`doctor`、`pair`、`unpair`、
`tunnel choose`、`tunnel login`、`session set`、`session clear`、`record`です。
`status`、`session get`、`session lock status`、`doctor --no-fix`は読み取り専用なので排他を要しません。

タスクが長引く場合は、次の反復へ進む前に排他を更新します。

```sh
/Users/arica/Data/OMP/codex-with-chatgpt/scripts/omp-c2c.sh session lock refresh \
  -w /Users/arica/Data/OMP --token <token> --json
```

通常ループが終了したら、成功、失敗、ユーザー待ちのいずれでも排他を解放します。
取得結果が`busy`なら、他タスクのtokenを使わず、表示されたtaskの完了を待ちます。

```sh
/Users/arica/Data/OMP/codex-with-chatgpt/scripts/omp-c2c.sh session lock release \
  -w /Users/arica/Data/OMP --token <token> --json
```

## endpoint・connector・session の契約

`observed`はBridgeの観測値であり、Connectorの確定値ではありません。
`connectorBound`は`connector commit`だけが更新し、URL変更時は
`generation`と`fingerprint`を持つ`pendingRepair`を作ります。
`doctor --json`の`status`は`ok`、`pending`、`blocked`のいずれかです。
`--no-fix`ではpendingでも`exitCode: 0`になり得るため、`status`とrepair項目を確認します。

通常ループで`setup`や`pair`を呼びません。
`setup`は初回設定または明示的な全再初期化だけに使い、`pair`は明示的な再認可だけに使います。
PairingManagerの既定TTLは30分です。配対コードは5回の試行上限、一回限り、メモリ内保持を維持します。
`setup`の出力にコードが含まれていても、先に`doctor --no-fix --json`で診断し、Connector作成前には保存・入力しません。
Connector作成後、OAuth popup直前に同じtokenで`doctor --json`（修復あり）を実行し、返されたコードを直ちに入力します。既存の有効な配対セッションなら`pairingReused: true`で同じコードを返し、期限切れなら新規コードを発行します。

Connectorを再作成した場合は、新しい会話で`@`から現行Connectorを選び、
Boot Promptと`workspace_info`を完了してから、doctorが示した値で次を実行します。

```sh
/Users/arica/Data/OMP/codex-with-chatgpt/scripts/omp-c2c.sh connector commit \
  -w /Users/arica/Data/OMP --generation <generation> \
  --fingerprint <fingerprint> --url <conversation-url> \
  --lock-token <token> --json
```

`commit`前の`session set`は禁止です。
`session get --json`が`usable: true`を返すことを確認してからC2Cを再開します。
旧endpoint stateはversion 2の未bind `legacy_state`へ正規化され、旧会話は再利用しません。
DCRはtrim済みclient名と重複除去・ソート済みredirect URIのfingerprintで再登録を収束させ、
旧重複clientはcanonical clientを残してtokenごと退役させます。


## 初回設定

0. `session lock acquire`を実行し、返された`token`を作業中だけ保持します。

   ```sh
   /Users/arica/Data/OMP/codex-with-chatgpt/scripts/omp-c2c.sh session lock acquire \
     -w /Users/arica/Data/OMP --task <task_id> --json
   ```

1. まず接続方式を確認します。

   ```sh
   /Users/arica/Data/OMP/codex-with-chatgpt/scripts/omp-c2c.sh tunnel status -w /Users/arica/Data/OMP --json
   ```

   `needsChoice` が true の場合、OMPではユーザーが固定ドメインを明示的に求めていない限り、次を実行してQuick Tunnelを選びます。

   ```sh
   /Users/arica/Data/OMP/codex-with-chatgpt/scripts/omp-c2c.sh tunnel choose \
     -w /Users/arica/Data/OMP --mode quick --json --lock-token <token>
   ```

   ユーザーが固定ドメインを明示的に選び、Cloudflare上のドメインを提示した場合だけ、次を実行します。

   ```sh
   /Users/arica/Data/OMP/codex-with-chatgpt/scripts/omp-c2c.sh tunnel login \
     -w /Users/arica/Data/OMP --json --lock-token <token>
   /Users/arica/Data/OMP/codex-with-chatgpt/scripts/omp-c2c.sh tunnel choose \
     -w /Users/arica/Data/OMP --mode named --zone <domain> --json --lock-token <token>
   ```

   ブラウザのログイン、CAPTCHA、2FAは一動作ずつ依頼し、失敗時はQuick Tunnelへ戻します。

2. 次を実行します。

   ```sh
   /Users/arica/Data/OMP/codex-with-chatgpt/scripts/omp-c2c.sh setup \
     -w /Users/arica/Data/OMP --json --lock-token <token>
   ```

3. `setup`出力から`connectorName`、`mcpUrl`、`endpoint.generation`、`endpoint.fingerprint`を取得します。出力される`pairingCode`、`pairingExpiresAt`、`pairingReused`は、この時点では保存・入力しません。
   まず`doctor --no-fix --json`を実行してBridge、MCP、Tunnel、repair状態を診断します。`--no-fix`の結果だけでChatGPTへコードを入力したり、修復を開始したりしません。
   OMPの`browser`で専用Chromeを使い、次の順序で対象ワークスペースの`connectorName`だけを作成または更新します。
   - 開発者モード: `https://chatgpt.com/#settings/Security`
   - 接続管理: `https://chatgpt.com/plugins`
   - 新規接続: `https://chatgpt.com/plugins#settings/Connectors?create-connector=true&redirectAfter=%2Fplugins`
   - OAuthを選び、`mcpUrl`を入力します。Connectorの作成または再作成が完了するまではOAuth popupを開きません。
4. Connector作成後、OAuth popupを開く直前に、同じ`--lock-token <token>`で`doctor --json`（修復あり）を一度だけ実行します。出力の`chatgptRepair.pairingCode`と`pairingExpiresAt`を確認し、そのコードを直ちにpopupへ入力します。コードを待機したり、Connector作成前に取得したコードを使ったりしません。
5. 同じタブで`https://chatgpt.com/`を開き、`docs/protocol.md`のBoot Promptを送ります。
6. 続けて対象connectorで`workspace_info`を呼び、トップレベルの説明用ファイルを読ませます。
7. `workspace_info`成功後、ブラウザのアドレスバーの会話URLを使ってbindingと会話を同時に確定します。

   ```sh
   /Users/arica/Data/OMP/codex-with-chatgpt/scripts/omp-c2c.sh connector commit \
     -w /Users/arica/Data/OMP --generation <generation> \
     --fingerprint <fingerprint> --url <conversation-url> \
     --lock-token <token> --json
   ```

   `commit`前に`session set`を実行せず、`session get --json`の`usable: true`を確認します。

ログイン、CAPTCHA、2FA が出たときだけユーザーに一動作を依頼します。
ブラウザ操作やユーザー待ちが長引く場合は、`session lock refresh`を実行してから続行します。
自動ルーティングから初回設定を呼び出す場合も、この手順をOMP内部で実行し、ユーザーに `/chatgpt-setup` の入力を求めません。
接続名が別ワークスペースのものなら変更・削除しません。

## 通常の依頼ループ

自動ルーティングはユーザーの入力をそのまま依頼として受け取り、以下をOMP内部で実行します。

1. まず正規ワークスペース `/Users/arica/Data/OMP` の `status`、`session get`、`tunnel status --json`、`doctor --no-fix --json`を確認します。`session get`の`usable: true`、doctorの`status: "ok"`、Bridgeの`tokenCount`、`report.bridge.ok`、`report.mcp.ok`、`report.tunnel.ok`が揃う場合だけ、既存のconnector、OAuthトークン、会話を再利用します。通常タスクで`setup`や`pair`を呼びません。
2. 読み取り専用の確認後、`session lock acquire`で正規ワークスペースの排他を取得します。取得結果が`busy`なら他タスクのtokenを使わず、表示されたtaskの完了を待ちます。排他取得後に、次の操作とブラウザ操作を終了まで同じtokenで行います。
3. 排他取得後に接続方式を再確認します。`needsChoice`がtrueなら、固定ドメインを明示的に選ばれていない限り`session lock`のtokenを付けてQuick Tunnelを選びます。固定ドメインを明示的に選ばれた場合だけ、Cloudflareログインと`named`選択を行います。
4. `doctor --no-fix --json`の結果は診断として扱い、pairing codeは取得・入力しません。BridgeまたはTunnelが未稼働なら、同じlock tokenで`setup`または`start`を実行して前提を復旧し、`doctor --no-fix --json`を再実行します。Connector作成前に修復モードのdoctorを実行しません。

   `status: "pending"`は`exitCode: 0`でも未完了です。`status: "ok"`と`report.bridge.ok`、`report.mcp.ok`、`report.tunnel.ok`が揃うまでChatGPTに送信しません。
5. `chatgptRepair.needed`がtrueなら、`chatgptRepair.userMessage`を伝え、対象Connectorだけを削除して同じ名前で新URLへ作り直します。古いURLへのReconnectや編集はしません。Connectorの作成または再作成が完了した後、OAuth popupを開く直前に同じ`--lock-token <token>`で`doctor --json`（修復あり）を一度だけ実行し、出力の`chatgptRepair.pairingCode`と`pairingExpiresAt`を確認して直ちに入力します。Connector作成前に取得したコードを使ったり、コードを待機したりしません。再作成でアプリ識別子が変わるため、保存済みの古い会話を開かず、新しい会話で`@`から現行connectorを選び、Boot Promptと`workspace_info`を完了します。doctorが示した`generation`と`fingerprint`を使って、次の順でbindingと会話を確定します。

   ```sh
   /Users/arica/Data/OMP/codex-with-chatgpt/scripts/omp-c2c.sh connector commit \
     -w /Users/arica/Data/OMP --generation <generation> \
     --fingerprint <fingerprint> --url <conversation-url> \
     --lock-token <token> --json
   ```

   `commit`前に`session set`を実行せず、`session get --json`の`usable: true`を確認してからC2C制御メッセージを送信します。
6. `[C2C] STATE: INIT`に、ユーザーの目的を一段落で記載して送ります。ファイル内容は送らず、ChatGPTにMCPで必要箇所を読ませます。
7. ChatGPTの`STATE: PLAN`を待ち、`RATIONALE`、ファイル単位の変更案、リスク、テスト、`SUCCESS_CRITERIA`を確認します。一行だけの計画なら一度だけ具体化を求めます。
8. 計画をOMPのツールで実行します。ChatGPTの計画を理由に編集・検証を省略しません。
9. 実行後、次の摘要記録を同じtokenで行います。

   ```sh
   /Users/arica/Data/OMP/codex-with-chatgpt/scripts/omp-c2c.sh record \
     -w /Users/arica/Data/OMP --task <task_id> --iteration <n> \
     --changed-files "src/a.ts,src/b.ts" --tests "27 passed" \
     --exit-status ok --lock-token <token>
   ```

10. 同じ会話へ`[C2C] STATE: EXECUTED`を送り、ChatGPTにMCP経由の独立レビューを求めます。diff、ログ、ファイル本文は送信しません。長い反復の前には`session lock refresh --token <token>`を実行します。
11. `DONE`なら終了し、`PLAN`なら次の反復だけ実行します。`BLOCKED`ならOMPで解消できるものを先に処理し、ユーザー判断が必要な一件だけを返します。
12. 会話状態を各反復後に更新するときは、現在のbindingの`generation`と`fingerprint`を付けて`session set`を実行します。通常ループが終了したら、成功、失敗、ユーザー待ちのいずれでも`session lock release --token <token>`を実行します。ユーザー待ちから再開するときは、読み取り専用確認後に新しい排他を取得します。

配対コード（`XXXX-XXXX`）はChatGPTのログインOAuthコードではなく、connector初回認可用の一回限りのローカル確認コードです。通常タスクで認証画面が再表示されたら、入力を促す前にconnector名、公開URL、保存済み会話、Bridgeのトークン状態を確認します。

## OMP コマンド

通常の重い依頼はOMPのグローバル自動ルーティングが上記のC2Cループへ送るため、ユーザーは `/chatgpt` を入力しません。

- `/chatgpt <依頼>`: 自動判定を待たずに `TOKEN_SAVING` / `L1_READ_ONLY` で強制委譲します。
- `/chatgpt-diagnostic <依頼>`: `L2_DIAGNOSTIC_COMMANDS` と明記し、状態・diff・実行摘要だけをレビューさせます。
- `/chatgpt-setup`: OMPの正規ワークスペース `/Users/arica/Data/OMP` の初回設定または接続復旧を実行します。
- 固定ドメインを明示的に選ぶ場合だけ、`tunnel login` と `tunnel choose --mode named --zone <domain>` を実行します。

## 復旧

- ブリッジ停止: `omp-c2c.sh stop -w /Users/arica/Data/OMP --lock-token <token>`。
- Quick TunnelのURLが変わった: まず`omp-c2c.sh doctor -w /Users/arica/Data/OMP --no-fix --json`で診断し、対象Connectorだけを同じ名前で新URLへ作り直します。古いURLへReconnectや編集はしません。Connector作成後、OAuth popup直前に同じ`--lock-token <token>`で`omp-c2c.sh doctor -w /Users/arica/Data/OMP --json`（修復あり）を実行し、`chatgptRepair.pairingCode`を直ちに入力します。その後、新しい会話で`@`から現行connectorを選び、Boot Promptと`workspace_info`を完了し、doctorが示す`generation`と`fingerprint`で`connector commit --generation <generation> --fingerprint <fingerprint> --url <conversation-url> --lock-token <token>`を実行して`session get --json`の`usable: true`を確認してから再開します。
- 固定ドメインのnamed tunnelが停止した: `namedRepair`のメッセージに従い、Cloudflareへログインして`omp-c2c.sh tunnel login -w /Users/arica/Data/OMP --json --lock-token <token>`とdoctorを再実行します。Connectorは削除しません。
- 配対コード期限切れ: Connector作成後、OAuth popup直前に同じ`--lock-token <token>`で`omp-c2c.sh doctor -w /Users/arica/Data/OMP --json`（修復あり）を実行してactiveまたは新規コードを取得し、直ちに入力します。`pair`は明示的な再認可だけに使います。
- 接続を切る: `omp-c2c.sh unpair -w /Users/arica/Data/OMP --lock-token <token>`。

- ChatGPT の会話はワークスペースごとに一つだけ再利用します。通常の会話切り替えは `HANDOFF` で行い、Connector再作成後はアプリの識別子が変わるため新規会話へ切り替えます。
