import SwiftUI

// MARK: - GameViewModel

@Observable
class GameViewModel {
    var resources: [Resource]
    var tr: Int
    var undoStack: [GameSnapshot] = []
    var redoStack: [GameSnapshot] = []
    var deltaValues: [UUID: Int] = [:]
    var serverURL = "ws://localhost:8080/ws"
    var displayName = ""
    var sessionID = ""
    var joinCode = ""
    var multiplayerSession: MultiplayerSessionState?
    var multiplayerError: String?
    var isMultiplayerConnected = false

    private let clientID: String
    private let multiplayerClient = LocalMultiplayerClient()

    private let gameStateKey = "GameStateKey"
    private let gameVersion = 1

    var clientIdentifier: String { clientID }

    init() {
        clientID = UserDefaults.standard.string(forKey: "MultiplayerClientID") ?? UUID().uuidString.lowercased()
        UserDefaults.standard.set(clientID, forKey: "MultiplayerClientID")
        if let data = UserDefaults.standard.data(forKey: gameStateKey),
           let migratedData = migrateGameState(from: data, to: gameVersion),
           let state = try? JSONDecoder().decode(GameState.self, from: migratedData) {
            self.resources = state.resources
            self.tr = state.tr
        } else {
            let initialState = createInitialState()
            self.resources = initialState.resources
            self.tr = initialState.tr
        }
        multiplayerClient.onMessage = { [weak self] message in self?.handleMultiplayerMessage(message) }
        multiplayerClient.onDisconnect = { [weak self] in
            self?.isMultiplayerConnected = false
            self?.multiplayerError = "ローカルサーバーとの接続が切断されました。"
        }
    }

    func createMultiplayerGame() {
        guard let url = URL(string: serverURL) else { multiplayerError = "Server URLが正しくありません。"; return }
        multiplayerError = nil
        multiplayerClient.connect(to: url)
        multiplayerClient.send(["type": "createSession", "protocolVersion": "v1", "requestId": UUID().uuidString.lowercased()])
    }

    func joinMultiplayerGame() {
        guard let url = URL(string: serverURL), !sessionID.isEmpty, !joinCode.isEmpty, !displayName.trimmingCharacters(in: .whitespaces).isEmpty else {
            multiplayerError = "Server URL、名前、Session ID、Join codeを入力してください。"
            return
        }
        multiplayerError = nil
        multiplayerClient.connect(to: url)
        sendJoin()
    }

    func leaveMultiplayerGame() {
        if !sessionID.isEmpty {
            multiplayerClient.send(baseMessage(type: "leaveSession"))
        }
        multiplayerClient.disconnect()
        multiplayerSession = nil
        isMultiplayerConnected = false
        multiplayerError = nil
    }

    private func sendJoin() {
        multiplayerClient.send(baseMessage(type: "joinSession", extra: [
            "sessionId": sessionID, "joinCode": joinCode.uppercased(), "clientId": clientID, "displayName": displayName
        ]))
    }

    private func baseMessage(type: String, extra: [String: Any] = [:]) -> [String: Any] {
        var message: [String: Any] = ["type": type, "protocolVersion": "v1", "requestId": UUID().uuidString.lowercased()]
        extra.forEach { message[$0.key] = $0.value }
        return message
    }

    private func sendAction(type: String, extra: [String: Any] = [:]) {
        guard let session = multiplayerSession else { return }
        var values = extra
        values["sessionId"] = session.sessionId
        values["clientId"] = clientID
        values["actionId"] = UUID().uuidString.lowercased()
        values["expectedRevision"] = session.revision
        multiplayerClient.send(baseMessage(type: type, extra: values))
    }

    private func handleMultiplayerMessage(_ message: [String: Any]) {
        guard let type = message["type"] as? String else { return }
        if type == "sessionCreated", let id = message["sessionId"] as? String, let code = message["joinCode"] as? String {
            sessionID = id
            joinCode = code
            sendJoin()
            return
        }
        if type == "error" {
            if let errors = message["errors"] as? [[String: Any]], let first = errors.first,
               let text = first["message"] as? String { multiplayerError = text }
            return
        }
        if type == "connectionState" { isMultiplayerConnected = true; multiplayerError = nil }
        guard let stateObject = message["sessionState"],
              let data = try? JSONSerialization.data(withJSONObject: stateObject),
              let state = try? JSONDecoder().decode(MultiplayerSessionState.self, from: data) else { return }
        multiplayerSession = state
        isMultiplayerConnected = true
        multiplayerError = nil
        guard let player = state.players.first(where: { $0.clientId == clientID }) else { return }
        tr = player.tr
        resources = resources.map { resource in
            guard let value = player.resources[resource.name] else { return resource }
            return Resource(id: resource.id, name: resource.name, amount: value.amount, production: value.production,
                            isMegaCredit: resource.isMegaCredit, isEnergy: resource.isEnergy, isHeat: resource.isHeat)
        }
    }

    func savePersistentState() {
        let state = GameState(version: gameVersion, resources: resources, tr: tr)
        if let data = try? JSONEncoder().encode(state) {
            UserDefaults.standard.set(data, forKey: gameStateKey)
        }
    }

    func addResource(resourceNamed name: String, delta: Int) {
        guard delta > 0 else { return }
        if multiplayerSession != nil {
            sendAction(type: "updateResource", extra: ["resourceId": name, "amount": delta, "operation": "add"])
            return
        }
        saveState()
        if let newState = applyAdd(state: GameState(version: gameVersion, resources: resources, tr: tr),
                                   resourceName: name, delta: delta) {
            resources = newState.resources
            tr = newState.tr
            savePersistentState()
        }
    }

    func subtractResource(resourceNamed name: String, delta: Int) {
        guard delta > 0 else { return }
        if multiplayerSession != nil {
            let amount = max(0, (resources.first(where: { $0.name == name })?.amount ?? 0) - delta)
            sendAction(type: "updateResource", extra: ["resourceId": name, "amount": amount, "operation": "set"])
            return
        }
        saveState()
        if let newState = applySubtract(state: GameState(version: gameVersion, resources: resources, tr: tr),
                                        resourceName: name, delta: delta) {
            resources = newState.resources
            tr = newState.tr
            savePersistentState()
        }
    }

    func executeProduction() {
        if multiplayerSession != nil { sendAction(type: "runProduction"); return }
        saveState()
        let newState = applyProduction(state: GameState(version: gameVersion, resources: resources, tr: tr))
        resources = newState.resources
        tr = newState.tr
        savePersistentState()
    }

    func resetGame() {
        if multiplayerSession != nil { sendAction(type: "resetPlayer"); return }
        saveState()
        let newState = applyReset(state: GameState(version: gameVersion, resources: resources, tr: tr))
        resources = newState.resources
        tr = newState.tr
        savePersistentState()
    }

    func updateProduction(for name: String, production: Int) {
        guard let resource = resources.first(where: { $0.name == name }) else { return }
        let minimum = resource.isMegaCredit ? -5 : 0
        let clampedProduction = max(minimum, min(production, 20))
        guard clampedProduction != resource.production else { return }

        if multiplayerSession != nil {
            sendAction(type: "updateProduction", extra: ["resourceId": name, "production": clampedProduction])
            return
        }

        saveState()
        if let newState = applyUpdateProduction(state: GameState(version: gameVersion, resources: resources, tr: tr),
                                                resourceName: name, newProduction: clampedProduction) {
            resources = newState.resources
            tr = newState.tr
            savePersistentState()
        }
    }

    func incrementTR() {
        if multiplayerSession != nil { sendAction(type: "updateTR", extra: ["tr": min(tr + 1, 100)]); return }
        let currentState = GameState(version: gameVersion, resources: resources, tr: tr)
        let newState = applyIncrementTR(state: currentState)
        guard newState.tr != tr else { return }
        saveState()
        tr = newState.tr
        savePersistentState()
    }

    func decrementTR() {
        if multiplayerSession != nil { sendAction(type: "updateTR", extra: ["tr": max(tr - 1, 0)]); return }
        let currentState = GameState(version: gameVersion, resources: resources, tr: tr)
        let newState = applyDecrementTR(state: currentState)
        guard newState.tr != tr else { return }
        saveState()
        tr = newState.tr
        savePersistentState()
    }

    func undo() {
        guard let last = undoStack.popLast() else { return }
        redoStack.append(snapshot(GameState(version: gameVersion, resources: resources, tr: tr)))
        let restored = restore(from: last, version: gameVersion)
        resources = restored.resources
        tr = restored.tr
        savePersistentState()
    }

    func redo() {
        guard let next = redoStack.popLast() else { return }
        undoStack.append(snapshot(GameState(version: gameVersion, resources: resources, tr: tr)))
        if undoStack.count > 20 {
            undoStack.removeFirst()
        }
        let restored = restore(from: next, version: gameVersion)
        resources = restored.resources
        tr = restored.tr
        savePersistentState()
    }

    func setDelta(uuid: UUID, value: Int) {
        deltaValues[uuid] = value
    }

    private func saveState() {
        undoStack = pushSnapshot(to: &undoStack, state: GameState(version: gameVersion, resources: resources, tr: tr))
        redoStack.removeAll()
    }
}

// MARK: - ContentView

struct ContentView: View {
    @State private var viewModel = GameViewModel()

    var body: some View {
        VStack(spacing: 8) {
            multiplayerPanel

            // Toolbar: Undo/Redo + TR + Buttons
            HStack {
                Button("↩︎") {
                    withAnimation { viewModel.undo() }
                }
                .disabled(viewModel.undoStack.isEmpty)
                .font(.headline)
                .padding(6)
                .background(Color(.systemGray5))
                .cornerRadius(8)
                .accessibilityLabel("Undo")

                Button("↪︎") {
                    withAnimation { viewModel.redo() }
                }
                .disabled(viewModel.redoStack.isEmpty)
                .font(.headline)
                .padding(6)
                .background(Color(.systemGray5))
                .cornerRadius(8)
                .accessibilityLabel("Redo")

                Spacer()

                HStack(spacing: 8) {
                    Text("TR: \(viewModel.tr)")
                        .font(.headline)
                        .accessibilityLabel("Terraform Rating \(viewModel.tr)")

                    Button("-") {
                        viewModel.decrementTR()
                    }
                    .font(.headline)
                    .padding(4)
                    .background(Color(.systemGray5))
                    .cornerRadius(6)
                    .accessibilityLabel("Decrease TR")

                    Button("+") {
                        viewModel.incrementTR()
                    }
                    .font(.headline)
                    .padding(4)
                    .background(Color(.systemGray5))
                    .cornerRadius(6)
                    .accessibilityLabel("Increase TR")
                }

                Button("リセット") {
                    viewModel.resetGame()
                }
                .font(.headline)
                .padding(6)
                .background(Color.red.opacity(0.8))
                .foregroundColor(.white)
                .cornerRadius(8)
                .accessibilityLabel("Reset all resources")

                Button("▶︎ 産出") {
                    viewModel.executeProduction()
                }
                .font(.headline)
                .padding(6)
                .background(Color.blue)
                .foregroundColor(.white)
                .cornerRadius(8)
                .accessibilityLabel("Production phase")
            }
            .padding(.horizontal)

            // Resources Grid
            let columns = Array(repeating: GridItem(.flexible(), spacing: 8), count: 3)
            LazyVGrid(columns: columns, spacing: 8) {
                ForEach(viewModel.resources) { resource in
                    VStack(spacing: 4) {
                        Text(resource.name)
                            .font(.headline)
                            .accessibilityLabel(resource.name)

                        Text("資源: \(resource.amount)")
                            .font(.subheadline)
                            .accessibilityLabel("\(resource.name) \(resource.amount)")

                        HStack(spacing: 4) {
                            TextField("±", text: Binding(
                                get: {
                                    let v = viewModel.deltaValues[resource.id] ?? 0
                                    return v == 0 ? "" : String(v)
                                },
                                set: { newText in
                                    if let v = Int(newText) {
                                        viewModel.setDelta(uuid: resource.id, value: v)
                                    } else {
                                        viewModel.setDelta(uuid: resource.id, value: 0)
                                    }
                                }
                            ))
                            .keyboardType(.numberPad)
                            .frame(width: 40)
                            .textFieldStyle(RoundedBorderTextFieldStyle())

                            Button("＋") {
                                viewModel.addResource(resourceNamed: resource.name,
                                                   delta: viewModel.deltaValues[resource.id] ?? 0)
                                viewModel.setDelta(uuid: resource.id, value: 0)
                            }
                            .font(.subheadline)
                            .buttonStyle(.bordered)
                            .accessibilityLabel("Add to \(resource.name)")

                            Button("−") {
                                viewModel.subtractResource(resourceNamed: resource.name,
                                                        delta: viewModel.deltaValues[resource.id] ?? 0)
                                viewModel.setDelta(uuid: resource.id, value: 0)
                            }
                            .font(.subheadline)
                            .buttonStyle(.bordered)
                            .accessibilityLabel("Subtract from \(resource.name)")
                        }

                        Stepper("産出: \(resource.production)",
                                onIncrement: {
                                    viewModel.updateProduction(for: resource.name,
                                                               production: resource.production + 1)
                                },
                                onDecrement: {
                                    viewModel.updateProduction(for: resource.name,
                                                               production: resource.production - 1)
                                })
                            .font(.subheadline)
                    }
                    .padding(6)
                    .background(Color(.systemGray6))
                    .cornerRadius(8)
                    .frame(minHeight: 120)
                }
            }
            .padding(.horizontal, 8)

            if let session = viewModel.multiplayerSession {
                VStack(alignment: .leading, spacing: 6) {
                    Text("他プレイヤーの資源")
                        .font(.headline)
                    ForEach(session.players.filter { $0.clientId != viewModel.clientIdentifier }) { player in
                        VStack(alignment: .leading, spacing: 2) {
                            Text("\(player.displayName) · TR \(player.tr) · \(player.connected ? "オンライン" : "オフライン")")
                                .font(.subheadline.bold())
                            Text(player.resources.sorted { $0.key < $1.key }.map { "\($0.key): \($0.value.amount) (+\($0.value.production))" }.joined(separator: " · "))
                                .font(.caption)
                        }
                        .padding(6)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color(.systemGray6))
                        .cornerRadius(6)
                    }
                }
                .padding(.horizontal)
            }
        }
        .hideKeyboardOnTap()
    }

    private var multiplayerPanel: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Local multiplayer").font(.headline)
            TextField("ws://192.168.x.x:8080/ws", text: $viewModel.serverURL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .textFieldStyle(.roundedBorder)
            TextField("プレイヤー名", text: $viewModel.displayName)
                .textFieldStyle(.roundedBorder)
            if viewModel.multiplayerSession == nil {
                HStack {
                    Button("Create game") { viewModel.createMultiplayerGame() }
                        .buttonStyle(.borderedProminent)
                    Button("Join game") { viewModel.joinMultiplayerGame() }
                        .buttonStyle(.bordered)
                }
                TextField("Session ID", text: $viewModel.sessionID)
                    .textInputAutocapitalization(.never)
                    .textFieldStyle(.roundedBorder)
                TextField("Join code", text: $viewModel.joinCode)
                    .textInputAutocapitalization(.characters)
                    .textFieldStyle(.roundedBorder)
            } else {
                HStack {
                    Text("Session: \(viewModel.sessionID) · Code: \(viewModel.joinCode)")
                        .font(.caption)
                    Spacer()
                    Button("Leave") { viewModel.leaveMultiplayerGame() }
                        .buttonStyle(.bordered)
                }
            }
            if let error = viewModel.multiplayerError {
                Text(error).foregroundStyle(.red).font(.caption)
            }
        }
        .padding(.horizontal)
    }
}

// MARK: - Keyboard Helper

extension View {
    func hideKeyboardOnTap() -> some View {
        self.onTapGesture {
            UIApplication.shared.sendAction(
                #selector(UIResponder.resignFirstResponder),
                to: nil, from: nil, for: nil
            )
        }
    }
}

// MARK: - Preview

#Preview {
    ContentView()
}
