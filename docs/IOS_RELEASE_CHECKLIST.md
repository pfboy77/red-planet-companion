# iOS リリース・チェックリスト

アプリ名は `Red Planet Companion`、Bundle IDは `hoshino.redplanetcompanion`。最低対応OSはiOS 17.0を維持します。提出用ビルドは、このプロジェクトのリリース条件として **Xcode 26以上・iOS 26 SDK以上** を必須とし、提出時点のApple要件も所有者が確認します。

## リリース阻害事項

- [ ] `AppViews.swift` の `AppInformation.PRIVACY_POLICY_URL` / `SUPPORT_URL` を実際に公開済みのHTTPSページへ置換する。現在の example.com は提出不可。
- [ ] プライバシーポリシーの運営者名・連絡先・公開日、ストア著作権、レビュー連絡先を確定する。
- [ ] 審査期間中に稼働するマルチプレイサーバーを用意し、[レビュー手順](APP_STORE_METADATA.md) のServer name / WebSocket URL / Authentication / Steps / Expected behaviorを実値で完成させる。
- [ ] 運用主体（利用者のみ／開発者運営）を確定し、App PrivacyとPrivacy Manifestを一致させる。

## Apple Developer / App Store Connect

1. 新しいBundle IDのApp ID、署名・プロビジョニング、アプリレコードを確認・作成する。Bundle ID変更は既存アプリの同一アップデートではないため、旧Bundle IDのインストールからUserDefaults・Keychainを自動引き継げるとは扱わない。旧保存形式の移行は同じアプリの保存領域へアクセスできる場合に限る。
2. SKU、名前、カテゴリ、年齢区分、価格、地域、著作権、公開URLを入力する。
3. iPhone/iPadの実際のネイティブ画面から提出用スクリーンショットを用意する。
4. [IP_RELEASE_CHECKLIST.md](IP_RELEASE_CHECKLIST.md) を確認し、権利証跡がある場合は保管する。
5. 署名付きArchiveを作成してTestFlightへアップロードし、ビルド番号を更新する。
6. App Privacy、輸出コンプライアンス、コンテンツ権利、レビュー連絡先を実際の運用内容に基づいて回答する。

## 自動検証

リポジトリルートから実行。依存関係の再インストールやネットワーク利用は作業環境の承認方針に従ってください。

```bash
npm ci
CI=true npm test -- --watchAll=false
npm run build
(cd server && npm ci && npm test)
(cd protocol && npm ci && npm test)
xcodebuild -version
xcrun --sdk iphoneos --show-sdk-version
bash ios/teraformingmars2/scripts/validate_release_toolchain.sh
xcrun simctl list devices available
xcodebuild -project ios/teraformingmars2/teraformingmars2.xcodeproj \
  -scheme teraformingmars2 -destination 'platform=iOS Simulator,name=iPhone 17 Pro' test
xcodebuild -project ios/teraformingmars2/teraformingmars2.xcodeproj \
  -scheme teraformingmars2 -configuration Release \
  -destination 'generic/platform=iOS' CODE_SIGNING_ALLOWED=NO build
```

シミュレータ名はインストール済みのものに合わせます。CIはXcode 26以降を選択し、SDK要件を検証してから単体/UIテストと署名なしReleaseビルドを実行します。署名なしビルドはApp Storeへのアップロード検証を代替しません。

## Privacy Manifest / 通信

- [ ] `NSPrivacyAccessedAPICategoryUserDefaults` / `CA92.1` を維持する。Swift側の永続設定保存で引き続き使用する。
- [ ] 新しいRequired Reason API使用がないか提出時にソース・依存関係・ArchiveのPrivacy Reportを確認する。今回の追加はUserDefaults、Keychain、Bundleのバージョン読取り、通常の日時とネットワーク処理。
- [ ] `NSPrivacyTracking = false` がSDKとWebサイトを含めて正しいか確認する。
- [ ] `NSPrivacyCollectedDataTypes` は現在空。開発者運営バックエンドを導入するなら必ず再評価する。
- [ ] 日本語の `NSLocalNetworkUsageDescription` を維持する。
- [ ] ATS例外は `NSAllowsLocalNetworking` のみ。全通信を許可する `NSAllowsArbitraryLoads` を追加しない。
- [ ] 実機でLANの `ws://<private-ip>:8080/ws` とインターネットの `wss://` を確認する。裸のNodeプロセスは公開せず、TLSプロキシ・接続/要求制限・ファイアウォールを使用する。

## 実機・TestFlightの手動確認

iPhone実機とiPad（実機または適切なシミュレータ）で確認します。

- [ ] 新規インストールと初回起動にクラッシュがない。
- [ ] ソロ開始、再起動後の状態復元、産出フェーズ、TR変更。
- [ ] リセット、Undo/Redo。
- [ ] 保存データ削除のキャンセルは状態を保持し、確認後の削除は再起動しても復元されない。
- [ ] ローカルネットワーク許可を承認してLAN接続できる。
- [ ] 許可を拒否してもソロを利用できる。
- [ ] LANでルーム作成・参加、2台以上で状態同期。
- [ ] 切断・再接続、バックグラウンド・フォアグラウンド復帰。
- [ ] Privateルームの再接続。
- [ ] サーバーA/Bそれぞれに別のPrivateルームを保存し、A→B→Aと切り替えて両方を再接続できる。
- [ ] B削除後もAへ再接続でき、AのURL変更でAだけが無効になる。
- [ ] 到達不能な前回サーバーから、再試行／キャンセル／確認付きの端末内再接続情報破棄→ソロ開始。
- [ ] About画面にアプリ名、バージョン、免責、ライセンスが表示される。
- [ ] ホームから3タップ以内でプライバシーページが開き、サポートページも正しく開く。
- [ ] 新しいボタンとリンクのVoiceOver読み上げ・フォーカス順。
- [ ] 回転時とiPhone/iPadのレイアウト、キーボード表示中の操作。
- [ ] TestFlight版で起動、署名、Keychain、ネットワーク、リンクを確認。
- [ ] プロダクションのURL、メタデータ、ポリシーにプレースホルダーが残っていない。

ローカル削除は遠隔サーバーのデータを消去しません。参照サーバーの保持期限は既定30日で、起動時と新規セッション作成時に掃除します。所有者による公開、署名、アップロード、審査提出は別工程です。
