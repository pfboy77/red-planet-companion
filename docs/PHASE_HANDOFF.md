# Red Planet Companion - Phase Handoff Document

## 概要

| 項目 | 内容 |
|------|------|
| プロジェクト | pfboy77/red-planet-companion |
| 開発支援 | Codex CLI / ローカルLLM / Ollama |
| 開発方針 | 小さな差分、段階実装、テスト優先 |
| 最終指示書 | [NATIVE_IOS_LOCAL_MULTIPLAYER_INSTRUCTIONS.md](/Users/pfboy/Downloads/NATIVE_IOS_LOCAL_MULTIPLAYER_INSTRUCTIONS.md) |
| 作業ディレクトリ | `/Users/pfboy/develop/mars/` |

---

## リポジトリ構造

```
/Users/pfboy/develop/mars/
├── .gitignore
├── README.md
├── docs/
│         └── NATIVE_IOS_BASELINE.md
├── ios/
│         └── terformingmars2/
│              ├── Domain/
│              │     ├── GameModel.swift
│              │     └── GameReducer.swift
│              ├── ContentView.swift
│              ├── terformingmars2App.swift
│              ├── terformingmars2.xcodeproj/
│              ├── terformingmars2Tests/
│              └── terformingmars2UITests/
├── protocol/
│         ├── fixtures/
│         │     └── game-state.json
│         └── schemas/
│               └── PROTOCOL.md
├── public/
├── server/
└── src/
```

---

## Git 状態

```bash
cd /Users/pfboy/develop/mars
git log --oneline
# => 8596fbe Initial commit: iOS SwiftUI project + protocol
```

43 ファイルがコミット済み

---

## Phase 1 完了報告

### 完了した内容

| 項目 | 詳細 |
|------|------|
| **Domain層の分離** | `GameModel.swift` (データモデル) + `GameReducer.swift` (純粋関数) |
| **初期値の統一** | Web版・iOS版ともにTR:20、全資源量・全産出量:0 |
| **テスト追加** | 18テストケース (GameReducer 16 + ViewModel 2) |
| **iOSアーキテクチャ** | `@Observable` ViewModel + accessibilityLabel |
| **プロトコル定義** | `protocol/fixtures/game-state.json` + `protocol/schemas/PROTOCOL.md` |
| **オフライン動作** | UserDefaultsのみ使用 |
| **Undo/Redo** | 実装済み (最大20件) |

### 変更ファイル (Phase 1)

| ファイル | 内容 |
|----------|------|
| `ios/teraformingmars2/Domain/GameModel.swift` | `Resource`, `GameState`, `GameSnapshot` 構造体 |
| `ios/teraformingmars2/Domain/GameReducer.swift` | 純粋関数 (106行) |
| `ios/teraformingmars2/ContentView.swift` | `@Observable` GameViewModel + SwiftUI UI (294行) |
| `ios/teraformingmars2/teraformingmars2Tests/teraformingmars2Tests.swift` | 16テストケース (178行) |
| `protocol/fixtures/game-state.json` | 共通JSONフィクスチャ |
| `protocol/schemas/PROTOCOL.md` | Web+iOS共通仕様 |

### 重要な設計判断

1. **Resource と GameState は Codable + Equatable + Hashable**
     - Unit Test で比較可能
     - UserDefaults 保存可能

2. **GameReducer は純粋関数のみ**
     - 副作用なし
     - UI非依存
     - Web版ロジックと同一のJSON結果を生成

3. **初期値はWeb版と統一**
     - TR:20
     - MC、Steel、Titanium、Plants、Energy、Heatは量・産出量ともに0

---

## Phase 2 実施内容

### 目標
- 保存データへのバージョン番号の実装
- iOSアーキテクチャ文書の作成
- Undo/Redo の実証テスト
- Haptics / Dynamic Type / VoiceOver の強化

### 具体的な作業

#### 2-1. GameModel.swift に version を追加

**現状**: `GameState.version` はあるが `initialResources` の初期化が重複
**変更**: `initialResources` を computed property に変更

```swift
static var initialResources: [Resource] {
     [
        Resource(id: UUID(), name: "MC", amount: 0, production: 0, isMegaCredit: true, isEnergy: false, isHeat: false),
        Resource(id: UUID(), name: "Steel", amount: 0, production: 0, isMegaCredit: false, isEnergy: false, isHeat: false),
        Resource(id: UUID(), name: "Titanium", amount: 0, production: 0, isMegaCredit: false, isEnergy: false, isHeat: false),
        Resource(id: UUID(), name: "Plants", amount: 0, production: 0, isMegaCredit: false, isEnergy: false, isHeat: false),
        Resource(id: UUID(), name: "Energy", amount: 0, production: 0, isMegaCredit: false, isEnergy: true, isHeat: false),
        Resource(id: UUID(), name: "Heat", amount: 0, production: 0, isMegaCredit: false, isEnergy: false, isHeat: true),
     ]
}

static let initial = GameState(version: 1, resources: initialResources, tr: 20)
```

#### 2-2. GameReducer.swift に migration 関数を追加

```swift
func migrateGameState(from data: Data, to targetVersion: Int) -> Data? {
     // Version 1 用: 既存データがあればそのまま返す
    return data
}
```

#### 2-3. ContentView.swift の保存処理を更新

```swift
func savePersistentState() {
    let state = GameState(version: 1, resources: resources, tr: tr)
    if let data = try? JSONEncoder().encode(state) {
        UserDefaults.standard.set(data, forKey: gameStateKey)
     }
}
```

#### 2-4. iOSアーキテクチャ文書を作成

**ファイル**: `docs/IOS_ARCHITECTURE.md`

```markdown
# iOS Architecture

## プロジェクト構成

```
mars/
├── ios/
│        └── terformingmars2/
│             ├── Domain/
│             │     ├── GameModel.swift
│             │     └── GameReducer.swift
│             ├── ContentView.swift
│             ├── terformingmars2App.swift
│             ├── terformingmars2.xcodeproj/
│             ├── terformingmars2Tests/
│             └── terformingmars2UITests/
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
ContentView (UI)
      ↓
GameViewModel (@Observable)
      ↓
GameReducer (Pure Functions)
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
- Web版の fixture と同じ JSON で検証
```

#### 2-5. Unit Test に version テストを追加

`teraformingmars2Tests.swift` に追加:

```swift
@Test func saveAndRestoreVersion() {
    let defaults = UserDefaults.standard
    defaults.removeObject(forKey: "GameStateKey")
    let vm = GameViewModel()
    vm.savePersistentState()
    let data = defaults.data(forKey: "GameStateKey")
    let state = try! JSONDecoder().decode(GameState.self, from: data!)
     #expect(state.version == 1)
}

@Test func initialStateVersionIsOne() {
    let state = createInitialState()
     #expect(state.version == 1)
}
```

---

## 環境情報

| 項目 | 値 |
|------|-----|
| macOS | 26.3.1 |
| Xcode | 26.6 |
| Swift | 6.3.3 |
| iOS デプロイターゲット | 17.0 |
| 最低対応バージョン | iOS 17.0 |
| Device | iPhone + iPad |

---

## 指示書 (NATIVE_IOS_LOCAL_MULTIPLAYER_INSTRUCTIONS.md) 照合

### Phase 1 完了条件

| 必須条件 | 状態 |
|----------|------|
| iOS画面はSwiftUIで実装 | ✅ `ContentView.swift` がSwiftUI |
| ゲームロジックはUIから分離 | ✅ `GameModel.swift` + `GameReducer.swift` |
| iOS版はオフライン単体でも使用可能 | ✅ UserDefaultsのみ |
| ローカルサーバーがなくても通常の資源管理ができる | ✅ そのまま |
| 保存データへバージョン番号を付ける | ⚠️ Phase 2 で追加 |
| すべてのゲーム操作をUndo/Redo可能にする | ✅ 実装済み |
| アクセシビリティを考慮する | ⚠️ Phase 2 で追加 |
| iPhoneとiPadへ対応する | ✅ `TARGETED_DEVICE_FAMILY = "1,2"` |

### 禁止事項 (Phase 1)

| 禁止事項 | 状態 |
|----------|------|
| WKWebViewで表示 | ✅ 使用していない |
| Capacitor/Cordova | ✅ 使用していない |
| Firebase/Supabase | ✅ 使用していない |
| 外部AI API | ✅ 使用していない |

---

## 次回セッションへの引き継ぎ

### 次回やること
1. 上記 Phase 2 の作業をすべて実施
2. 全ファイルを `git add .` して `git commit`
3. iOS Simulator でビルド確認（可能であれば）
4. Phase 3 へ進めるか確認

### 注意点
- プロジェクトパス: `/Users/pfboy/develop/mars/`
- Git リポジトリ: `cd /Users/pfboy/develop/mars && git log --oneline`
- 既存の Web 版 (src/) は変更しない
- iOS 版 (ios/) のみを変更
- ドキュメントは docs/ に追加

### 重要なファイル

| ファイル | 役割 |
|----------|------|
| `ios/teraformingmars2/Domain/GameModel.swift` | ゲームデータモデル |
| `ios/teraformingmars2/Domain/GameReducer.swift` | 純粋関数ゲームロジック |
| `ios/teraformingmars2/ContentView.swift` | SwiftUI UI + ViewModel |
| `protocol/fixtures/game-state.json` | Web+iOS共通JSON |
| `protocol/schemas/PROTOCOL.md` | プロトコル仕様 |

---

*作成日: 2026-07-12*
*次回フェーズ: Phase 2*
