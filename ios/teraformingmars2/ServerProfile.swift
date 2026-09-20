import Foundation

struct ServerProfile: Codable, Identifiable, Equatable, Hashable {
    let id: UUID
    var name: String
    var webSocketURL: String
    let createdAt: Date
    var updatedAt: Date
}

struct ServerProfileRegistry: Equatable {
    var profiles: [ServerProfile]
    var selectedServerID: UUID?
}

struct ServerProfileStore {
    private enum Keys {
        static let profiles = "RedPlanetServerProfiles"
        static let selectedServerID = "RedPlanetSelectedServerID"
    }

    let defaults: UserDefaults

    func load(legacyWebSocketURL: String?) -> ServerProfileRegistry {
        var profiles: [ServerProfile] = []
        if let data = defaults.data(forKey: Keys.profiles),
           let decoded = try? JSONDecoder().decode([ServerProfile].self, from: data) {
            profiles = decoded.filter { !$0.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && normalizedWebSocketURL($0.webSocketURL) != nil }
        }

        if profiles.isEmpty, let legacyWebSocketURL, let normalized = normalizedWebSocketURL(legacyWebSocketURL) {
            let timestamp = Date()
            profiles = [ServerProfile(
                id: UUID(),
                name: "Migrated Server",
                webSocketURL: normalized,
                createdAt: timestamp,
                updatedAt: timestamp
            )]
        }

        let savedSelection = defaults.string(forKey: Keys.selectedServerID).flatMap(UUID.init(uuidString:))
        let matchingLegacy = profiles.first { profile in
            normalizedWebSocketURL(profile.webSocketURL) == legacyWebSocketURL.flatMap(normalizedWebSocketURL)
        }
        let selectedServerID = profiles.contains { $0.id == savedSelection }
            ? savedSelection
            : matchingLegacy?.id ?? profiles.first?.id
        let registry = ServerProfileRegistry(profiles: profiles, selectedServerID: selectedServerID)
        save(registry)
        return registry
    }

    func save(_ registry: ServerProfileRegistry) {
        if let data = try? JSONEncoder().encode(registry.profiles) {
            defaults.set(data, forKey: Keys.profiles)
        }
        if let selectedServerID = registry.selectedServerID {
            defaults.set(selectedServerID.uuidString.lowercased(), forKey: Keys.selectedServerID)
        } else {
            defaults.removeObject(forKey: Keys.selectedServerID)
        }
    }
}

func normalizedWebSocketURL(_ value: String) -> String? {
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard var components = URLComponents(string: trimmed),
          let scheme = components.scheme?.lowercased(),
          ["ws", "wss"].contains(scheme),
          let host = components.host, !host.isEmpty else { return nil }
    components.scheme = scheme
    components.host = host.lowercased()
    return components.url?.absoluteString
}
