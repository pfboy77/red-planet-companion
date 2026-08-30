import Foundation
import Observation
import Security

protocol ResumeTokenStore {
    func load() -> String?
    func save(_ token: String)
    func remove()
}

final class KeychainResumeTokenStore: ResumeTokenStore {
    private let service = "red-planet-companion.multiplayer"
    private let account = "private-resume-token"

    func load() -> String? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    func save(_ token: String) {
        remove()
        var query = baseQuery
        query[kSecValueData as String] = Data(token.utf8)
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(query as CFDictionary, nil)
    }

    func remove() { SecItemDelete(baseQuery as CFDictionary) }

    private var baseQuery: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
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
        static let gameState = "GameStateKey"
        static let clientID = "MultiplayerClientID"
        static let serverURL = "MultiplayerServerURL"
        static let displayName = "MultiplayerDisplayName"
        static let sessionID = "MultiplayerSessionID"
        static let joinCode = "MultiplayerJoinCode"
        static let playerID = "MultiplayerPlayerID"
        static let roomMode = "MultiplayerRoomMode"
        static let legacyResumeToken = "MultiplayerResumeToken"
    }

    var localGameState: GameState
    var undoStack: [GameSnapshot] = []
    var redoStack: [GameSnapshot] = []
    var deltaValues: [UUID: Int] = [:]
    var serverURL: String
    var displayName: String
    var sessionID: String
    var joinCode: String
    var roomMode: RoomMode
    var multiplayerSession: MultiplayerSessionState?
    var multiplayerError: String?
    var isMultiplayerConnected = false
    var isConnecting = false
    var connectionState: MultiplayerConnectionState = .disconnected
    var gameMode: GameMode = .none

    @ObservationIgnored private let defaults: UserDefaults
    private let clientID: String
    private var activePlayerID: String?
    @ObservationIgnored private let multiplayerClient: MultiplayerClient
    @ObservationIgnored private let tokenStore: ResumeTokenStore
    @ObservationIgnored private var pendingConnectionRequest: PendingConnectionRequest?
    private var pendingActions: [PendingMultiplayerAction] = []
    private var actionInFlight: PendingMultiplayerAction?
    @ObservationIgnored private var waitingForFreshSnapshot = false
    @ObservationIgnored private var resumeToken: String?

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
    var canResumeSession: Bool {
        guard activePlayerID?.isEmpty == false, !sessionID.isEmpty, !serverURL.isEmpty else { return false }
        return roomMode == .friends || resumeToken?.isEmpty == false
    }
    var multiplayerControlsEnabled: Bool {
        gameMode != .multiplayer || (isMultiplayerConnected && actionInFlight == nil && pendingActions.isEmpty)
    }
    var canUndo: Bool { gameMode != .multiplayer && !undoStack.isEmpty }
    var canRedo: Bool { gameMode != .multiplayer && !redoStack.isEmpty }

    init(defaults: UserDefaults = .standard, multiplayerClient: MultiplayerClient? = nil, tokenStore: ResumeTokenStore? = nil) {
        let resolvedTokenStore = tokenStore ?? KeychainResumeTokenStore()
        self.defaults = defaults
        self.multiplayerClient = multiplayerClient ?? LocalMultiplayerClient()
        self.tokenStore = resolvedTokenStore
        clientID = defaults.string(forKey: Keys.clientID) ?? UUID().uuidString.lowercased()
        serverURL = defaults.string(forKey: Keys.serverURL) ?? ""
        displayName = defaults.string(forKey: Keys.displayName) ?? ""
        sessionID = defaults.string(forKey: Keys.sessionID) ?? ""
        joinCode = defaults.string(forKey: Keys.joinCode) ?? ""
        activePlayerID = defaults.string(forKey: Keys.playerID)
        roomMode = RoomMode(rawValue: defaults.string(forKey: Keys.roomMode) ?? "friends") ?? .friends
        resumeToken = resolvedTokenStore.load() ?? defaults.string(forKey: Keys.legacyResumeToken)
        if let resumeToken { resolvedTokenStore.save(resumeToken) }
        defaults.removeObject(forKey: Keys.legacyResumeToken)
        defaults.set(clientID, forKey: Keys.clientID)

        if let data = defaults.data(forKey: Keys.gameState),
           let migratedData = migrateGameState(from: data, to: gameVersion),
           let state = try? JSONDecoder().decode(GameState.self, from: migratedData) {
            localGameState = state
        } else {
            localGameState = createInitialState()
        }
        self.multiplayerClient.onMessage = { [weak self] message in self?.handleMultiplayerMessage(message) }
        self.multiplayerClient.onDisconnect = { [weak self] in
            guard let self else { return }
            self.isMultiplayerConnected = false
            self.isConnecting = false
            self.connectionState = self.canResumeSession ? .reconnecting : .disconnected
            self.multiplayerSession = nil
            self.pendingConnectionRequest = nil
            self.clearPendingActions()
            self.multiplayerError = "ローカルサーバーとの接続が切断されました。再接続してください。"
        }
    }

    func startSoloGame() {
        if multiplayerSession != nil || isMultiplayerConnected || canResumeSession {
            leaveMultiplayerGame()
        }
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
        if isMultiplayerConnected && !sessionID.isEmpty {
            multiplayerClient.send(baseMessage(type: "leaveSession", extra: [
                "sessionId": sessionID,
            ]))
        }
        multiplayerClient.disconnect()
        multiplayerSession = nil
        isMultiplayerConnected = false
        isConnecting = false
        connectionState = .disconnected
        pendingConnectionRequest = nil
        clearPendingActions()
        clearActiveSessionCredentials()
        gameMode = .none
        multiplayerError = nil
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
        }
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
        guard let url = URL(string: serverURL) else { return }
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
            if let token { tokenStore.save(token) } else { tokenStore.remove() }
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
            if let token { tokenStore.save(token) } else { tokenStore.remove() }
            persistActiveSessionCredentials()
            return
        case "stateSnapshot":
            guard let state = decodeSessionState(message["sessionState"]) else { return }
            applyMultiplayerState(state)
            retryStaleActionIfNeeded()
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
            multiplayerError = firstErrorMessage(in: message) ?? "サーバーがリクエストを拒否しました。"
            isConnecting = false
            if let code = (message["errors"] as? [[String: Any]])?.first?["code"] as? String,
               ["AUTHENTICATION_FAILED", "PLAYER_NOT_FOUND", "SESSION_NOT_FOUND"].contains(code) {
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

    private func persistActiveSessionCredentials() {
        defaults.set(serverURL, forKey: Keys.serverURL)
        defaults.set(displayName, forKey: Keys.displayName)
        defaults.set(sessionID, forKey: Keys.sessionID)
        defaults.set(joinCode, forKey: Keys.joinCode)
        defaults.set(activePlayerID, forKey: Keys.playerID)
        defaults.set(roomMode.rawValue, forKey: Keys.roomMode)
    }

    private func clearActiveSessionCredentials() {
        sessionID = ""
        joinCode = ""
        activePlayerID = nil
        roomMode = .friends
        resumeToken = nil
        tokenStore.remove()
        defaults.removeObject(forKey: Keys.sessionID)
        defaults.removeObject(forKey: Keys.joinCode)
        defaults.removeObject(forKey: Keys.playerID)
        defaults.removeObject(forKey: Keys.roomMode)
        defaults.removeObject(forKey: Keys.legacyResumeToken)
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
