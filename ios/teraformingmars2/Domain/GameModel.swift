import Foundation

// MARK: - Local multiplayer protocol

struct MultiplayerResourceValue: Codable {
    var amount: Int
    var production: Int
}

struct MultiplayerPlayer: Codable, Identifiable {
    let playerId: String
    let clientId: String
    let displayName: String
    let connected: Bool
    let lastSeenAt: String
    let tr: Int
    let resources: [String: MultiplayerResourceValue]

    var id: String { playerId }
}

struct MultiplayerSessionState: Codable {
    let sessionId: String
    let joinCode: String
    let revision: Int
    let players: [MultiplayerPlayer]
}

/// Small URLSessionWebSocketTask wrapper shared by the iOS game view model.
final class LocalMultiplayerClient {
    var onMessage: (([String: Any]) -> Void)?
    var onDisconnect: (() -> Void)?
    private var task: URLSessionWebSocketTask?

    var isConnected: Bool { task?.state == .running }

    func connect(to url: URL) {
        disconnect()
        let nextTask = URLSession.shared.webSocketTask(with: url)
        task = nextTask
        nextTask.resume()
        receive(from: nextTask)
    }

    func send(_ message: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: message),
              let text = String(data: data, encoding: .utf8) else { return }
        task?.send(.string(text)) { [weak self] error in
            if error != nil { Task { @MainActor in self?.onDisconnect?() } }
        }
    }

    func disconnect() {
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
    }

    private func receive(from task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            Task { @MainActor in
                guard let self else { return }
                switch result {
                case .success(let message):
                    if case .string(let text) = message,
                       let data = text.data(using: .utf8),
                       let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                        self.onMessage?(object)
                    }
                    self.receive(from: task)
                case .failure:
                    self.task = nil
                    self.onDisconnect?()
                }
            }
        }
    }
}

// MARK: - Resource

struct Resource: Identifiable, Codable, Equatable, Hashable {
    let id: UUID
    var name: String
    var amount: Int
    var production: Int
    var isMegaCredit: Bool
    var isEnergy: Bool
    var isHeat: Bool

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

    init(id: UUID = UUID(), name: String, amount: Int, production: Int, isMegaCredit: Bool = false, isEnergy: Bool = false, isHeat: Bool = false) {
        self.id = id
        self.name = name
        self.amount = amount
        self.production = production
        self.isMegaCredit = isMegaCredit
        self.isEnergy = isEnergy
        self.isHeat = isHeat
    }

    static func == (lhs: Resource, rhs: Resource) -> Bool {
        lhs.id == rhs.id &&
        lhs.name == rhs.name &&
        lhs.amount == rhs.amount &&
        lhs.production == rhs.production &&
        lhs.isMegaCredit == rhs.isMegaCredit &&
        lhs.isEnergy == rhs.isEnergy &&
        lhs.isHeat == rhs.isHeat
    }
}

// MARK: - GameState

struct GameState: Codable, Equatable {
    var version: Int
    var resources: [Resource]
    var tr: Int
}

extension GameState {
    static let initial = GameState(version: 1, resources: Resource.initialResources, tr: 20)
}

// MARK: - GameSnapshot (for Undo/Redo)

struct GameSnapshot: Codable, Equatable {
    let resources: [Resource]
    let tr: Int
}
