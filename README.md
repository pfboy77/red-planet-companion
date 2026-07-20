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
│     └── terformingmars2/         # iOS SwiftUI アプリ
│           ├── terformingmars2.xcodeproj/
│           ├── terformingmars2/   # Swift ソース
│           ├── terformingmars2Tests/
│           └── terformingmars2UITests/
├── protocol/
│     ├── schemas/                 # 共通JSON Schema
│     └── fixtures/                # 検証用フィクスチャ
├── server/                        # ローカルマルチプレイサーバー（次フェーズ）
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
- Browser localStorage and iOS UserDefaults persistence
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
   npm start
   ```

   `Red Planet local server listening on ws://0.0.0.0:8080/ws` と表示されれば準備完了です。

2. 別のターミナルでWebアプリを起動します。

   ```bash
   npm start
   ```

   ブラウザで `http://localhost:3000` を開き、「Local multiplayer」欄にプレイヤー名を入力して **Create game** を選びます。ホストPCでの Server URL は `ws://localhost:8080/ws` のままで構いません。

3. 表示された **Session ID** と **Join code** を、ほかのプレイヤーに共有します。

4. 参加者は、別の端末またはプライベートブラウズウインドウでWebアプリを開き、名前・Session ID・Join codeを入力して **Join game** を選びます。別端末から参加する場合は、Server URL をホストPCのLAN IPアドレスに変更します。

   ```text
   ws://192.168.1.20:8080/ws
   ```

   ホストPCのIPアドレスは、macOSでは「システム設定」→「Wi-Fi」→「詳細」→「TCP/IP」で確認できます。

接続後は、各自が自分の資源を操作でき、画面下部の **Other players’ resources** で他プレイヤーの接続状態、TR、資源量、産出量を確認できます。同じ通常ブラウザの別タブは同じプレイヤーとして扱われるため、検証時も別ブラウザまたはプライベートウインドウを使用してください。

自分だけ退出する場合は **Leave game** を選びます。サーバー全体を終了する場合は、サーバー用ターミナルで `Ctrl+C` を押してください。

### iOS

```bash
open ios/teraformingmars2/teraformingmars2.xcodeproj
```

## Project Goal

This project explores maintainable cross-platform architecture for turn-based strategy game companion tools.

## Roadmap

- Improve UI/UX
- Add save/load improvements
- Refactor game logic into reusable modules
- Connect the iOS client to the shared multiplayer protocol

## Contributing

Issues and pull requests are welcome.

## Disclaimer

This project is an unofficial fan-made application for educational and non-commercial purposes.

## License

MIT
