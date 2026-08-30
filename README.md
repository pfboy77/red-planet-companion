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
- Responsive web UI
- Local network multiplayer resource sharing

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

同じ Wi-Fi / ローカルネットワーク上のプレイヤーと、資源・産出量・TRをリアルタイムで共有できます。ゲーム状態はホストPC上のローカルサーバーだけに保存され、外部クラウドサービスは使用しません。

1. ホストPCで、サーバー用ターミナルを開いて起動します。起動後も、このターミナルは閉じずに開いたままにします。

   ```bash
   cd server
   npm ci
   npm start
   ```

   `Red Planet local server listening on ws://0.0.0.0:8080/ws` と表示されれば準備完了です。

2. 別のターミナルでWebアプリを起動します。

   ```bash
   npm start
   ```

   ブラウザで `http://localhost:3000` を開き、「Local multiplayer」欄にプレイヤー名を入力します。通常は **Friends**（信頼できる同じ場所・LAN向け）を選び、**Create game** を押します。共有 Wi-Fi など再接続時の本人確認を強めたい場合は **Private** を選びます。どちらもパスワード入力は不要です。ホストPCでの Server URL は `ws://localhost:8080/ws` のままで構いません。

3. 表示された **Session ID** と **Join code** を、ほかのプレイヤーに共有します。

4. 参加者は、別の端末またはプライベートブラウズウインドウでWebアプリを開き、名前・Session ID・Join codeを入力して **Join game** を選びます。別端末から参加する場合は、Server URL をホストPCのLAN IPアドレスに変更します。

   ```text
   ws://192.168.1.20:8080/ws
   ```

   ホストPCのIPアドレスは、macOSでは「システム設定」→「Wi-Fi」→「詳細」→「TCP/IP」で確認できます。

接続後は、各自が自分の資源を操作でき、画面下部の **Other players’ resources** で他プレイヤーの接続状態、TR、資源量、産出量を確認できます。同じ通常ブラウザの別タブは同じプレイヤーとして扱われ、後から接続したタブが以前の接続を置き換えます。別プレイヤーとして検証する場合は、別ブラウザまたはプライベートウインドウを使用してください。

Friends はブラウザ/iOSが保持する端末 ID で簡易再接続します。Private はサーバーが発行したプレイヤー専用 resume token をクライアントが自動保存して使います。token の入力や共有は不要で、他プレイヤーの snapshot に token や `clientId` は含まれません。切断時は接続状態が表示され、再接続が完了するまで操作は送信されません。

自分だけ退出する場合は **Leave game** を選びます。単なる回線切断では再接続情報が保持されますが、Leave gameではサーバー上のプレイヤー情報と再接続情報が削除され、同じ端末から再参加すると新しいプレイヤーになります。サーバー全体を終了する場合は、サーバー用ターミナルで `Ctrl+C` を押してください。

### iOS

```bash
open ios/teraformingmars2/teraformingmars2.xcodeproj
```

XcodeでiOSアプリを起動した後、ホーム画面のローカルマルチプレイ欄にサーバーURLとプレイヤー名を入力します。作成時は Friends / Private を選択できます。ホストPC上で実行する場合は `ws://<ホストPCのLAN IP>:8080/ws` を指定します。iPhone上の `localhost` はホストPCではなくiPhone自身を指すため使用できません。Web版と同じ Session ID / Join code で参加でき、自分の資源操作はサーバーへ送信されます。Private の resume token は Keychain へ自動保存され、ユーザー入力は不要です。退出後はマルチプレイ参加前のローカルゲーム状態へ戻ります。

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
