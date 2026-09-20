import SwiftUI
import UIKit

struct HomeView: View {
    var viewModel: GameViewModel
    var enterGame: () -> Void
    @State private var copiedMessage: String?
    @State private var showingServerManager = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text("Red Planet Companion").font(.largeTitle.bold())
                if viewModel.multiplayerSession != nil {
                    SessionInfoCard(viewModel: viewModel, copiedMessage: $copiedMessage, enterGame: enterGame)
                } else {
                    Button("ソロモードを開始") { viewModel.startSoloGame() }
                        .buttonStyle(.borderedProminent)
                        .accessibilityIdentifier("startSoloButton")

                    if viewModel.canResumeSession {
                        Button("前回のルームへ再接続") { viewModel.resumeMultiplayerGame() }
                            .buttonStyle(.bordered)
                            .disabled(viewModel.isConnecting || viewModel.isLeavingMultiplayer)
                            .accessibilityIdentifier("resumeRoomButton")
                        Button(viewModel.isLeavingMultiplayer ? "退出確認中…" : "前回のルームから退出", role: .destructive) {
                            viewModel.leaveMultiplayerGame()
                        }
                        .disabled(viewModel.isLeavingMultiplayer)
                        .accessibilityIdentifier("leaveSavedRoomButton")
                    }

                    connectionForm
                }
                if let error = viewModel.multiplayerError { Text(error).foregroundStyle(.red) }
            }
            .padding()
        }
        .overlay(alignment: .bottom) {
            if let copiedMessage { Text(copiedMessage).padding(10).background(.regularMaterial).clipShape(Capsule()).padding() }
        }
        .sheet(isPresented: $showingServerManager) {
            ServerManagerView(viewModel: viewModel)
        }
    }

    private var connectionForm: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("マルチプレイ").font(.title2.bold())
            Text("登録済みのRed Planetサーバーを選択します。LANでは ws://、インターネット公開時は wss:// を利用できます。")
                .font(.footnote)
                .foregroundStyle(.secondary)
            if viewModel.serverProfiles.isEmpty {
                ContentUnavailableView("サーバーが未登録です", systemImage: "server.rack", description: Text("サーバーを追加してからマルチプレイを開始してください"))
            } else {
                Picker("接続先サーバー", selection: Binding(
                    get: { viewModel.selectedServerID },
                    set: { if let id = $0 { viewModel.selectServerProfile(id: id) } }
                )) {
                    ForEach(viewModel.serverProfiles) { profile in
                        Text(profile.name).tag(Optional(profile.id))
                    }
                }
                .pickerStyle(.menu)
                .disabled(viewModel.isMultiplayerConnected || viewModel.isConnecting || viewModel.isLeavingMultiplayer)
                .accessibilityIdentifier("serverProfilePicker")
                if let selected = viewModel.selectedServerProfile {
                    Text(selected.webSocketURL)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
            }
            Button("サーバーを管理") { showingServerManager = true }
                .buttonStyle(.bordered)
                .accessibilityIdentifier("manageServersButton")
            TextField("プレイヤー名（20文字以内）", text: Bindable(viewModel).displayName)
                .textFieldStyle(.roundedBorder)
                .accessibilityIdentifier("displayNameField")
                .onChange(of: viewModel.displayName) { _, value in
                    if value.count > 20 { viewModel.displayName = String(value.prefix(20)) }
                }
            VStack(alignment: .leading, spacing: 8) {
                Text("ルームを作成").font(.headline)
                Picker("ルームモード", selection: Bindable(viewModel).roomMode) {
                    Text("フレンド").tag(RoomMode.friends)
                    Text("プライベート").tag(RoomMode.private)
                }
                .pickerStyle(.segmented)
                Text(viewModel.roomMode == .friends
                     ? "信頼できる同じ場所・LAN向け。追加パスワードなしで参加できます。"
                     : "再接続用の本人確認情報を端末が自動管理します。入力操作は不要です。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Button("ルームを作成") { viewModel.createMultiplayerGame() }
                    .buttonStyle(.borderedProminent)
                    .disabled(viewModel.isConnecting)
                    .accessibilityIdentifier("createRoomButton")
            }
            Divider()
            VStack(alignment: .leading, spacing: 8) {
                Text("ルームへ参加").font(.headline)
                TextField("Session ID", text: Bindable(viewModel).sessionID)
                    .textInputAutocapitalization(.never).textFieldStyle(.roundedBorder).accessibilityIdentifier("sessionIDField")
                TextField("Join code", text: Bindable(viewModel).joinCode)
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()
                    .textFieldStyle(.roundedBorder)
                    .accessibilityIdentifier("joinCodeField")
                    .onChange(of: viewModel.joinCode) { _, value in
                        let normalized = value.uppercased().filter { $0.isLetter || $0.isNumber }
                        if normalized != value || normalized.count > 6 {
                            viewModel.joinCode = String(normalized.prefix(6))
                        }
                    }
                Button("ルームへ参加") { viewModel.joinMultiplayerGame() }
                    .buttonStyle(.bordered)
                    .disabled(viewModel.isConnecting)
                    .accessibilityIdentifier("joinRoomButton")
            }
            if viewModel.isConnecting {
                HStack { ProgressView(); Text("サーバーへ接続中…") }
                    .font(.footnote)
                    .accessibilityIdentifier("connectionProgress")
            }
        }
    }
}

struct ServerManagerView: View {
    var viewModel: GameViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var editingProfileID: UUID?
    @State private var serverName = ""
    @State private var webSocketURL = ""
    @State private var showingEditor = false
    @State private var pendingDeletion: ServerProfile?

    var body: some View {
        NavigationStack {
            List {
                Section("登録済みサーバー") {
                    if viewModel.serverProfiles.isEmpty {
                        Text("登録済みサーバーはありません")
                            .foregroundStyle(.secondary)
                    }
                    ForEach(viewModel.serverProfiles) { profile in
                        VStack(alignment: .leading, spacing: 8) {
                            HStack {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(profile.name).font(.headline)
                                    Text(profile.webSocketURL).font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                                if profile.id == viewModel.selectedServerID {
                                    Label("選択中", systemImage: "checkmark.circle.fill")
                                        .labelStyle(.titleAndIcon)
                                        .foregroundStyle(.green)
                                }
                            }
                            HStack(spacing: 8) {
                                if profile.id != viewModel.selectedServerID {
                                    Button("選択") { viewModel.selectServerProfile(id: profile.id) }
                                        .buttonStyle(.bordered)
                                }
                                Button("編集") { beginEditing(profile) }
                                    .buttonStyle(.bordered)
                                Button("削除", role: .destructive) { pendingDeletion = profile }
                                    .buttonStyle(.bordered)
                            }
                            .disabled(viewModel.isMultiplayerConnected || viewModel.isConnecting || viewModel.isLeavingMultiplayer)
                        }
                        .padding(.vertical, 4)
                    }
                }
                Section {
                    Button("サーバーを追加", systemImage: "plus") { beginAdding() }
                        .disabled(viewModel.isMultiplayerConnected || viewModel.isConnecting || viewModel.isLeavingMultiplayer)
                        .accessibilityIdentifier("addServerButton")
                }
            }
            .navigationTitle("サーバー管理")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("完了") { dismiss() } }
            }
        }
        .sheet(isPresented: $showingEditor) {
            ServerProfileEditorView(
                title: editingProfileID == nil ? "サーバーを追加" : "サーバーを編集",
                serverName: $serverName,
                webSocketURL: $webSocketURL,
                onSave: {
                    let validationError = viewModel.saveServerProfile(id: editingProfileID, name: serverName, webSocketURL: webSocketURL)
                    if validationError == nil { showingEditor = false }
                    return validationError
                }
            )
        }
        .alert("サーバーを削除", isPresented: Binding(
            get: { pendingDeletion != nil },
            set: { if !$0 { pendingDeletion = nil } }
        ), presenting: pendingDeletion) { profile in
            Button("削除", role: .destructive) {
                viewModel.deleteServerProfile(id: profile.id)
                pendingDeletion = nil
            }
            Button("キャンセル", role: .cancel) { pendingDeletion = nil }
        } message: { profile in
            Text("「\(profile.name)」を削除しますか？")
        }
    }

    private func beginAdding() {
        editingProfileID = nil
        serverName = ""
        webSocketURL = ""
        showingEditor = true
    }

    private func beginEditing(_ profile: ServerProfile) {
        editingProfileID = profile.id
        serverName = profile.name
        webSocketURL = profile.webSocketURL
        showingEditor = true
    }
}

struct ServerProfileEditorView: View {
    let title: String
    @Binding var serverName: String
    @Binding var webSocketURL: String
    let onSave: () -> String?
    @Environment(\.dismiss) private var dismiss
    @State private var validationError: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("サーバー情報") {
                    TextField("サーバー名", text: $serverName)
                        .textContentType(.name)
                        .accessibilityIdentifier("serverNameField")
                    TextField("wss://mars.example.com/ws", text: $webSocketURL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .textContentType(.URL)
                        .keyboardType(.URL)
                        .accessibilityLabel("WebSocket URL")
                        .accessibilityIdentifier("serverURLField")
                    Text("ws:// と wss:// の両方を登録できます。接続確認に失敗しても保存自体は妨げません。")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                if let validationError {
                    Section { Text(validationError).foregroundStyle(.red) }
                }
            }
            .navigationTitle(title)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("キャンセル") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") { validationError = onSave() }
                        .accessibilityIdentifier("saveServerButton")
                }
            }
        }
    }
}

struct SessionInfoCard: View {
    var viewModel: GameViewModel
    @Binding var copiedMessage: String?
    var enterGame: () -> Void

    var body: some View {
        let session = viewModel.multiplayerSession
        VStack(alignment: .leading, spacing: 12) {
            Text(connectionStatus)
                .font(.title2.bold())
                .foregroundStyle(viewModel.isMultiplayerConnected ? .green : .orange)
            Text("プレイヤー名: \(viewModel.displayName)")
            Text("接続状態: \(viewModel.isMultiplayerConnected ? "オンライン" : "再接続が必要")")
            copyRow(title: "Session ID", value: session?.sessionId ?? viewModel.sessionID, identifier: "copySessionIDButton", message: "Session IDをコピーしました")
            copyRow(title: "Join code", value: session?.joinCode ?? viewModel.joinCode, identifier: "copyJoinCodeButton", message: "Join codeをコピーしました")
            Button("ゲーム画面へ", action: enterGame)
                .buttonStyle(.borderedProminent)
                .accessibilityIdentifier("enterGameButton")
            if !viewModel.isMultiplayerConnected {
                Button("再接続") { viewModel.resumeMultiplayerGame() }
                    .buttonStyle(.bordered)
                    .disabled(viewModel.isConnecting)
                    .accessibilityIdentifier("resumeRoomButton")
            }
            Button(viewModel.isLeavingMultiplayer ? "退出確認中…" : "退出", role: .destructive) { viewModel.leaveMultiplayerGame() }
                .disabled(viewModel.isLeavingMultiplayer)
                .accessibilityIdentifier("leaveRoomButton")
        }
        .padding().frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.systemGray6)).clipShape(RoundedRectangle(cornerRadius: 12))
    }

    private var connectionStatus: String {
        switch viewModel.connectionState {
        case .disconnected: "切断"
        case .connecting: "接続中…"
        case .joining: "参加中…"
        case .connected: "接続済み"
        case .reconnecting: "再接続中…"
        }
    }

    private func copyRow(title: String, value: String, identifier: String, message: String) -> some View {
        HStack {
            VStack(alignment: .leading) { Text(title).font(.caption); Text(value).textSelection(.enabled) }
            Spacer()
            Button("コピー") {
                guard !value.isEmpty else { return }
                UIPasteboard.general.string = value
                copiedMessage = message
                DispatchQueue.main.asyncAfter(deadline: .now() + 2) { if copiedMessage == message { copiedMessage = nil } }
            }
            .disabled(value.isEmpty).accessibilityLabel("\(title)をコピー").accessibilityIdentifier(identifier)
        }
    }
}

struct ResourceManagementView: View {
    var viewModel: GameViewModel

    var body: some View {
        Group {
            if viewModel.gameMode == .none {
                ContentUnavailableView("ゲームを開始してください", systemImage: "house", description: Text("ホームでソロモードまたはマルチプレイを開始してください"))
            } else {
                GeometryReader { proxy in
                    let columnCount = proxy.size.width >= 600 ? 3 : 2
                    let columns = Array(repeating: GridItem(.flexible(minimum: 0), spacing: 10), count: columnCount)
                    ScrollView {
                        VStack(spacing: 14) {
                            if viewModel.gameMode == .multiplayer && !viewModel.isMultiplayerConnected {
                                Label("接続が切れています。ホームへ戻って再接続してください。", systemImage: "wifi.exclamationmark")
                                    .font(.footnote)
                                    .foregroundStyle(.orange)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .padding(10)
                                    .background(.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
                                    .accessibilityIdentifier("offlineBanner")
                            }
                            toolbar
                            LazyVGrid(columns: columns, spacing: 10) {
                                ForEach(viewModel.resources) { resource in
                                    ResourceCardView(resource: resource, viewModel: viewModel, compact: columnCount == 3)
                                }
                            }
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 10)
                    }
                    .scrollDismissesKeyboard(.interactively)
                    .accessibilityIdentifier("resourcesScrollView")
                }
            }
        }
    }

    private var toolbar: some View {
        ViewThatFits(in: .horizontal) {
            HStack { historyControls; trControls; actionControls }
            VStack(spacing: 10) { HStack { historyControls; Spacer(); trControls }; actionControls }
        }.frame(maxWidth: .infinity)
    }
    private var historyControls: some View {
        HStack { Button("↩︎") { viewModel.undo() }.disabled(!viewModel.canUndo).accessibilityLabel("Undo"); Button("↪︎") { viewModel.redo() }.disabled(!viewModel.canRedo).accessibilityLabel("Redo") }.buttonStyle(.bordered)
    }
    private var trControls: some View {
        HStack { Text("TR: \(viewModel.tr)").font(.headline).accessibilityLabel("Terraform Rating \(viewModel.tr)"); Button("−") { viewModel.decrementTR() }.accessibilityLabel("Decrease TR"); Button("+") { viewModel.incrementTR() }.accessibilityLabel("Increase TR") }.buttonStyle(.bordered).disabled(!viewModel.multiplayerControlsEnabled)
    }
    private var actionControls: some View {
        HStack { Button("リセット", role: .destructive) { viewModel.resetGame() }.accessibilityLabel("Reset all resources"); Button("▶︎ 産出") { viewModel.executeProduction() }.buttonStyle(.borderedProminent).accessibilityLabel("Production phase") }.disabled(!viewModel.multiplayerControlsEnabled)
    }
}

struct ResourceCardView: View {
    let resource: Resource
    var viewModel: GameViewModel
    var compact = false
    var body: some View {
        VStack(alignment: .leading, spacing: compact ? 5 : 8) {
            Text(resource.name).font(.headline).accessibilityLabel(resource.name)
            Text("資源: \(resource.amount)").accessibilityLabel("\(resource.name) \(resource.amount)")
            HStack {
                TextField("±", text: Binding(get: { let value = viewModel.deltaValues[resource.id] ?? 0; return value == 0 ? "" : String(value) }, set: { viewModel.setDelta(uuid: resource.id, value: Int($0) ?? 0) }))
                    .keyboardType(.numberPad).textFieldStyle(.roundedBorder).frame(width: compact ? 44 : 52)
                    .accessibilityLabel("\(resource.name) change amount")
                Button("＋") { viewModel.addResource(resourceNamed: resource.name, delta: viewModel.deltaValues[resource.id] ?? 0); viewModel.setDelta(uuid: resource.id, value: 0) }.accessibilityLabel("Add to \(resource.name)")
                Button("−") { viewModel.subtractResource(resourceNamed: resource.name, delta: viewModel.deltaValues[resource.id] ?? 0); viewModel.setDelta(uuid: resource.id, value: 0) }.accessibilityLabel("Subtract from \(resource.name)")
            }.buttonStyle(.bordered).disabled(!viewModel.multiplayerControlsEnabled)
            Stepper("産出: \(resource.production)", onIncrement: { viewModel.updateProduction(for: resource.name, production: resource.production + 1) }, onDecrement: { viewModel.updateProduction(for: resource.name, production: resource.production - 1) })
                .disabled(!viewModel.multiplayerControlsEnabled)
        }.padding(compact ? 8 : 12).frame(maxWidth: .infinity, alignment: .leading).background(Color(.systemGray6)).clipShape(RoundedRectangle(cornerRadius: 10))
    }
}

struct OtherPlayersView: View {
    var viewModel: GameViewModel
    private let order = ["MC", "Steel", "Titanium", "Plants", "Energy", "Heat"]
    var body: some View {
        Group {
            if viewModel.gameMode == .solo { ContentUnavailableView("ソロモードでは他プレイヤーは表示されません", systemImage: "person.3") }
            else if viewModel.multiplayerSession == nil { ContentUnavailableView("マルチプレイのルームへ参加してください", systemImage: "person.3", description: Text("ホームからルームを作成または参加できます")) }
            else {
                let players = viewModel.multiplayerSession!.players.filter { $0.playerId != viewModel.playerIdentifier }
                if players.isEmpty { ContentUnavailableView("他のプレイヤーの参加を待っています", systemImage: "person.3") }
                else { ScrollView { LazyVStack(spacing: 12) { ForEach(players) { PlayerResourceCardView(player: $0, resourceOrder: order) } }.padding() }.accessibilityIdentifier("playersScrollView") }
            }
        }
    }
}

struct PlayerResourceCardView: View {
    let player: MultiplayerPlayer
    let resourceOrder: [String]
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack { Text(player.displayName).font(.headline); Spacer(); Text(player.connected ? "オンライン" : "オフライン").foregroundStyle(player.connected ? .green : .secondary) }
            Text("TR: \(player.tr)")
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 120), spacing: 8)], alignment: .leading, spacing: 8) {
                ForEach(resourceOrder, id: \.self) { name in
                    if let resource = player.resources[name] { Text("\(name): \(resource.amount)  (産出 \(resource.production))").font(.caption).frame(maxWidth: .infinity, alignment: .leading) }
                }
            }
        }.padding().frame(maxWidth: .infinity, alignment: .leading).background(Color(.systemGray6)).clipShape(RoundedRectangle(cornerRadius: 12))
    }
}
