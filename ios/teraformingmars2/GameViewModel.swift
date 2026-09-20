import Foundation
import Observation
import Security

protocol ResumeTokenStore {
    func load(profileID: UUID?) -> String?
    @discardableResult func save(_ token: String, profileID: UUID?) -> Bool
    @discardableResult func remove(profileID: UUID?) -> Bool
    @discardableResult func removeAll() -> Bool
}

final class KeychainResumeTokenStore: ResumeTokenStore {
    private let service: String

    init(service: String = "red-planet-companion.multiplayer") { self.service = service }

    func load(profileID: UUID?) -> String? {
        var query = baseQuery(profileID: profileID)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    @discardableResult
    func save(_ token: String, profileID: UUID?) -> Bool {
        let query = baseQuery(profileID: profileID)
        let values: [String: Any] = [kSecValueData as String: Data(token.utf8)]
        let status = SecItemUpdate(query as CFDictionary, values as CFDictionary)
        if status == errSecSuccess { return true }
        guard status == errSecItemNotFound else { return false }
        var item = query.merging(values) { _, new in new }
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(item as CFDictionary, nil) == errSecSuccess
    }

    @discardableResult
    func remove(profileID: UUID?) -> Bool {
        let status = SecItemDelete(baseQuery(profileID: profileID) as CFDictionary)
        return status == errSecSuccess || status == errSecItemNotFound
    }

    @discardableResult
    func removeAll() -> Bool {
        let status = SecItemDelete([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
        ] as CFDictionary)
        return status == errSecSuccess || status == errSecItemNotFound
    }

    private func baseQuery(profileID: UUID?) -> [String: Any] {
        let account = "private-resume-token" + (profileID.map { "." + $0.uuidString.lowercased() } ?? "")
        return [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }
}

enum GameMode: Equatable {
    case none
    case solo
    case multiplayer
}

private enum PendingConnectionRequest: Equatable {
    case create
    case join
    case resume
}

private enum MultiplayerActionIntent {
    case changeResource(name: String, delta: Int, adding: Bool)
    case changeProduction(name: String, delta: Int)
    case changeTR(delta: Int)
    case runProduction
    case reset

    var messageType: String {
        switch self {
        case .changeResource: "updateResource"
        case .changeProduction: "updateProduction"
        case .changeTR: "updateTR"
        case .runProduction: "runProduction"
        case .reset: "resetPlayer"
        }
    }
}

private struct PendingMultiplayerAction {
    let id: String
    let intent: MultiplayerActionIntent
}

@MainActor
@Observable
final class GameViewModel {
    private enum Keys {
        static let resumeCredentials = "RedPlanetServerResumeCredentials"
        static let gameState = "GameStateKey"
        static let clientID = "MultiplayerClientID"
        static let serverURL = "MultiplayerServerURL"
        static let displayName = "MultiplayerDisplayName"
        static let sessionID = "MultiplayerSessionID"
        static let joinCode = "MultiplayerJoinCode"
        static let playerID = "MultiplayerPlayerID"
        static let roomMode = "MultiplayerRoomMode"
        static let legacyResumeToken = "MultiplayerResumeToken"
        static let resumeServerProfileID = "MultiplayerResumeServerProfileID"
        static let resumeServerURL = "MultiplayerResumeServerURL"
    }

    var localGameState: GameState
    var undoStack: [GameSnapshot] = []
    var redoStack: [GameSnapshot] = []
    var deltaValues: [UUID: Int] = [:]
    var serverURL: String
    var serverProfiles: [ServerProfile]
    var selectedServerID: UUID?
    var displayName: String
    var sessionID: String
    var joinCode: String
    var roomMode: RoomMode
    var multiplayerSession: MultiplayerSessionState?
    var multiplayerError: String?
    var isMultiplayerConnected = false
    var isConnecting = false
    var isLeavingMultiplayer = false
    var connectionState: MultiplayerConnectionState = .disconnected
    var gameMode: GameMode = .none
    var showingOfflineSoloChoice = false

    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let serverProfileStore: ServerProfileStore
    private var clientID: String
    private var activePlayerID: String?
    @ObservationIgnored private let multiplayerClient: MultiplayerClient
    @ObservationIgnored private let tokenStore: ResumeTokenStore
    @ObservationIgnored private var pendingConnectionRequest: PendingConnectionRequest?
    private var pendingActions: [PendingMultiplayerAction] = []
    private var actionInFlight: PendingMultiplayerAction?
    @ObservationIgnored private var waitingForFreshSnapshot = false
    @ObservationIgnored private var savedCredentials: [ServerResumeCredentials] = []
    @ObservationIgnored private var resumeToken: String?
    @ObservationIgnored private var credentialServerProfileID: UUID?
    @ObservationIgnored private var credentialServerURL: String?
    @ObservationIgnored private var leaveAfterReconnect = false
    @ObservationIgnored private var leaveRequestInFlight = false
    @ObservationIgnored private var leaveReconnectAttempted = false
    @ObservationIgnored private var switchToSoloAfterLeave = false
    @ObservationIgnored private var leaveTimeoutTask: Task<Void, Never>?
    @ObservationIgnored private let leaveAcknowledgementTimeoutNanoseconds: UInt64

    private let gameVersion = 1

    var clientIdentifier: String { clientID }
    var playerIdentifier: String? { activePlayerID }
    var multiplayerPlayer: MultiplayerPlayer? {
        guard let activePlayerID else { return nil }
        return multiplayerSession?.players.first { $0.playerId == activePlayerID }
    }
    var resources: [Resource] {
        guard let player = multiplayerPlayer else { return localGameState.resources }
        return localGameState.resources.map { resource in
            guard let value = player.resources[resource.name] else { return resource }
            return Resource(id: resource.id, name: resource.name, amount: value.amount, production: value.production, isMegaCredit: resource.isMegaCredit, isEnergy: resource.isEnergy, isHeat: resource.isHeat)
        }
    }
    var tr: Int { multiplayerPlayer?.tr ?? localGameState.tr }
    var selectedServerProfile: ServerProfile? {
        serverProfiles.first { $0.id == selectedServerID }
    }
    var canResumeSession: Bool {
        guard activePlayerID?.isEmpty == false, !sessionID.isEmpty, !serverURL.isEmpty else { return false }
        guard let credentialServerURL,
              normalizedWebSocketURL(credentialServerURL) == normalizedWebSocketURL(serverURL) else { return false }
        if let credentialServerProfileID, credentialServerProfileID != selectedServerID { return false }
        return roomMode == .friends || resumeToken?.isEmpty == false
    }
    var multiplayerControlsEnabled: Bool {
        gameMode != .multiplayer || (isMultiplayerConnected && !isLeavingMultiplayer && actionInFlight == nil && pendingActions.isEmpty)
    }
    var canUndo: Bool { gameMode != .multiplayer && !undoStack.isEmpty }
    var canRedo: Bool { gameMode != .multiplayer && !redoStack.isEmpty }

    init(defaults: UserDefaults = .standard, multiplayerClient: MultiplayerClient? = nil, tokenStore: ResumeTokenStore? = nil, leaveAcknowledgementTimeoutNanoseconds: UInt64 = 4_000_000_000) {
        let resolvedTokenStore = tokenStore ?? KeychainResumeTokenStore()
        let resolvedProfileStore = ServerProfileStore(defaults: defaults)
        let registry = resolvedProfileStore.load(legacyWebSocketURL: defaults.string(forKey: Keys.serverURL))
        let resolvedServerURL = registry.profiles.first { $0.id == registry.selectedServerID }?.webSocketURL
            ?? defaults.string(forKey: Keys.serverURL)
            ?? ""
        self.defaults = defaults
        self.serverProfileStore = resolvedProfileStore
        self.multiplayerClient = multiplayerClient ?? LocalMultiplayerClient()
        self.tokenStore = resolvedTokenStore
        self.leaveAcknowledgementTimeoutNanoseconds = leaveAcknowledgementTimeoutNanoseconds
        clientID = defaults.string(forKey: Keys.clientID) ?? UUID().uuidString.lowercased()
        serverProfiles = registry.profiles
        selectedServerID = registry.selectedServerID
        serverURL = resolvedServerURL
        displayName = defaults.string(forKey: Keys.displayName) ?? ""
        sessionID = ""
        joinCode = ""
        activePlayerID = nil
        roomMode = .friends
        resumeToken = nil
        credentialServerProfileID = nil
        credentialServerURL = nil
        if let data = defaults.data(forKey: Keys.gameState),
           let migratedData = migrateGameState(from: data, to: gameVersion),
           let state = try? JSONDecoder().decode(GameState.self, from: migratedData) {
            localGameState = state
        } else {
            localGameState = createInitialState()
        }
        defaults.set(clientID, forKey: Keys.clientID)
        migrateResumeCredentials()
        loadSelectedCredentials()
        self.multiplayerClient.onMessage = { [weak self] message in self?.handleMultiplayerMessage(message) }
        self.multiplayerClient.onDisconnect = { [weak self] in
            guard let self else { return }
            self.leaveRequestInFlight = false
            self.isMultiplayerConnected = false
            self.isConnecting = false
            self.connectionState = self.canResumeSession ? .reconnecting : .disconnected
            self.multiplayerSession = nil
            self.pendingConnectionRequest = nil
            self.clearPendingActions()
            if self.isLeavingMultiplayer {
                self.leaveAfterReconnect = self.canResumeSession
                self.multiplayerError = "退出確認中に接続が切れました。再接続情報を保持して確認を待ちます。"
                if !self.leaveReconnectAttempted, self.canResumeSession, !self.isConnecting {
                    self.leaveReconnectAttempted = true
                    self.resumeMultiplayerGame()
                }
            } else {
                self.multiplayerError = "ローカルサーバーとの接続が切断されました。再接続してください。"
            }
        }
    }

    func startSoloGame() {
        showingOfflineSoloChoice = false
        if multiplayerSession != nil || isMultiplayerConnected || canResumeSession {
            switchToSoloAfterLeave = true
            leaveMultiplayerGame()
            return
        }
        multiplayerClient.disconnect()
        pendingConnectionRequest = nil
        isConnecting = false
        connectionState = .disconnected
        multiplayerError = nil
        gameMode = .solo
    }

    func createMultiplayerGame() {
        guard validConnectionDetails(requireSession: false, requireDisplayName: true) else { return }
        beginConnection(.create)
    }

    func joinMultiplayerGame() {
        guard validConnectionDetails(requireSession: true, requireDisplayName: true) else { return }
        joinCode = joinCode.uppercased()
        beginConnection(.join)
    }

    func resumeMultiplayerGame() {
        guard canResumeSession else {
            multiplayerError = "再接続できるルーム情報がありません。"
            return
        }
        guard validConnectionDetails(requireSession: true, requireDisplayName: false) else { return }
        beginConnection(.resume)
    }

    func leaveMultiplayerGame() {
        guard !isLeavingMultiplayer else { return }
        guard canResumeSession else {
            multiplayerError = "退出を確認するための再接続情報がありません。"
            switchToSoloAfterLeave = false
            return
        }
        isLeavingMultiplayer = true
        leaveAfterReconnect = !isMultiplayerConnected
        leaveRequestInFlight = false
        leaveReconnectAttempted = false
        multiplayerError = nil
        clearPendingActions()
        startLeaveTimeout()
        if isMultiplayerConnected {
            sendLeaveRequest()
        } else {
            resumeMultiplayerGame()
            if !isConnecting { failLeaveAttempt("退出確認のため再接続できませんでした。再接続情報は保持されています。") }
        }
    }

    func handleScenePhase(isActive: Bool) {
        guard gameMode == .multiplayer else { return }
        if isActive {
            if !isMultiplayerConnected && !isConnecting { resumeMultiplayerGame() }
        } else {
            multiplayerClient.disconnect()
            isMultiplayerConnected = false
            isConnecting = false
            connectionState = .disconnected
            pendingConnectionRequest = nil
            clearPendingActions()
            if isLeavingMultiplayer { leaveAfterReconnect = true }
        }
    }

    func saveServerProfile(id: UUID?, name: String, webSocketURL: String) -> String? {
        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (1...50).contains(trimmedName.count) else { return "サーバー名は1〜50文字で入力してください。" }
        guard let normalizedURL = normalizedWebSocketURL(webSocketURL) else { return "WebSocket URLは ws:// または wss:// から入力してください。" }
        guard !isMultiplayerConnected, !isConnecting, !isLeavingMultiplayer else { return "接続を終了してから編集してください。" }
        let timestamp = Date()
        if let id {
            guard let index = serverProfiles.firstIndex(where: { $0.id == id }) else { return "編集するサーバーが見つかりません。" }
            let previousURL = serverProfiles[index].webSocketURL
            serverProfiles[index].name = trimmedName
            serverProfiles[index].webSocketURL = normalizedURL
            serverProfiles[index].updatedAt = timestamp
            if selectedServerID == id { serverURL = normalizedURL }
            if normalizedWebSocketURL(previousURL) != normalizedWebSocketURL(normalizedURL) {
                removeCredentials(profileID: id)
                if selectedServerID == id { loadSelectedCredentials() }
            }
        } else {
            let profile = ServerProfile(id: UUID(), name: trimmedName, webSocketURL: normalizedURL, createdAt: timestamp, updatedAt: timestamp)
            serverProfiles.append(profile)
            if selectedServerID == nil {
                selectedServerID = profile.id
                serverURL = profile.webSocketURL
            }
        }
        persistServerProfiles()
        return nil
    }

    func selectServerProfile(id: UUID) {
        guard !isMultiplayerConnected, !isConnecting, !isLeavingMultiplayer,
              let profile = serverProfiles.first(where: { $0.id == id }) else { return }
        multiplayerClient.disconnect()
        multiplayerSession = nil
        connectionState = .disconnected
        selectedServerID = id
        serverURL = profile.webSocketURL
        loadSelectedCredentials()
        multiplayerError = nil
        persistServerProfiles()
    }

    func deleteServerProfile(id: UUID) {
        guard !isMultiplayerConnected, !isConnecting, !isLeavingMultiplayer,
              serverProfiles.contains(where: { $0.id == id }) else { return }
        removeCredentials(profileID: id)
        serverProfiles.removeAll { $0.id == id }
        if selectedServerID == id {
            selectedServerID = serverProfiles.first?.id
            serverURL = selectedServerProfile?.webSocketURL ?? ""
        }
        loadSelectedCredentials()
        persistServerProfiles()
    }

    private func persistServerProfiles() {
        serverProfileStore.save(ServerProfileRegistry(profiles: serverProfiles, selectedServerID: selectedServerID))
        if serverURL.isEmpty { defaults.removeObject(forKey: Keys.serverURL) }
        else { defaults.set(serverURL, forKey: Keys.serverURL) }
    }

    private func ensureProfileForCurrentServerURL() {
        guard let normalizedURL = normalizedWebSocketURL(serverURL) else { return }
        if let existing = ([selectedServerProfile].compactMap { $0 } + serverProfiles).first(where: { normalizedWebSocketURL($0.webSocketURL) == normalizedURL }) {
            selectedServerID = existing.id
            serverURL = existing.webSocketURL
        } else {
            let timestamp = Date()
            let migrated = ServerProfile(id: UUID(), name: "Migrated Server", webSocketURL: normalizedURL, createdAt: timestamp, updatedAt: timestamp)
            serverProfiles.append(migrated)
            selectedServerID = migrated.id
            serverURL = migrated.webSocketURL
        }
        persistServerProfiles()
    }

    private func validConnectionDetails(requireSession: Bool, requireDisplayName: Bool) -> Bool {
        guard let url = URL(string: serverURL), let scheme = url.scheme?.lowercased(), ["ws", "wss"].contains(scheme), url.host != nil else {
            multiplayerError = "サーバーURLを ws:// または wss:// から入力してください。"
            return false
        }
        if requireDisplayName {
            let trimmedName = displayName.trimmingCharacters(in: .whitespacesAndNewlines)
            guard (1...20).contains(trimmedName.count) else {
                multiplayerError = "プレイヤー名は1〜20文字で入力してください。"
                return false
            }
            displayName = trimmedName
        }
        if requireSession {
            let normalizedSessionID = sessionID.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            let normalizedJoinCode = joinCode.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
            guard UUID(uuidString: normalizedSessionID) != nil else {
                multiplayerError = "Session IDが正しくありません。"
                return false
            }
            guard normalizedJoinCode.range(of: "^[A-Z0-9]{6}$", options: .regularExpression) != nil else {
                multiplayerError = "Join codeは6文字の英数字です。"
                return false
            }
            sessionID = normalizedSessionID
            joinCode = normalizedJoinCode
        }
        return true
    }

    private func beginConnection(_ request: PendingConnectionRequest) {
        ensureProfileForCurrentServerURL()
        guard let url = URL(string: serverURL) else { return }
        defaults.set(clientID, forKey: Keys.clientID)
        defaults.set(serverURL, forKey: Keys.serverURL)
        if !displayName.isEmpty { defaults.set(displayName, forKey: Keys.displayName) }
        multiplayerError = nil
        isConnecting = true
        isMultiplayerConnected = false
        connectionState = request == .resume ? .reconnecting : .connecting
        pendingConnectionRequest = request
        multiplayerClient.connect(to: url)
    }

    private func sendPendingConnectionRequest() {
        guard let request = pendingConnectionRequest else { return }
        let message: [String: Any]
        switch request {
        case .create:
            message = baseMessage(type: "createSession", extra: [
                "clientId": clientID,
                "displayName": displayName,
                "roomMode": roomMode.rawValue,
            ])
        case .join:
            message = baseMessage(type: "joinSession", extra: [
                "sessionId": sessionID,
                "joinCode": joinCode,
                "clientId": clientID,
                "displayName": displayName,
            ])
        case .resume:
            if roomMode == .private {
                guard let resumeToken, let activePlayerID else { return }
                message = baseMessage(type: "resumeSession", extra: [
                    "sessionId": sessionID,
                    "playerId": activePlayerID,
                    "resumeToken": resumeToken,
                ])
            } else {
                message = baseMessage(type: "resumeSession", extra: [
                    "sessionId": sessionID,
                    "clientId": clientID,
                ])
            }
        }
        if multiplayerClient.send(message) {
            pendingConnectionRequest = nil
        } else {
            isMultiplayerConnected = false
            isConnecting = false
            connectionState = .disconnected
            multiplayerError = "サーバーへの送信を開始できませんでした。"
        }
    }

    private func baseMessage(type: String, extra: [String: Any] = [:]) -> [String: Any] {
        var message: [String: Any] = ["type": type, "protocolVersion": "v1", "requestId": UUID().uuidString.lowercased()]
        extra.forEach { message[$0.key] = $0.value }
        return message
    }

    private func sendLeaveRequest() {
        guard isLeavingMultiplayer, !leaveRequestInFlight, isMultiplayerConnected, !sessionID.isEmpty else { return }
        guard multiplayerClient.send(baseMessage(type: "leaveSession", extra: ["sessionId": sessionID])) else {
            failLeaveAttempt("退出リクエストを送信できませんでした。再接続情報は保持されています。")
            return
        }
        leaveAfterReconnect = false
        leaveRequestInFlight = true
        startLeaveTimeout()
    }

    private func startLeaveTimeout() {
        leaveTimeoutTask?.cancel()
        let timeout = leaveAcknowledgementTimeoutNanoseconds
        leaveTimeoutTask = Task { @MainActor [weak self] in
            do { try await Task.sleep(nanoseconds: timeout) } catch { return }
            guard let self, self.isLeavingMultiplayer else { return }
            self.failLeaveAttempt("サーバーから退出確認を受信できませんでした。再接続情報は保持されています。")
        }
    }

    private func failLeaveAttempt(_ message: String) {
        leaveTimeoutTask?.cancel()
        leaveTimeoutTask = nil
        isLeavingMultiplayer = false
        leaveAfterReconnect = false
        leaveRequestInFlight = false
        leaveReconnectAttempted = false
        showingOfflineSoloChoice = switchToSoloAfterLeave
        switchToSoloAfterLeave = false
        // Stop late server responses from reviving the session after the user chooses solo.
        multiplayerClient.disconnect()
        isConnecting = false
        isMultiplayerConnected = false
        multiplayerSession = nil
        pendingConnectionRequest = nil
        connectionState = .disconnected
        multiplayerError = message
    }

    private func completeLeave() {
        leaveTimeoutTask?.cancel()
        leaveTimeoutTask = nil
        let nextMode: GameMode = switchToSoloAfterLeave ? .solo : .none
        multiplayerClient.disconnect()
        multiplayerSession = nil
        isMultiplayerConnected = false
        isConnecting = false
        isLeavingMultiplayer = false
        connectionState = .disconnected
        pendingConnectionRequest = nil
        leaveAfterReconnect = false
        leaveRequestInFlight = false
        leaveReconnectAttempted = false
        switchToSoloAfterLeave = false
        clearPendingActions()
        clearActiveSessionCredentials()
        gameMode = nextMode
        multiplayerError = nil
    }

    private func sendAction(_ intent: MultiplayerActionIntent) {
        guard gameMode == .multiplayer, multiplayerSession != nil, isMultiplayerConnected else {
            multiplayerError = "サーバーに再接続してから操作してください。"
            return
        }
        guard actionInFlight == nil, pendingActions.isEmpty else {
            multiplayerError = "前の操作が完了するまでお待ちください。"
            return
        }
        pendingActions.append(PendingMultiplayerAction(
            id: UUID().uuidString.lowercased(),
            intent: intent
        ))
        sendNextActionIfPossible()
    }

    private func sendNextActionIfPossible() {
        guard actionInFlight == nil,
              isMultiplayerConnected,
              multiplayerSession != nil,
              !pendingActions.isEmpty else { return }
        let action = pendingActions.removeFirst()
        actionInFlight = action
        transmit(action)
    }

    private func transmit(_ action: PendingMultiplayerAction) {
        guard let session = multiplayerSession, let player = multiplayerPlayer else {
            actionInFlight = nil
            multiplayerError = "プレイヤーの最新状態を確認できません。再接続してください。"
            return
        }
        guard var values = values(for: action.intent) else {
            actionInFlight = nil
            multiplayerError = "現在の状態ではこの操作を実行できません。"
            sendNextActionIfPossible()
            return
        }
        values["sessionId"] = session.sessionId
        values["actionId"] = action.id
        values["expectedRevision"] = player.revision
        guard multiplayerClient.send(baseMessage(type: action.intent.messageType, extra: values)) else {
            actionInFlight = nil
            pendingActions.insert(action, at: 0)
            isMultiplayerConnected = false
            multiplayerError = "操作を送信できませんでした。再接続してください。"
            return
        }
    }

    private func values(for intent: MultiplayerActionIntent) -> [String: Any]? {
        switch intent {
        case let .changeResource(name, delta, adding):
            guard let resource = resources.first(where: { $0.name == name }),
                  let mutation = validatedResourceMutation(currentAmount: resource.amount, delta: delta, adding: adding) else { return nil }
            return [
                "resourceId": name,
                "amount": mutation.amount,
                "operation": mutation.operation,
            ]
        case let .changeProduction(name, delta):
            guard let resource = resources.first(where: { $0.name == name }) else { return nil }
            let minimum = resource.isMegaCredit ? -5 : 0
            return [
                "resourceId": name,
                "production": max(minimum, min(resource.production + delta, 20)),
            ]
        case let .changeTR(delta):
            return ["tr": max(0, min(tr + delta, 100))]
        case .runProduction, .reset:
            return [:]
        }
    }

    private func clearPendingActions() {
        pendingActions.removeAll()
        actionInFlight = nil
        waitingForFreshSnapshot = false
    }

    private func handleMultiplayerMessage(_ message: [String: Any]) {
        guard message["protocolVersion"] as? String == "v1" else {
            multiplayerError = "サーバーの通信プロトコルのバージョンに対応していません。"
            return
        }
        guard let type = message["type"] as? String else { return }
        switch type {
        case "connectionState":
            handleConnectionState(message["state"] as? String)
            return
        case "sessionCreated":
            guard let id = message["sessionId"] as? String,
                  let code = message["joinCode"] as? String,
                  let playerID = message["playerId"] as? String,
                  let modeValue = message["roomMode"] as? String,
                  let mode = RoomMode(rawValue: modeValue),
                  let state = decodeSessionState(message["sessionState"]) else {
                multiplayerError = "サーバーから不正なルーム情報を受信しました。"
                return
            }
            let token = message["resumeToken"] as? String
            guard mode == .friends || token != nil else {
                multiplayerError = "Privateルームの再接続情報を受信できませんでした。"
                return
            }
            sessionID = id
            joinCode = code
            roomMode = mode
            activePlayerID = playerID
            resumeToken = token
            persistActiveSessionCredentials()
            applyMultiplayerState(state)
            return
        case "sessionJoined":
            guard let playerID = message["playerId"] as? String,
                  let modeValue = message["roomMode"] as? String,
                  let mode = RoomMode(rawValue: modeValue) else {
                multiplayerError = "再接続情報を受信できませんでした。"
                return
            }
            let token = message["resumeToken"] as? String
            guard mode == .friends || token != nil else {
                multiplayerError = "Privateルームの再接続情報を受信できませんでした。"
                return
            }
            activePlayerID = playerID
            roomMode = mode
            resumeToken = token
            persistActiveSessionCredentials()
            return
        case "stateSnapshot":
            guard let state = decodeSessionState(message["sessionState"]) else { return }
            applyMultiplayerState(state)
            retryStaleActionIfNeeded()
            if isLeavingMultiplayer && leaveAfterReconnect { sendLeaveRequest() }
            return
        case "sessionLeft":
            guard message["sessionId"] as? String == sessionID,
                  message["playerId"] as? String == activePlayerID else { return }
            completeLeave()
            return
        case "actionAccepted":
            guard let state = decodeSessionState(message["sessionState"]) else { return }
            applyMultiplayerState(state)
            if let actionID = message["actionId"] as? String, actionID == actionInFlight?.id {
                actionInFlight = nil
                waitingForFreshSnapshot = false
                sendNextActionIfPossible()
            }
            return
        case "actionRejected":
            handleActionRejected(message)
            return
        case "error":
            let errorMessage = firstErrorMessage(in: message) ?? "サーバーがリクエストを拒否しました。"
            let code = (message["errors"] as? [[String: Any]])?.first?["code"] as? String
            if isLeavingMultiplayer {
                if let code, ["SESSION_NOT_FOUND", "PLAYER_NOT_FOUND"].contains(code) { completeLeave() }
                else {
                    isConnecting = false
                    isMultiplayerConnected = false
                    connectionState = .disconnected
                    multiplayerSession = nil
                    failLeaveAttempt("\(errorMessage) 再接続情報は保持されています。")
                }
                return
            }
            multiplayerError = errorMessage
            isConnecting = false
            if let code, ["AUTHENTICATION_FAILED", "PLAYER_NOT_FOUND", "SESSION_NOT_FOUND"].contains(code) {
                multiplayerSession = nil
                isMultiplayerConnected = false
                connectionState = .disconnected
                clearActiveSessionCredentials()
            }
            return
        default:
            return
        }
    }

    private func handleConnectionState(_ state: String?) {
        switch state {
        case "connected":
            isMultiplayerConnected = false
            isConnecting = false
            connectionState = .joining
            sendPendingConnectionRequest()
        case "reconnecting":
            isMultiplayerConnected = false
            isConnecting = true
            connectionState = .reconnecting
        default:
            isMultiplayerConnected = false
            isConnecting = false
            connectionState = .disconnected
            multiplayerError = "ローカルサーバーとの接続が切断されました。"
        }
    }

    private func handleActionRejected(_ message: [String: Any]) {
        let code = (message["errors"] as? [[String: Any]])?.first?["code"] as? String
        multiplayerError = code == "STALE_REVISION"
            ? "別の更新が先に反映されたため、この操作は反映されませんでした。最新状態を表示します。"
            : firstErrorMessage(in: message) ?? "操作が拒否されました。"
        actionInFlight = nil
        waitingForFreshSnapshot = code == "STALE_REVISION"
        if !waitingForFreshSnapshot { sendNextActionIfPossible() }
    }

    private func retryStaleActionIfNeeded() {
        guard waitingForFreshSnapshot else { return }
        waitingForFreshSnapshot = false
        sendNextActionIfPossible()
    }

    private func firstErrorMessage(in message: [String: Any]) -> String? {
        (message["errors"] as? [[String: Any]])?.first?["message"] as? String
    }

    private func decodeSessionState(_ object: Any?) -> MultiplayerSessionState? {
        guard let object,
              JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(withJSONObject: object) else { return nil }
        return try? JSONDecoder().decode(MultiplayerSessionState.self, from: data)
    }

    private func applyMultiplayerState(_ state: MultiplayerSessionState) {
        let wasDisconnected = !isMultiplayerConnected
        multiplayerSession = state
        sessionID = state.sessionId
        joinCode = state.joinCode
        roomMode = state.roomMode
        isMultiplayerConnected = true
        isConnecting = false
        connectionState = .connected
        if wasDisconnected { multiplayerError = nil }
        gameMode = .multiplayer
        persistActiveSessionCredentials()
        guard multiplayerPlayer != nil else {
            multiplayerError = "この端末のプレイヤー情報が見つかりません。"
            return
        }
    }

    private var legacyCredentialKeys: [String] {
        [Keys.sessionID, Keys.joinCode, Keys.playerID, Keys.roomMode, Keys.legacyResumeToken,
         Keys.resumeServerProfileID, Keys.resumeServerURL]
    }

    private func migrateResumeCredentials() {
        if let data = defaults.data(forKey: Keys.resumeCredentials),
           let decoded = try? JSONDecoder().decode([ServerResumeCredentials].self, from: data) {
            savedCredentials = decoded
        }
        guard let player = defaults.string(forKey: Keys.playerID),
              let session = defaults.string(forKey: Keys.sessionID), !session.isEmpty else { return }
        // Freeze provenance before profile selection can overwrite the legacy server URL.
        // An unknown URL stays unknown on subsequent launches rather than adopting a new selection.
        if defaults.string(forKey: Keys.resumeServerURL) == nil {
            defaults.set(defaults.string(forKey: Keys.serverURL) ?? "", forKey: Keys.resumeServerURL)
        }
        let legacyURL = defaults.string(forKey: Keys.resumeServerURL).flatMap(normalizedWebSocketURL)
        let explicitID = defaults.string(forKey: Keys.resumeServerProfileID).flatMap(UUID.init(uuidString:))
        let matches = serverProfiles.filter { normalizedWebSocketURL($0.webSocketURL) == legacyURL }
        // A selection alone is not evidence of which server owns a legacy credential.
        let profile = explicitID.flatMap { id in matches.first { $0.id == id } }
            ?? (explicitID == nil && matches.count == 1 ? matches.first : nil)
        guard let profile, let legacyURL else { return }
        if !savedCredentials.contains(where: { $0.serverProfileID == profile.id }) {
            let mode = RoomMode(rawValue: defaults.string(forKey: Keys.roomMode) ?? "friends") ?? .friends
            if mode == .private {
                guard let token = tokenStore.load(profileID: nil) ?? defaults.string(forKey: Keys.legacyResumeToken),
                      tokenStore.save(token, profileID: profile.id) else { return }
            }
            savedCredentials.append(ServerResumeCredentials(serverProfileID: profile.id, serverURL: legacyURL,
                sessionID: session, joinCode: defaults.string(forKey: Keys.joinCode) ?? "",
                playerID: player, roomMode: mode))
            persistCredentialMetadata()
        }
        guard tokenStore.remove(profileID: nil) else { return }
        legacyCredentialKeys.forEach { defaults.removeObject(forKey: $0) }
    }

    private func persistCredentialMetadata() {
        if let data = try? JSONEncoder().encode(savedCredentials) {
            defaults.set(data, forKey: Keys.resumeCredentials)
        }
    }

    private func loadSelectedCredentials() {
        let credentials = savedCredentials.first {
            $0.serverProfileID == selectedServerID && normalizedWebSocketURL($0.serverURL) == normalizedWebSocketURL(serverURL)
        }
        sessionID = credentials?.sessionID ?? ""
        joinCode = credentials?.joinCode ?? ""
        activePlayerID = credentials?.playerID
        roomMode = credentials?.roomMode ?? .friends
        credentialServerProfileID = credentials?.serverProfileID
        credentialServerURL = credentials?.serverURL
        resumeToken = credentials.flatMap { tokenStore.load(profileID: $0.serverProfileID) }
    }

    private func persistActiveSessionCredentials() {
        guard let id = selectedServerID, let playerID = activePlayerID,
              let url = normalizedWebSocketURL(serverURL) else { return }
        credentialServerProfileID = id
        credentialServerURL = url
        if let resumeToken, !tokenStore.save(resumeToken, profileID: id) {
            multiplayerError = "再接続情報をKeychainに保存できませんでした。"
            return
        }
        if roomMode == .friends { tokenStore.remove(profileID: id) }
        savedCredentials.removeAll { $0.serverProfileID == id }
        savedCredentials.append(ServerResumeCredentials(serverProfileID: id, serverURL: url,
            sessionID: sessionID, joinCode: joinCode, playerID: playerID, roomMode: roomMode))
        persistCredentialMetadata()
        defaults.set(displayName, forKey: Keys.displayName)
    }

    private func removeCredentials(profileID: UUID) {
        tokenStore.remove(profileID: profileID)
        savedCredentials.removeAll { $0.serverProfileID == profileID }
        persistCredentialMetadata()
    }

    private func clearActiveSessionCredentials() {
        if let id = credentialServerProfileID { removeCredentials(profileID: id) }
        loadSelectedCredentials()
    }

    func forgetResumeAndStartSolo() {
        switchToSoloAfterLeave = true
        completeLeave() // Local reset only: never sends a remote leave request.
        showingOfflineSoloChoice = false
    }

    @discardableResult
    func deleteAllLocalData() -> Bool {
        guard tokenStore.removeAll() else {
            multiplayerError = "Keychainの保存データを削除できませんでした。もう一度お試しください。"
            return false
        }
        completeLeave()
        savedCredentials = []
        serverProfiles = []
        selectedServerID = nil
        serverURL = ""
        displayName = ""
        localGameState = createInitialState()
        undoStack = []
        redoStack = []
        deltaValues = [:]
        clientID = UUID().uuidString.lowercased()
        showingOfflineSoloChoice = false
        gameMode = .none
        (legacyCredentialKeys + [Keys.gameState, Keys.clientID, Keys.serverURL, Keys.displayName,
            Keys.resumeCredentials, "RedPlanetServerProfiles", "RedPlanetSelectedServerID"]).forEach {
            defaults.removeObject(forKey: $0)
        }
        return true
    }

    func savePersistentState() {
        if let data = try? JSONEncoder().encode(localGameState) { defaults.set(data, forKey: Keys.gameState) }
    }
    func addResource(resourceNamed name: String, delta: Int) { updateResource(name, delta: delta, adding: true) }
    func subtractResource(resourceNamed name: String, delta: Int) { updateResource(name, delta: delta, adding: false) }
    private func updateResource(_ name: String, delta: Int, adding: Bool) {
        guard delta > 0 else { return }
        if gameMode == .multiplayer {
            if !adding, let resource = resources.first(where: { $0.name == name }), delta > resource.amount {
                multiplayerError = "所持量を超えて減らすことはできません。"
                return
            }
            sendAction(.changeResource(name: name, delta: delta, adding: adding)); return
        }
        let newState = adding ? applyAdd(state: localGameState, resourceName: name, delta: delta) : applySubtract(state: localGameState, resourceName: name, delta: delta)
        if let newState { saveState(); localGameState = newState; savePersistentState() }
    }
    func executeProduction() { if gameMode == .multiplayer { sendAction(.runProduction); return }; saveState(); localGameState = applyProduction(state: localGameState); savePersistentState() }
    func resetGame() { if gameMode == .multiplayer { sendAction(.reset); return }; saveState(); localGameState = applyReset(state: localGameState); savePersistentState() }
    func updateProduction(for name: String, production: Int) {
        guard let resource = resources.first(where: { $0.name == name }) else { return }
        let clamped = max(resource.isMegaCredit ? -5 : 0, min(production, 20)); guard clamped != resource.production else { return }
        if gameMode == .multiplayer { sendAction(.changeProduction(name: name, delta: clamped - resource.production)); return }
        if let state = applyUpdateProduction(state: localGameState, resourceName: name, newProduction: clamped) { saveState(); localGameState = state; savePersistentState() }
    }
    func incrementTR() { updateTR(increment: true) }
    func decrementTR() { updateTR(increment: false) }
    private func updateTR(increment: Bool) {
        if gameMode == .multiplayer { sendAction(.changeTR(delta: increment ? 1 : -1)); return }
        let state = increment ? applyIncrementTR(state: localGameState) : applyDecrementTR(state: localGameState)
        guard state.tr != localGameState.tr else { return }; saveState(); localGameState = state; savePersistentState()
    }
    func undo() { guard gameMode != .multiplayer, let last = undoStack.popLast() else { return }; redoStack.append(snapshot(localGameState)); localGameState = restore(from: last, version: gameVersion); savePersistentState() }
    func redo() { guard gameMode != .multiplayer, let next = redoStack.popLast() else { return }; undoStack.append(snapshot(localGameState)); if undoStack.count > 20 { undoStack.removeFirst() }; localGameState = restore(from: next, version: gameVersion); savePersistentState() }
    func setDelta(uuid: UUID, value: Int) { deltaValues[uuid] = value }
    private func saveState() { undoStack = pushSnapshot(to: &undoStack, state: localGameState); redoStack.removeAll() }
}
