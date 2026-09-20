# Red Planet Companion

Red Planet Companion is a fan-made strategy board game companion with React/TypeScript and native SwiftUI clients.

## Demo

[Live Web Demo](https://mars-azure-beta.vercel.app/)

## Screenshot

![Red Planet Companion screenshot](docs/images/screenshot.png)

## Project Structure

```
red-planet-companion/
├── src/                           # Web版 (React/TypeScript)
├── ios/
│     └── teraformingmars2/         # iOS SwiftUI アプリ
│           ├── teraformingmars2.xcodeproj/
│           ├── Domain/             # Swift ドメイン層
│           ├── teraformingmars2Tests/
│           └── teraformingmars2UITests/
├── protocol/
│     ├── schemas/                 # 共通JSON Schema
│     └── fixtures/                # 検証用フィクスチャ
├── server/                        # ローカルマルチプレイ WebSocket サーバー
│     ├── src/
│     └── test/
├── docs/                          # ドキュメント
│     ├── NATIVE_IOS_BASELINE.md
│     └── ...
└── README.md
```

## Features

- Single-player resource management
- Terraform Rating tracking
- Resource production phase
- Undo / redo support
- Browser localStorage and iOS local-state persistence (Private resume token is stored in Keychain)
- Multiple saved multiplayer server profiles on Web and iOS
- Responsive web UI
- LAN or WSS multiplayer resource sharing with SQLite server persistence

## Tech Stack

### Web (src/)
- React 19
- TypeScript 4.9
- Create React App 5

### iOS (ios/teraformingmars2/)
- SwiftUI
- Swift 5
- iOS 17.0+

### Protocol
- JSON Schema Draft-07
- Ajv validation

## Getting Started

### Web

```bash
npm install
npm start
```

Open http://localhost:3000 in your browser.

### ローカルマルチプレイ

同じ Wi-Fi / ローカルネットワーク上のプレイヤーと、資源・産出量・TRをリアルタイムで共有できます。ゲーム状態の正本はホストPC上のSQLite DBで、外部クラウドサービスは使用しません。プロセスやPCを再起動しても、明示的に退出していないセッションは再接続できます。

1. ホストPCで、サーバー用ターミナルを開いて起動します。起動後も、このターミナルは閉じずに開いたままにします。

   ```bash
   cd server
   npm ci
   npm start
   ```

   `Red Planet server listening on ws://0.0.0.0:8080/ws` と表示されれば準備完了です。

   DBの既定保存先は `server/data/red-planet.sqlite3` です。保存先や表示名は環境変数で変更できます。

   ```bash
   DB_PATH=/var/lib/red-planet/red-planet.sqlite3 SERVER_NAME="Home Red Planet Server" npm start
   ```

2. 別のターミナルでWebアプリを起動します。

   ```bash
   npm start
   ```

   ブラウザで `http://localhost:3000` を開き、**Manage servers** から接続先を登録・選択してプレイヤー名を入力します。初回は `Local Server`（`ws://localhost:8080/ws`）が登録されています。通常は **Friends**（信頼できる同じ場所・LAN向け）を選び、**Create game** を押します。共有 Wi-Fi など再接続時の本人確認を強めたい場合は **Private** を選びます。どちらもパスワード入力は不要です。

3. 表示された **Session ID** と **Join code** を、ほかのプレイヤーに共有します。

4. 参加者は、別の端末またはプライベートブラウズウインドウでWebアプリを開き、**Manage servers** からホストPCのLAN IPアドレスを登録します。そのサーバーを選択し、名前・Session ID・Join codeを入力して **Join game** を選びます。

   ```text
   ws://192.168.1.20:8080/ws
   ```

   ホストPCのIPアドレスは、macOSでは「システム設定」→「Wi-Fi」→「詳細」→「TCP/IP」で確認できます。

接続後は、各自が自分の資源を操作でき、画面下部の **Other players’ resources** で他プレイヤーの接続状態、TR、資源量、産出量を確認できます。同じ通常ブラウザの別タブは同じプレイヤーとして扱われ、後から接続したタブが以前の接続を置き換えます。置き換えられたタブは自動再接続を停止し、必要な場合だけ **Reconnect here** で接続を取り戻せます。別プレイヤーとして検証する場合は、別ブラウザまたはプライベートウインドウを使用してください。

Friends はブラウザ/iOSが保持する端末 ID で簡易再接続します。Private はサーバーが発行したプレイヤー専用 resume token をクライアントが自動保存して使います。token の入力や共有は不要で、他プレイヤーの snapshot に token や `clientId` は含まれません。切断時は接続状態が表示され、再接続が完了するまで操作は送信されません。

自分だけ退出する場合は **Leave game** を選びます。単なる回線切断では再接続情報が保持されますが、Leave gameではサーバーの退出確認を受信してから端末上の再接続情報を削除します。確認できなかった場合は再試行できるよう情報を保持します。正常に退出した後、同じ端末から再参加すると新しいプレイヤーになります。サーバー全体を終了する場合は、サーバー用ターミナルで `Ctrl+C` を押してください。

### iOS

```bash
open ios/teraformingmars2/teraformingmars2.xcodeproj
```

XcodeでiOSアプリを起動した後、ホーム画面の **サーバーを管理** から接続先を追加・編集・削除・選択します。作成時は Friends / Private を選択できます。ホストPC上で実行する場合は `ws://<ホストPCのLAN IP>:8080/ws` を登録します。iPhone上の `localhost` はホストPCではなくiPhone自身を指すため使用できません。Web版と同じ Session ID / Join code で参加でき、自分の資源操作はサーバーへ送信されます。Private の resume token はKeychainへ自動保存され、選択中のサーバーと一致する場合だけ使用されます。退出後はマルチプレイ参加前のローカルゲーム状態へ戻ります。

### Server persistence

サーバーは以下のマルチプレイ情報をSQLiteへ保存します。

- sessions / players / TR
- resources / production
- Friends reconnect identities
- Private resume tokenのSHA-256 hash
- 処理済みaction ID（セッションごとに最新1000件）

raw Private resume tokenとWebSocket接続自体は保存しません。ソロプレイの保存方式は従来どおり各端末ローカルです。`GET /health` は `status`、永続 `serverId`、`serverName`、`protocolVersion` を返し、DB pathやcredentialは返しません。

iOS版の提出準備と実機確認手順は [iOSリリース・チェックリスト](docs/IOS_RELEASE_CHECKLIST.md) を参照してください。

## Project Goal

This project explores maintainable cross-platform architecture for turn-based strategy game companion tools.

## Roadmap

- Improve UI/UX
- Add save/load improvements
- Refactor game logic into reusable modules
- Add TestFlight feedback and improve local multiplayer onboarding

## Contributing

Issues and pull requests are welcome.

## Disclaimer

This project is an unofficial fan-made application for educational and non-commercial purposes.

## License

MIT
