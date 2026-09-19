# iOS Architecture

## プロジェクト構成

```
mars/
├── ios/
│         └── teraformingmars2/
│              ├── Domain/
│              │      ├── GameModel.swift
│              │      └── GameReducer.swift
│              ├── ContentView.swift
│              ├── AppViews.swift
│              ├── GameViewModel.swift
│              ├── teraformingmars2App.swift
│              ├── teraformingmars2.xcodeproj/
│              ├── teraformingmars2Tests/
│              └── teraformingmars2UITests/
├── protocol/
│         ├── schemas/
│         └── fixtures/
├── src/
├── server/
└── docs/
```

## Domain 層

- `GameModel.swift`: データモデル (Resource, GameState)
- `GameReducer.swift`: 純粋関数によるゲームロジック

### 設計原則

1. ゲームロジックは UI に依存しない
2. 全関数は純粋関数 (副作用なし)
3. State は immutable (変更時は常に新しいインスタンス)
4. Undo/Redo はスナップショットベース

## Architecture

```
ContentView / AppViews (UI)
       ↓
GameViewModel (@Observable)
       ↓
GameReducer (Pure Functions) ← MultiplayerClient (WebSocket)
       ↓
UserDefaults (Persistence)
```

## 保存形式

- JSON 形式で UserDefaults に保存
- `version: 1` を含める
- 将来の migration を想定

## テスト

- Unit Test: `GameReducer` の全関数
- UI Test: 基本的な画面表示
- GameReducer、保存、接続待機、競合時の再試行、再接続をUnit Testで検証
- UI Test: 基本的な画面表示と操作導線を検証
