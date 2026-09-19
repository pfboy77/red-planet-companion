import Foundation

// MARK: - Local multiplayer protocol

struct MultiplayerResourceValue: Codable, Equatable {
    var amount: Int
    var production: Int
}

enum RoomMode: String, Codable, CaseIterable {
    case friends
    case `private`
}

enum MultiplayerConnectionState: String {
    case disconnected
    case connecting
    case joining
    case connected
    case reconnecting
}

struct MultiplayerPlayer: Codable, Identifiable, Equatable {
    let playerId: String
    let displayName: String
    let connected: Bool
    let lastSeenAt: String
    let revision: Int
    let tr: Int
    let resources: [String: MultiplayerResourceValue]

    var id: String { playerId }
}

struct MultiplayerSessionState: Codable, Equatable {
    let sessionId: String
    let joinCode: String
    let roomMode: RoomMode
    let revision: Int
    let hostPlayerId: String
    let players: [MultiplayerPlayer]
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
