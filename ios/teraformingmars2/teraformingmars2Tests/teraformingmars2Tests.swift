import Foundation
import Testing
@testable import teraformingmars2

@MainActor
private final class FakeMultiplayerClient: MultiplayerClient {
    var onMessage: (([String: Any]) -> Void)?
    var onDisconnect: (() -> Void)?
    var connectedURLs: [URL] = []
    var sentMessages: [[String: Any]] = []
    var isConnected = false
    var disconnectCallCount = 0

    func connect(to url: URL) {
        connectedURLs.append(url)
        isConnected = true
    }

    @discardableResult
    func send(_ message: [String: Any]) -> Bool {
        guard isConnected else { return false }
        sentMessages.append(message)
        return true
    }

    func disconnect() {
        disconnectCallCount += 1
        isConnected = false
    }

    func deliver(_ message: [String: Any]) {
        onMessage?(message)
    }

    func failConnection() {
        isConnected = false
        onDisconnect?()
    }
}

private final class InMemoryResumeTokenStore: ResumeTokenStore {
    var token: String?
    func load() -> String? { token }
    func save(_ token: String) { self.token = token }
    func remove() { token = nil }
}

struct GameReducerTests {
    @Test func initialGameState() {
        let state = createInitialState()
        #expect(state.version == 1)
        #expect(state.tr == 20)
        #expect(state.resources.count == 6)
        #expect(state.resources.allSatisfy { $0.amount == 0 })
        #expect(state.resources.allSatisfy { $0.production == 0 })
    }

    @Test func resourceEquatable() {
        let id = UUID()
        let r1 = Resource(id: id, name: "Test", amount: 10, production: 1, isMegaCredit: true, isEnergy: false, isHeat: false)
        let r2 = Resource(id: id, name: "Test", amount: 10, production: 1, isMegaCredit: true, isEnergy: false, isHeat: false)
        #expect(r1 == r2)
    }

    @Test func addResource() {
        var state = createInitialState()
        if let newState = applyAdd(state: state, resourceName: "Steel", delta: 5) {
            state = newState
            let steel = state.resources.first { $0.name == "Steel" }!
            #expect(steel.amount == 5)
        }
    }

    @Test func subtractResource() {
        var state = createInitialState()
        state.resources[state.resources.firstIndex { $0.name == "Plants" }!].amount = 3
        if let newState = applySubtract(state: state, resourceName: "Plants", delta: 2) {
            state = newState
            let plants = state.resources.first { $0.name == "Plants" }!
            #expect(plants.amount == 1)
        }
    }

    @Test func subtractResourceRejectsMoreThanAvailable() {
        var state = createInitialState()
        state.resources[state.resources.firstIndex { $0.name == "Heat" }!].amount = 3

        let result = applySubtract(state: state, resourceName: "Heat", delta: 99)

        #expect(result == nil)
        #expect(state.resources.first { $0.name == "Heat" }!.amount == 3)
    }

    @Test func multiplayerSubtractMutationRejectsMoreThanLatestAmount() {
        let rejected = validatedResourceMutation(currentAmount: 2, delta: 3, adding: false)
        let accepted = validatedResourceMutation(currentAmount: 5, delta: 3, adding: false)

        #expect(rejected == nil)
        #expect(accepted?.amount == 2)
        #expect(accepted?.operation == "set")
    }

    @Test func productionTransfersEnergyToHeat() {
        var state = createInitialState()
        state.resources[state.resources.firstIndex(where: { $0.isEnergy })!].amount = 2
        let newState = applyProduction(state: state)
        let energy = newState.resources.first { $0.isEnergy }!
        let heat = newState.resources.first { $0.isHeat }!
        #expect(energy.amount == 0)
        #expect(heat.amount == 2)
    }

    @Test func productionAddsProduction() {
        let state = createInitialState()
        let newState = applyProduction(state: state)
        let steel = newState.resources.first { $0.name == "Steel" }!
        #expect(steel.amount == 0) // Steel production=0, not MC so no TR
    }

    @Test func productionAddsTRToMC() {
        let state = createInitialState()
        let newState = applyProduction(state: state)
        let mc = newState.resources.first { $0.isMegaCredit }!
        #expect(mc.amount == 20) // MC=0, production=0, TR=20
    }

    @Test func productionNeverMakesAResourceAmountNegative() {
        var state = createInitialState()
        state.tr = 0
        state.resources[state.resources.firstIndex(where: { $0.isMegaCredit })!].production = -5

        let newState = applyProduction(state: state)

        #expect(newState.resources.first(where: { $0.isMegaCredit })?.amount == 0)
    }

    @Test func resetSetsAllToZero() {
        var state = createInitialState()
        // Manually set some values
        var resources = state.resources
        resources[0].amount = 100
        resources[1].amount = 50
        state.resources = resources

        let newState = applyReset(state: state)
        #expect(newState.tr == 20)
        #expect(newState.resources[0].amount == 0)
        #expect(newState.resources[1].amount == 0)
    }

    @Test func incrementTR() {
        let state = createInitialState()
        let newState = applyIncrementTR(state: state)
        #expect(newState.tr == 21)
    }

    @Test func decrementTR() {
        let state = createInitialState()
        let newState = applyDecrementTR(state: state)
        #expect(newState.tr == 19)
    }

    @Test func trClampedToZero() {
        var state = createInitialState()
        // Set TR to 0 manually
        state.tr = 0
        let newState = applyDecrementTR(state: state)
        #expect(newState.tr == 0)
    }

    @Test func trClampedToHundred() {
        var state = createInitialState()
        state.tr = 100
        let newState = applyIncrementTR(state: state)
        #expect(newState.tr == 100)
    }

    @Test func updateProduction() {
        let state = createInitialState()
        if let newState = applyUpdateProduction(state: state, resourceName: "Steel", newProduction: 5) {
            let steel = newState.resources.first { $0.name == "Steel" }!
            #expect(steel.production == 5)
        }
    }

    @Test func undoRedoCycle() {
        var state = createInitialState()
        var undoStack: [GameSnapshot] = []
        var redoStack: [GameSnapshot] = []

        // Snapshot current
        undoStack = pushSnapshot(to: &undoStack, state: state)

        // Apply change
        if let changed = applyAdd(state: state, resourceName: "Steel", delta: 10) {
            state = changed
        }

        // Undo
        let changed = state
        let restored = popUndo(from: &undoStack)!
        redoStack = pushSnapshot(to: &redoStack, state: changed)
        state = restored
        #expect(state.resources.first { $0.name == "Steel" }!.amount == 0)

        let redone = popRedo(from: &redoStack)!
        state = redone
        #expect(state.resources.first { $0.name == "Steel" }!.amount == 10)
    }

    @Test func gameStateCodable() {
        let state = createInitialState()
        let encoder = JSONEncoder()
        let decoder = JSONDecoder()

        let data = try! encoder.encode(state)
        let decoded = try! decoder.decode(GameState.self, from: data)
        #expect(decoded == state)
    }

    @Test func migrateVersionOneState() {
        let state = createInitialState()
        let data = try! JSONEncoder().encode(state)
        let migrated = migrateGameState(from: data, to: 1)
        #expect(migrated != nil)
        let decoded = try! JSONDecoder().decode(GameState.self, from: migrated!)
        #expect(decoded == state)
    }

    @Test func rejectsUnsupportedMigrationTarget() {
        let data = try! JSONEncoder().encode(createInitialState())
        #expect(migrateGameState(from: data, to: 2) == nil)
    }
}


@Suite(.serialized)
@MainActor
struct ViewModelTests {
    @Test func viewModelInitializesFromDefaults() {
        let defaults = UserDefaults.standard
        defaults.removeObject(forKey: "GameStateKey")
        let vm = GameViewModel()
        #expect(vm.tr == 20)
        #expect(vm.resources.count == 6)
        defaults.removeObject(forKey: "GameStateKey")
    }

    @Test func viewModelSaveAndRestore() {
        let defaults = UserDefaults.standard
        defaults.removeObject(forKey: "GameStateKey")
        let vm = GameViewModel()
        vm.localGameState.tr = 42
        vm.localGameState.resources[0].amount = 100
        vm.savePersistentState()

        let vm2 = GameViewModel()
        #expect(vm2.tr == 42)
        #expect(vm2.resources[0].amount == 100)

        // Clean up
        defaults.removeObject(forKey: "GameStateKey")
    }

    @Test func saveAndRestoreVersion() {
        let defaults = UserDefaults.standard
        defaults.removeObject(forKey: "GameStateKey")
        let vm = GameViewModel()
        vm.savePersistentState()
        let data = defaults.data(forKey: "GameStateKey")
        let state = try! JSONDecoder().decode(GameState.self, from: data!)
        #expect(state.version == 1)
        defaults.removeObject(forKey: "GameStateKey")
    }

    @Test func initialStateVersionIsOne() {
        let state = createInitialState()
        #expect(state.version == 1)
    }

    @Test func trChangesCanBeUndoneAndRedone() {
        let defaults = UserDefaults.standard
        defaults.removeObject(forKey: "GameStateKey")
        let vm = GameViewModel()

        vm.incrementTR()
        #expect(vm.tr == 21)
        vm.undo()
        #expect(vm.tr == 20)
        vm.redo()
        #expect(vm.tr == 21)

        defaults.removeObject(forKey: "GameStateKey")
    }

    @Test func createSessionWaitsForConnectionAndIncludesPlayerIdentity() {
        let defaults = isolatedDefaults()
        let client = FakeMultiplayerClient()
        let vm = GameViewModel(defaults: defaults, multiplayerClient: client)
        vm.serverURL = "ws://192.168.1.20:8080/ws"
        vm.displayName = "Ada"

        vm.createMultiplayerGame()
        #expect(client.sentMessages.isEmpty)

        client.deliver(["type": "connectionState", "state": "connected"])

        #expect(client.sentMessages.count == 1)
        #expect(client.sentMessages[0]["type"] as? String == "createSession")
        #expect(client.sentMessages[0]["clientId"] as? String == vm.clientIdentifier)
        #expect(client.sentMessages[0]["displayName"] as? String == "Ada")
        #expect(client.sentMessages[0]["roomMode"] as? String == "friends")
    }

    @Test func leavingMultiplayerWaitsForAcknowledgementBeforeClearingCredentials() {
        let defaults = isolatedDefaults()
        let client = FakeMultiplayerClient()
        let tokenStore = InMemoryResumeTokenStore()
        let vm = GameViewModel(defaults: defaults, multiplayerClient: client, tokenStore: tokenStore)
        vm.localGameState.tr = 31
        vm.localGameState.resources[0].amount = 9
        vm.savePersistentState()
        vm.serverURL = "ws://192.168.1.20:8080/ws"
        vm.displayName = "Ada"
        vm.createMultiplayerGame()
        client.deliver(["type": "connectionState", "state": "connected"])
        client.deliver([
            "type": "sessionCreated",
            "sessionId": testSessionID,
            "joinCode": "ABC123",
            "playerId": testPlayerID,
            "roomMode": "private",
            "resumeToken": testResumeToken,
            "sessionState": sessionObject(revision: 0, playerRevision: 0, tr: 42),
        ])
        #expect(vm.localGameState.tr == 31)
        #expect(vm.localGameState.resources[0].amount == 9)

        vm.leaveMultiplayerGame()

        #expect(vm.gameMode == .multiplayer)
        #expect(vm.isLeavingMultiplayer)
        let leave = client.sentMessages.last
        #expect(leave?["type"] as? String == "leaveSession")
        #expect(leave?["sessionId"] as? String == testSessionID)
        #expect(leave?["clientId"] == nil)
        #expect(vm.canResumeSession)
        #expect(tokenStore.token == testResumeToken)
        #expect(client.disconnectCallCount == 0)

        client.deliver([
            "type": "sessionLeft",
            "sessionId": testSessionID,
            "playerId": testPlayerID,
            "sessionDeleted": true,
        ])

        #expect(vm.gameMode == .none)
        #expect(!vm.isLeavingMultiplayer)
        #expect(vm.tr == 31)
        #expect(vm.resources[0].amount == 9)
        #expect(!vm.canResumeSession)
        #expect(tokenStore.token == nil)
        #expect(client.disconnectCallCount == 1)
        let restored = GameViewModel(defaults: defaults, multiplayerClient: FakeMultiplayerClient(), tokenStore: InMemoryResumeTokenStore())
        #expect(restored.tr == 31)
        #expect(restored.resources[0].amount == 9)
    }

    @Test func offlineLeaveResumesThenLeavesAndWaitsForAcknowledgement() {
        let defaults = isolatedDefaults()
        let client = FakeMultiplayerClient()
        let tokenStore = InMemoryResumeTokenStore()
        let vm = connectedViewModel(defaults: defaults, client: client, multiplayerTR: 20, tokenStore: tokenStore)
        client.failConnection()
        let connectionCount = client.connectedURLs.count

        vm.leaveMultiplayerGame()

        #expect(vm.isLeavingMultiplayer)
        #expect(client.connectedURLs.count == connectionCount + 1)
        #expect(tokenStore.token == testResumeToken)
        client.deliver(["type": "connectionState", "state": "connected"])
        #expect(client.sentMessages.last?["type"] as? String == "resumeSession")

        client.deliver(["type": "stateSnapshot", "sessionState": sessionObject(revision: 2, playerRevision: 0, tr: 20)])
        #expect(client.sentMessages.last?["type"] as? String == "leaveSession")
        #expect(tokenStore.token == testResumeToken)
        #expect(client.disconnectCallCount == 0)

        client.deliver(["type": "sessionLeft", "sessionId": testSessionID, "playerId": testPlayerID, "sessionDeleted": false])
        #expect(tokenStore.token == nil)
        #expect(client.disconnectCallCount == 1)
        #expect(vm.gameMode == .none)
    }

    @Test func startSoloWaitsForLeaveAcknowledgement() {
        let defaults = isolatedDefaults()
        let client = FakeMultiplayerClient()
        let vm = connectedViewModel(defaults: defaults, client: client, multiplayerTR: 42)

        vm.startSoloGame()

        #expect(vm.gameMode == .multiplayer)
        #expect(vm.isLeavingMultiplayer)
        #expect(client.sentMessages.last?["type"] as? String == "leaveSession")
        client.deliver(["type": "sessionLeft", "sessionId": testSessionID, "playerId": testPlayerID, "sessionDeleted": true])
        #expect(vm.gameMode == .solo)
        #expect(vm.tr == 20)
    }

    @Test func leaveTimeoutKeepsPrivateCredentials() async {
        let defaults = isolatedDefaults()
        let client = FakeMultiplayerClient()
        let tokenStore = InMemoryResumeTokenStore()
        let vm = connectedViewModel(
            defaults: defaults,
            client: client,
            multiplayerTR: 20,
            tokenStore: tokenStore,
            leaveAcknowledgementTimeoutNanoseconds: 10_000_000
        )

        vm.leaveMultiplayerGame()
        try? await Task.sleep(nanoseconds: 50_000_000)

        #expect(!vm.isLeavingMultiplayer)
        #expect(vm.canResumeSession)
        #expect(tokenStore.token == testResumeToken)
        #expect(client.disconnectCallCount == 0)
        #expect(vm.multiplayerError?.contains("保持") == true)
    }

    @Test func sessionNotFoundDuringOfflineLeaveSafelyClearsCredentials() {
        let defaults = isolatedDefaults()
        let client = FakeMultiplayerClient()
        let tokenStore = InMemoryResumeTokenStore()
        let vm = connectedViewModel(defaults: defaults, client: client, multiplayerTR: 20, tokenStore: tokenStore)
        client.failConnection()
        vm.leaveMultiplayerGame()
        client.deliver(["type": "connectionState", "state": "connected"])

        client.deliver([
            "type": "error",
            "errors": [["code": "SESSION_NOT_FOUND", "message": "Session does not exist"]],
        ])

        #expect(tokenStore.token == nil)
        #expect(!vm.canResumeSession)
        #expect(!vm.isLeavingMultiplayer)
        #expect(client.disconnectCallCount == 1)
    }

    @Test func multiplayerSubtractTooMuchDoesNotSendOrClamp() {
        let defaults = isolatedDefaults()
        let client = FakeMultiplayerClient()
        let vm = connectedViewModel(defaults: defaults, client: client, multiplayerTR: 20)
        client.deliver(["type": "stateSnapshot", "sessionState": sessionObject(revision: 1, playerRevision: 0, tr: 20, mcAmount: 3)])
        let baseline = client.sentMessages.count

        vm.subtractResource(resourceNamed: "MC", delta: 10)

        #expect(client.sentMessages.count == baseline)
        #expect(vm.resources.first { $0.name == "MC" }?.amount == 3)
        #expect(vm.multiplayerError != nil)
    }

    @Test func multiplayerSubtractIsBlockedInFlightAndRevalidatedAfterAcceptance() {
        let defaults = isolatedDefaults()
        let client = FakeMultiplayerClient()
        let vm = connectedViewModel(defaults: defaults, client: client, multiplayerTR: 20)
        client.deliver(["type": "stateSnapshot", "sessionState": sessionObject(revision: 1, playerRevision: 0, tr: 20, mcAmount: 5)])
        let baselineCount = client.sentMessages.count

        vm.subtractResource(resourceNamed: "MC", delta: 3)

        #expect(client.sentMessages.count == baselineCount + 1)
        let firstAction = client.sentMessages.last!
        #expect(firstAction["expectedRevision"] as? Int == 0)
        #expect(firstAction["amount"] as? Int == 2)
        #expect(!vm.multiplayerControlsEnabled)

        vm.subtractResource(resourceNamed: "MC", delta: 3)
        #expect(client.sentMessages.count == baselineCount + 1)

        client.deliver(actionAcceptedMessage(
            actionID: firstAction["actionId"] as! String,
            revision: 2,
            playerRevision: 1,
            tr: 20,
            mcAmount: 2
        ))

        #expect(vm.multiplayerControlsEnabled)
        #expect(vm.resources.first { $0.name == "MC" }?.amount == 2)

        vm.subtractResource(resourceNamed: "MC", delta: 3)
        #expect(client.sentMessages.count == baselineCount + 1)
        #expect(vm.resources.first { $0.name == "MC" }?.amount == 2)
        #expect(vm.multiplayerError != nil)
    }

    @Test func staleActionIsNotRetriedAfterFreshSnapshot() {
        let defaults = isolatedDefaults()
        let client = FakeMultiplayerClient()
        let vm = connectedViewModel(defaults: defaults, client: client, multiplayerTR: 20)

        vm.incrementTR()
        let firstAction = client.sentMessages.last!
        let actionID = firstAction["actionId"] as! String
        let countAfterFirstSend = client.sentMessages.count
        client.deliver([
            "type": "actionRejected",
            "actionId": actionID,
            "errors": [["code": "STALE_REVISION", "message": "Revision has changed"]],
        ])
        #expect(client.sentMessages.count == countAfterFirstSend)

        client.deliver([
            "type": "stateSnapshot",
            "sessionState": sessionObject(revision: 3, playerRevision: 3, tr: 23),
        ])

        #expect(client.sentMessages.count == countAfterFirstSend)
        #expect(vm.tr == 23)
        #expect(vm.multiplayerError?.contains("反映されませんでした") == true)
    }

    @Test func foregroundResumeUsesPrivateToken() {
        let defaults = isolatedDefaults()
        let client = FakeMultiplayerClient()
        let vm = connectedViewModel(defaults: defaults, client: client, multiplayerTR: 20)

        vm.handleScenePhase(isActive: false)
        vm.handleScenePhase(isActive: true)
        client.deliver(["type": "connectionState", "state": "connected"])

        let resume = client.sentMessages.last!
        #expect(resume["type"] as? String == "resumeSession")
        #expect(resume["resumeToken"] as? String == testResumeToken)
        #expect(resume["playerId"] as? String == testPlayerID)
        #expect(resume["clientId"] == nil)
        #expect(resume["sessionId"] as? String == testSessionID)
    }

    private var testSessionID: String { "00000000-0000-4000-8000-000000000111" }
    private var testResumeToken: String { "00000000-0000-4000-8000-000000000222" }
    private var testPlayerID: String { "00000000-0000-4000-8000-000000000333" }

    private func isolatedDefaults() -> UserDefaults {
        let name = "teraformingmars2Tests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defaults.removePersistentDomain(forName: name)
        return defaults
    }

    private func connectedViewModel(
        defaults: UserDefaults,
        client: FakeMultiplayerClient,
        multiplayerTR: Int,
        tokenStore: InMemoryResumeTokenStore = InMemoryResumeTokenStore(),
        leaveAcknowledgementTimeoutNanoseconds: UInt64 = 4_000_000_000
    ) -> GameViewModel {
        let vm = GameViewModel(
            defaults: defaults,
            multiplayerClient: client,
            tokenStore: tokenStore,
            leaveAcknowledgementTimeoutNanoseconds: leaveAcknowledgementTimeoutNanoseconds
        )
        vm.serverURL = "ws://192.168.1.20:8080/ws"
        vm.displayName = "Ada"
        vm.roomMode = .private
        vm.createMultiplayerGame()
        client.deliver(["type": "connectionState", "state": "connected"])
        client.deliver([
            "type": "sessionCreated",
            "sessionId": testSessionID,
            "joinCode": "ABC123",
            "playerId": testPlayerID,
            "roomMode": "private",
            "resumeToken": testResumeToken,
            "sessionState": sessionObject(revision: 0, playerRevision: 0, tr: multiplayerTR),
        ])
        return vm
    }

    private func actionAcceptedMessage(actionID: String, revision: Int, playerRevision: Int, tr: Int, mcAmount: Int = 0) -> [String: Any] {
        [
            "type": "actionAccepted",
            "actionId": actionID,
            "revision": revision,
            "playerRevision": playerRevision,
            "sessionState": sessionObject(revision: revision, playerRevision: playerRevision, tr: tr, mcAmount: mcAmount),
        ]
    }

    private func sessionObject(revision: Int, playerRevision: Int, tr: Int, mcAmount: Int = 0) -> [String: Any] {
        var resources = Dictionary(uniqueKeysWithValues: ["MC", "Steel", "Titanium", "Plants", "Energy", "Heat"].map {
            ($0, ["amount": 0, "production": 0])
        })
        resources["MC"] = ["amount": mcAmount, "production": 0]
        return [
            "sessionId": testSessionID,
            "joinCode": "ABC123",
            "roomMode": "private",
            "revision": revision,
            "hostPlayerId": testPlayerID,
            "players": [[
                "playerId": testPlayerID,
                "displayName": "Ada",
                "connected": true,
                "lastSeenAt": "2026-08-09T00:00:00.000Z",
                "revision": playerRevision,
                "tr": tr,
                "resources": resources,
            ]],
        ]
    }

}
