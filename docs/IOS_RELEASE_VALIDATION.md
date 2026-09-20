# iOS release readiness 実装・検証記録

検証日: 2026-09-21 / 対象ブランチ: `codex/feature/server-registry-and-persistence`。
ローカル実装と検証の記録です。App Store提出完了や承認を示すものではありません。

## Implemented

- Debug/ReleaseおよびテストのBundle IDを `hoshino.redplanetcompanion` 系へ変更。表示用Bundle名もRed Planet Companionに統一し、ソース・scheme名を維持。
- iOSの再接続メタデータとKeychainトークンをサーバープロファイル別に保存。A→B→A、再起動、B削除、AのURL変更を回帰テストで確認。
- 旧形式は接続先を確認してから移行。Keychain書込み失敗時は旧情報を維持。曖昧な移行元URLを固定し、後のサーバー選択を元の接続先と誤認しない。
- 到達不能なサーバーからの退出失敗後に、再試行／キャンセル／確認付きの端末内再接続情報破棄→ソロ開始を追加。遅延応答を防ぐため退出失敗時の接続も終了。
- アプリ所有の保存データ・全Keychain再接続トークンを一括削除するメソッドと確認UIを追加。他コンポーネントのUserDefaultsを保持。
- About画面にバージョン、プライバシー／サポートリンク、MITライセンス、非公式アプリの免責表示を追加。
- サーバーの参加コードを `node:crypto.randomInt` に変更。保持期限に基づく掃除を起動時とセッション作成時に追加。
- プライバシー、審査手順、IP、公開サーバー運用、実機チェックリストを更新。CIでXcode/SDKを検証し、単体・UIテストと署名なしReleaseビルドを実行する構成へ変更。

主な変更ファイル:

- `ios/teraformingmars2/{GameViewModel,ServerProfile,AppViews,ContentView}.swift`
- `ios/teraformingmars2/Info.plist` と `teraformingmars2.xcodeproj/project.pbxproj`
- iOS単体テスト・UIテスト、`scripts/validate_release_toolchain.sh`
- `server/src/session-manager.js`、`server/src/repositories/session-repository.js`、`server/test/retention.test.js`
- `README.md`、`server/README.md`、`.github/workflows/ci.yml`、`.gitignore`
- `docs/{PRIVACY_POLICY,APP_STORE_METADATA,IOS_RELEASE_CHECKLIST,IP_RELEASE_CHECKLIST,IOS_RELEASE_VALIDATION}.md`

## Security / Privacy

Privateトークンのアカウント名は `private-resume-token.<profile UUID>`、サービス名は `red-planet-companion.multiplayer`。KeychainのThisDeviceOnly保護を使います。UserDefaultsには非秘密の再接続メタデータのみを新規保存します。旧トークンの移行成功後に旧キーを消去し、全消去操作では孤立したアカウントも含めサービス全体を消去します。

参照サーバーはSQLiteにゲーム状態・識別情報・重複防止履歴とトークンのSHA-256ハッシュを保存します。保持期限は既定30日、`SESSION_RETENTION_DAYS=0`で無効化でき、接続中セッションは掃除対象外です。外部キー連鎖削除のテストを追加しました。周期タイマーは使用しません。

`PrivacyInfo.xcprivacy` のUserDefaults理由 `CA92.1` と追跡なしの宣言を維持。開発者運営サーバーを導入する場合の収集宣言は所有者による再評価が必要です。

## App Store Readiness

- Bundle ID: `hoshino.redplanetcompanion`。
- About→プライバシー／サポート導線あり。ただし公開URL未確定のため中央定数はexample.comのプレースホルダー。現状のまま提出不可。
- 日本語のローカルネットワーク利用説明と `NSAllowsLocalNetworking` のみのATS例外を維持。許可拒否時の実機確認は未実施。
- 検証環境: Node `v24.17.0`、Xcode `26.6`（17F113）、iOS SDK `26.5`。
- 署名なしiOS Releaseビルド成功。CI自体のGitHub上での実行、署名付きArchive、TestFlightは未実施。

## Tests

以下はリポジトリルートで実行したコマンドです。ログとDerivedDataはgit対象外の `.validation/` に保存しています。

```bash
CI=true npm test -- --watchAll=false
npm run build
(cd server && npm test)
(cd protocol && npm test)
npm exec --no -- tsc --noEmit
bash ios/teraformingmars2/scripts/validate_release_toolchain.sh
xcodebuild -project ios/teraformingmars2/teraformingmars2.xcodeproj \
  -scheme teraformingmars2 \
  -destination 'platform=iOS Simulator,id=DA9DD57A-BD3F-4957-B592-2ABB04A1EC5C' \
  -derivedDataPath .validation/DerivedData -parallel-testing-enabled NO test
xcodebuild -project ios/teraformingmars2/teraformingmars2.xcodeproj \
  -scheme teraformingmars2 \
  -destination 'platform=iOS Simulator,id=84A4F401-8055-472E-888F-4A656A083BE4' \
  -derivedDataPath .validation/iPadDerivedData -parallel-testing-enabled NO test
xcodebuild -project ios/teraformingmars2/teraformingmars2.xcodeproj \
  -scheme teraformingmars2 -configuration Release -destination 'generic/platform=iOS' \
  -derivedDataPath .validation/ReleaseDerivedData CODE_SIGNING_ALLOWED=NO build
node --check server/src/session-manager.js
node --check server/src/repositories/session-repository.js
bash -n ios/teraformingmars2/scripts/validate_release_toolchain.sh
plutil -lint ios/teraformingmars2/Info.plist ios/teraformingmars2/PrivacyInfo.xcprivacy
ruby -e 'require "yaml"; YAML.load_file(".github/workflows/ci.yml"); puts "CI YAML: OK"'
git diff --check
```

| 検証 | 最終結果 |
|---|---|
| Web | 3 suites / 36 tests成功、production build成功、TypeScript成功 |
| Server | 55 tests成功（ローカル待受けのためsandbox外で実行） |
| Protocol | 53 checks成功 |
| iPhone 17 Pro / iOS 26.5 | 単体54 tests、UI7 tests成功 |
| iPad Pro 11-inch (M5) / iOS 26.5 | 最終コードで単体54 tests、UI7 tests成功 |
| iOS Release | BUILD SUCCEEDED |
| Xcode / SDK / 構文 / diff | 成功。ツールチェーン検証はXcode25またはSDK25を拒否し、26/26を受け入れることも確認 |
| npm ci（3プロジェクト） | インストールと外部通信の承認回答待ち。上記Node結果は既存依存関係での検証 |

初回のiOSコンパイル失敗、旧テストの切断回数期待値、UIのキャンセル表示とソロ画面復帰の不具合は修正して再検証しました。初回Serverの13件失敗はsandboxによる127.0.0.1待受け禁止で、権限を得た再実行では55件すべて成功しました。

## Remaining Manual Release Tasks

- 運営者・連絡先を確定してプライバシー／サポートページをHTTPS公開し、中央定数とApp Store Connectへ設定。
- 審査用の稼働サーバーを用意し、レビュー手順を実値で完成させる。
- 新Bundle IDのApp ID・署名・プロビジョニング・アプリレコード、App Privacy、スクリーンショットを確定。
- 実機のLAN許可／拒否、LAN/WSS対戦、VoiceOver、バックグラウンド復帰を確認。
- 署名付きArchive、TestFlight、提出前のIP確認。許諾が必要な素材・名称を使う場合の権利者確認。

## Known Limitations

- 公開URLと審査用サーバーが未確定。App Store提出可能とは判定していません。
- 新Bundle IDは別のアプリ保存領域になるため、旧Bundle IDのUserDefaults・Keychainを自動取得しません。同じ保存領域にある旧形式のみ移行します。
- サーバー保持期限は起動／新規作成時に適用。常時稼働・作成なしでは期限切れデータが次の掃除まで残ります。バックアップとプロキシログは運営者管理です。
- サーバー単体のDDoS対策や接続数制限は追加していません。公開時はプロキシ、TLS、レート制限、ネットワーク制御が必要です。
- 依存関係のクリーンインストール検証は承認が必要です。コミット・pushの状態はGit履歴を参照してください。公開、審査提出は実行していません。
