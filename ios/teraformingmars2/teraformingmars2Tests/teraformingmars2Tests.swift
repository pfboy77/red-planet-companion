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
        var versionedMessage = message
        if versionedMessage["protocolVersion"] == nil {
            versionedMessage["protocolVersion"] = "v1"
        }
        onMessage?(versionedMessage)
    }

    func deliverRaw(_ message: [String: Any]) {
        onMessage?(message)
    }

    func failConnection() {
        isConnected = false
        onDisconnect?()
    }
}

private final class InMemoryResumeTokenStore: ResumeTokenStore {
    var tokens: [String: String] = [:]
    var failWrites = false
    var token: String? { tokens.values.first }
    func load(profileID: UUID?) -> String? { tokens[profileID?.uuidString ?? "legacy"] }
    func save(_ token: String, profileID: UUID?) -> Bool {
        guard !failWrites else { return false }
        tokens[profileID?.uuidString ?? "legacy"] = token
        return true
    }
    func remove(profileID: UUID?) -> Bool { tokens.removeValue(forKey: profileID?.uuidString ?? "legacy"); return true }
    func removeAll() -> Bool { tokens = [:]; return true }
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

    @Test func connectedLeaveAutomaticallyResumesOnceAfterDisconnectAndCompletes() {
        let defaults = isolatedDefaults()
        let client = FakeMultiplayerClient()
        let tokenStore = InMemoryResumeTokenStore()
        let vm = connectedViewModel(defaults: defaults, client: client, multiplayerTR: 20, tokenStore: tokenStore)

        vm.leaveMultiplayerGame()
        #expect(client.sentMessages.last?["type"] as? String == "leaveSession")
        let connectionCount = client.connectedURLs.count

        client.failConnection()

        #expect(vm.isLeavingMultiplayer)
        #expect(client.connectedURLs.count == connectionCount + 1)
        client.deliver(["type": "connectionState", "state": "connected"])
        #expect(client.sentMessages.last?["type"] as? String == "resumeSession")

        client.deliver(["type": "stateSnapshot", "sessionState": sessionObject(revision: 2, playerRevision: 0, tr: 20)])
        #expect(client.sentMessages.last?["type"] as? String == "leaveSession")
        client.deliver(["type": "sessionLeft", "sessionId": testSessionID, "playerId": testPlayerID, "sessionDeleted": false])

        #expect(tokenStore.token == nil)
        #expect(!vm.canResumeSession)
        #expect(client.disconnectCallCount == 1)
        #expect(vm.gameMode == .none)
    }

    @Test func leaveDisconnectRetriesResumeOnlyOnce() {
        let defaults = isolatedDefaults()
        let client = FakeMultiplayerClient()
        let tokenStore = InMemoryResumeTokenStore()
        let vm = connectedViewModel(defaults: defaults, client: client, multiplayerTR: 20, tokenStore: tokenStore)

        vm.leaveMultiplayerGame()
        client.failConnection()
        let connectionCountAfterRetry = client.connectedURLs.count

        client.failConnection()

        #expect(client.connectedURLs.count == connectionCountAfterRetry)
        #expect(vm.isLeavingMultiplayer)
        #expect(vm.canResumeSession)
        #expect(tokenStore.token == testResumeToken)
    }

    @Test func startSoloAutomaticallyResumesLeaveAfterDisconnect() {
        let defaults = isolatedDefaults()
        let client = FakeMultiplayerClient()
        let vm = connectedViewModel(defaults: defaults, client: client, multiplayerTR: 42)

        vm.startSoloGame()
        client.failConnection()
        client.deliver(["type": "connectionState", "state": "connected"])
        #expect(client.sentMessages.last?["type"] as? String == "resumeSession")
        client.deliver(["type": "stateSnapshot", "sessionState": sessionObject(revision: 2, playerRevision: 0, tr: 42)])
        #expect(client.sentMessages.last?["type"] as? String == "leaveSession")
        client.deliver(["type": "sessionLeft", "sessionId": testSessionID, "playerId": testPlayerID, "sessionDeleted": true])

        #expect(vm.gameMode == .solo)
        #expect(vm.tr == 20)
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
        #expect(client.disconnectCallCount == 1)
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

    @Test func playerNotFoundAfterLostLeaveAcknowledgementClearsCredentials() {
        let defaults = isolatedDefaults()
        let client = FakeMultiplayerClient()
        let tokenStore = InMemoryResumeTokenStore()
        let vm = connectedViewModel(defaults: defaults, client: client, multiplayerTR: 20, tokenStore: tokenStore)

        vm.leaveMultiplayerGame()
        client.failConnection()
        client.deliver(["type": "connectionState", "state": "connected"])
        client.deliver([
            "type": "error",
            "errors": [["code": "PLAYER_NOT_FOUND", "message": "Player is not in this session"]],
        ])

        #expect(tokenStore.token == nil)
        #expect(!vm.canResumeSession)
        #expect(!vm.isLeavingMultiplayer)
        #expect(client.disconnectCallCount == 1)
        #expect(vm.gameMode == .none)
    }

    @Test func authenticationFailureDuringLeavePreservesCredentials() {
        let defaults = isolatedDefaults()
        let client = FakeMultiplayerClient()
        let tokenStore = InMemoryResumeTokenStore()
        let vm = connectedViewModel(defaults: defaults, client: client, multiplayerTR: 20, tokenStore: tokenStore)

        vm.leaveMultiplayerGame()
        client.deliver([
            "type": "error",
            "errors": [["code": "AUTHENTICATION_FAILED", "message": "Resume token is invalid"]],
        ])

        #expect(tokenStore.token == testResumeToken)
        #expect(vm.canResumeSession)
        #expect(!vm.isLeavingMultiplayer)
        #expect(client.disconnectCallCount == 1)
        #expect(vm.multiplayerError?.contains("保持") == true)
    }

    @Test func unsupportedServerProtocolVersionDoesNotChangeState() {
        let defaults = isolatedDefaults()
        let client = FakeMultiplayerClient()
        let vm = connectedViewModel(defaults: defaults, client: client, multiplayerTR: 20)

        client.deliverRaw([
            "type": "stateSnapshot",
            "protocolVersion": "v2",
            "sessionState": sessionObject(revision: 2, playerRevision: 1, tr: 99),
        ])

        #expect(vm.tr == 20)
        #expect(vm.connectionState == .connected)
        #expect(vm.multiplayerError?.contains("バージョン") == true)
    }

    @Test func missingServerProtocolVersionDoesNotChangeState() {
        let defaults = isolatedDefaults()
        let client = FakeMultiplayerClient()
        let vm = connectedViewModel(defaults: defaults, client: client, multiplayerTR: 20)

        client.deliverRaw([
            "type": "stateSnapshot",
            "sessionState": sessionObject(revision: 2, playerRevision: 1, tr: 99),
        ])

        #expect(vm.tr == 20)
        #expect(vm.connectionState == .connected)
        #expect(vm.multiplayerError?.contains("バージョン") == true)
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

    @Test func legacyServerURLMigratesToSelectedServerProfile() {
        let defaults = isolatedDefaults()
        defaults.set("ws://192.168.1.20:8080/ws", forKey: "MultiplayerServerURL")

        let vm = GameViewModel(defaults: defaults, multiplayerClient: FakeMultiplayerClient(), tokenStore: InMemoryResumeTokenStore())

        #expect(vm.serverProfiles.count == 1)
        #expect(vm.serverProfiles[0].name == "Migrated Server")
        #expect(vm.serverProfiles[0].webSocketURL == "ws://192.168.1.20:8080/ws")
        #expect(vm.selectedServerID == vm.serverProfiles[0].id)
        #expect(vm.serverURL == vm.serverProfiles[0].webSocketURL)
    }

    @Test func serverProfilesSupportAddEditDeleteSelectAndPersistence() {
        let defaults = isolatedDefaults()
        let vm = GameViewModel(defaults: defaults, multiplayerClient: FakeMultiplayerClient(), tokenStore: InMemoryResumeTokenStore())

        #expect(vm.saveServerProfile(id: nil, name: "Home Server", webSocketURL: "wss://mars.example.com/ws") == nil)
        #expect(vm.saveServerProfile(id: nil, name: "Development Mac", webSocketURL: "ws://192.168.1.20:8080/ws") == nil)
        #expect(vm.serverProfiles.count == 2)
        let homeID = vm.serverProfiles[0].id
        let developmentID = vm.serverProfiles[1].id
        vm.selectServerProfile(id: developmentID)
        #expect(vm.selectedServerID == developmentID)
        #expect(vm.serverURL == "ws://192.168.1.20:8080/ws")

        #expect(vm.saveServerProfile(id: developmentID, name: "Development Server", webSocketURL: "ws://10.0.0.5:8080/ws") == nil)
        vm.deleteServerProfile(id: homeID)
        #expect(vm.serverProfiles.map(\.name) == ["Development Server"])

        let restored = GameViewModel(defaults: defaults, multiplayerClient: FakeMultiplayerClient(), tokenStore: InMemoryResumeTokenStore())
        #expect(restored.serverProfiles.map(\.name) == ["Development Server"])
        #expect(restored.selectedServerID == developmentID)
        #expect(restored.serverURL == "ws://10.0.0.5:8080/ws")
    }

    @Test func privateResumeCredentialCannotBeSentToAnotherServerProfile() {
        let defaults = isolatedDefaults()
        let client = FakeMultiplayerClient()
        let tokenStore = InMemoryResumeTokenStore()
        let vm = connectedViewModel(defaults: defaults, client: client, multiplayerTR: 20, tokenStore: tokenStore)
        let originalServerID = vm.selectedServerID
        client.failConnection()
        #expect(vm.canResumeSession)

        #expect(vm.saveServerProfile(id: nil, name: "Other Server", webSocketURL: "wss://other.example.com/ws") == nil)
        let otherServerID = vm.serverProfiles.first { $0.name == "Other Server" }!.id
        vm.selectServerProfile(id: otherServerID)
        let connectionCount = client.connectedURLs.count

        #expect(!vm.canResumeSession)
        vm.resumeMultiplayerGame()
        #expect(client.connectedURLs.count == connectionCount)
        #expect(vm.multiplayerError?.contains("再接続") == true)

        vm.selectServerProfile(id: originalServerID!)
        #expect(vm.canResumeSession)
    }

    @Test func serverProfileValidationRejectsInvalidNameAndURL() {
        let vm = GameViewModel(defaults: isolatedDefaults(), multiplayerClient: FakeMultiplayerClient(), tokenStore: InMemoryResumeTokenStore())
        #expect(vm.saveServerProfile(id: nil, name: "", webSocketURL: "ws://localhost:8080/ws") != nil)
        #expect(vm.saveServerProfile(id: nil, name: "Bad", webSocketURL: "https://example.com") != nil)
        #expect(vm.serverProfiles.isEmpty)
    }

    @Test func independentPrivateServersSurviveSwitchRestartDeleteAndURLEdit() {
        let defaults = isolatedDefaults()
        let client = FakeMultiplayerClient()
        let tokens = InMemoryResumeTokenStore()
        let vm = connectedViewModel(defaults: defaults, client: client, multiplayerTR: 20, tokenStore: tokens)
        let a = vm.selectedServerID!
        client.failConnection()
        _ = vm.saveServerProfile(id: nil, name: "B", webSocketURL: "wss://b.example.com/ws")
        let b = vm.serverProfiles.last!.id
        vm.selectServerProfile(id: b)
        vm.roomMode = .private
        vm.createMultiplayerGame()
        client.deliver(["type": "connectionState", "state": "connected"])
        let bSession = UUID().uuidString.lowercased()
        var bState = sessionObject(revision: 0, playerRevision: 0, tr: 20)
        bState["sessionId"] = bSession
        client.deliver(["type": "sessionCreated", "sessionId": bSession, "joinCode": "ABC234",
            "playerId": testPlayerID, "roomMode": "private", "resumeToken": "test-token-b", "sessionState": bState])
        client.failConnection()
        #expect(vm.canResumeSession && vm.sessionID == bSession)
        #expect(tokens.load(profileID: b) == "test-token-b")
        vm.selectServerProfile(id: a)
        #expect(vm.canResumeSession && vm.sessionID == testSessionID)
        #expect(tokens.load(profileID: a) == testResumeToken)
        let encoded = String(data: defaults.data(forKey: "RedPlanetServerResumeCredentials")!, encoding: .utf8)!
        #expect(!encoded.contains(testResumeToken) && !encoded.contains("test-token-b"))
        #expect(defaults.string(forKey: "MultiplayerResumeToken") == nil)
        let restored = GameViewModel(defaults: defaults, multiplayerClient: FakeMultiplayerClient(), tokenStore: tokens)
        #expect(restored.canResumeSession && restored.sessionID == testSessionID)
        restored.selectServerProfile(id: b)
        #expect(restored.canResumeSession && restored.sessionID == bSession)
        restored.deleteServerProfile(id: b)
        #expect(restored.canResumeSession && restored.sessionID == testSessionID)
        #expect(tokens.load(profileID: a) == testResumeToken)
        #expect(tokens.load(profileID: b) == nil)
    }

    @Test func changingOtherServerURLInvalidatesOnlyThatProfile() {
        let defaults = isolatedDefaults()
        let client = FakeMultiplayerClient()
        let tokens = InMemoryResumeTokenStore()
        let vm = connectedViewModel(defaults: defaults, client: client, multiplayerTR: 20, tokenStore: tokens)
        let a = vm.selectedServerID!
        client.failConnection()
        _ = vm.saveServerProfile(id: nil, name: "B", webSocketURL: "wss://b.example.com/ws")
        let b = vm.serverProfiles.last!.id
        // Seed B independently through the persisted non-secret metadata model.
        let aData = try! JSONDecoder().decode([ServerResumeCredentials].self, from: defaults.data(forKey: "RedPlanetServerResumeCredentials")!)
        let bData = ServerResumeCredentials(serverProfileID: b, serverURL: "wss://b.example.com/ws", sessionID: "b-session", joinCode: "ABC234", playerID: "b-player", roomMode: .private)
        defaults.set(try! JSONEncoder().encode(aData + [bData]), forKey: "RedPlanetServerResumeCredentials")
        _ = tokens.save("test-token-b", profileID: b)
        let restored = GameViewModel(defaults: defaults, multiplayerClient: FakeMultiplayerClient(), tokenStore: tokens)
        restored.selectServerProfile(id: b)
        _ = restored.saveServerProfile(id: a, name: "A changed", webSocketURL: "wss://changed.example.com/ws")
        #expect(restored.canResumeSession && restored.sessionID == "b-session")
        #expect(tokens.load(profileID: a) == nil)
        #expect(tokens.load(profileID: b) == "test-token-b")
        restored.selectServerProfile(id: a)
        #expect(!restored.canResumeSession)
    }

    @Test func deletingOtherServerPreservesPrivateResume() {
        let defaults = isolatedDefaults()
        let client = FakeMultiplayerClient()
        let tokens = InMemoryResumeTokenStore()
        let vm = connectedViewModel(defaults: defaults, client: client, multiplayerTR: 20, tokenStore: tokens)
        let a = vm.selectedServerID!
        client.failConnection()
        _ = vm.saveServerProfile(id: nil, name: "B", webSocketURL: "wss://b.example.com/ws")
        let b = vm.serverProfiles.last!.id
        vm.selectServerProfile(id: b)
        vm.deleteServerProfile(id: b)
        #expect(vm.canResumeSession)
        #expect(tokens.load(profileID: a) == testResumeToken)
    }

    @Test func legacyMigrationRequiresUnambiguousURLAndSuccessfulKeychainWrite() {
        let defaults = isolatedDefaults()
        let tokens = InMemoryResumeTokenStore()
        defaults.set("ws://old.example.com/ws", forKey: "MultiplayerServerURL")
        defaults.set(testSessionID, forKey: "MultiplayerSessionID")
        defaults.set(testPlayerID, forKey: "MultiplayerPlayerID")
        defaults.set("private", forKey: "MultiplayerRoomMode")
        _ = tokens.save(testResumeToken, profileID: nil)
        tokens.failWrites = true
        let failed = GameViewModel(defaults: defaults, multiplayerClient: FakeMultiplayerClient(), tokenStore: tokens)
        #expect(!failed.canResumeSession)
        #expect(tokens.load(profileID: nil) == testResumeToken)
        #expect(defaults.string(forKey: "MultiplayerSessionID") == testSessionID)
        tokens.failWrites = false
        let migrated = GameViewModel(defaults: defaults, multiplayerClient: FakeMultiplayerClient(), tokenStore: tokens)
        #expect(migrated.canResumeSession)
        #expect(tokens.load(profileID: migrated.selectedServerID) == testResumeToken)
        #expect(tokens.load(profileID: nil) == nil)
        #expect(defaults.string(forKey: "MultiplayerSessionID") == nil)
    }

    @Test func realKeychainKeepsProfilesSeparateAndClearsLegacyAndOrphans() {
        let store = KeychainResumeTokenStore(service: "red-planet-companion.tests.\(UUID().uuidString)")
        defer { _ = store.removeAll() }
        let a = UUID()
        let b = UUID()
        #expect(store.save("test-a", profileID: a))
        #expect(store.save("test-b", profileID: b))
        #expect(store.save("test-legacy", profileID: nil))
        #expect(store.load(profileID: a) == "test-a")
        #expect(store.load(profileID: b) == "test-b")
        #expect(store.save("test-a-updated", profileID: a))
        #expect(store.remove(profileID: b))
        #expect(store.load(profileID: a) == "test-a-updated")
        #expect(store.load(profileID: b) == nil)
        #expect(store.removeAll())
        #expect(store.load(profileID: a) == nil)
        #expect(store.load(profileID: nil) == nil)
    }

    @Test func ambiguousLegacyCredentialDoesNotAttachToSelectedServer() {
        let defaults = isolatedDefaults()
        let date = Date()
        let profiles = ["A", "B"].map { ServerProfile(id: UUID(), name: $0, webSocketURL: "wss://same.example.com/ws", createdAt: date, updatedAt: date) }
        ServerProfileStore(defaults: defaults).save(ServerProfileRegistry(profiles: profiles, selectedServerID: profiles[0].id))
        defaults.set("wss://same.example.com/ws", forKey: "MultiplayerServerURL")
        defaults.set(testSessionID, forKey: "MultiplayerSessionID")
        defaults.set(testPlayerID, forKey: "MultiplayerPlayerID")
        let tokens = InMemoryResumeTokenStore()
        _ = tokens.save(testResumeToken, profileID: nil)
        let vm = GameViewModel(defaults: defaults, multiplayerClient: FakeMultiplayerClient(), tokenStore: tokens)
        #expect(!vm.canResumeSession)
        #expect(tokens.load(profileID: profiles[0].id) == nil)
        #expect(tokens.load(profileID: nil) == testResumeToken)
        _ = vm.saveServerProfile(id: nil, name: "C", webSocketURL: "wss://different.example.com/ws")
        let c = vm.serverProfiles.last!.id
        vm.selectServerProfile(id: c)
        let restarted = GameViewModel(defaults: defaults, multiplayerClient: FakeMultiplayerClient(), tokenStore: tokens)
        #expect(!restarted.canResumeSession)
        #expect(tokens.load(profileID: c) == nil)
        #expect(defaults.string(forKey: "MultiplayerResumeServerURL") == "wss://same.example.com/ws")
    }

    @Test func localDeletionClearsOwnedStateAndPreservesOtherDefaults() {
        let defaults = isolatedDefaults()
        defaults.set("keep", forKey: "UnrelatedComponent")
        let client = FakeMultiplayerClient()
        let tokens = InMemoryResumeTokenStore()
        let vm = connectedViewModel(defaults: defaults, client: client, multiplayerTR: 20, tokenStore: tokens)
        let oldID = vm.clientIdentifier
        _ = tokens.save("orphan-test-token", profileID: UUID())
        _ = tokens.save("legacy-test-token", profileID: nil)
        vm.savePersistentState()
        #expect(vm.deleteAllLocalData())
        #expect(tokens.tokens.isEmpty)
        #expect(vm.gameMode == .none)
        #expect(vm.clientIdentifier != oldID)
        #expect(vm.undoStack.isEmpty && vm.redoStack.isEmpty && vm.deltaValues.isEmpty)
        #expect(defaults.string(forKey: "UnrelatedComponent") == "keep")
        #expect(defaults.data(forKey: "GameStateKey") == nil)
        let restored = GameViewModel(defaults: defaults, multiplayerClient: FakeMultiplayerClient(), tokenStore: tokens)
        #expect(restored.serverProfiles.isEmpty)
        #expect(!restored.canResumeSession)
        #expect(restored.displayName.isEmpty)
        #expect(restored.tr == 20)
    }

    @Test func unreachableSoloRequiresExplicitDiscardAndPreservesOtherProfiles() async {
        let client = FakeMultiplayerClient()
        let tokens = InMemoryResumeTokenStore()
        let vm = connectedViewModel(defaults: isolatedDefaults(), client: client, multiplayerTR: 20,
            tokenStore: tokens, leaveAcknowledgementTimeoutNanoseconds: 1_000_000)
        client.failConnection()
        vm.startSoloGame()
        try? await Task.sleep(nanoseconds: 20_000_000)
        #expect(vm.showingOfflineSoloChoice)
        #expect(vm.canResumeSession)
        #expect(vm.gameMode != .solo)
        let sentCount = client.sentMessages.count
        vm.forgetResumeAndStartSolo()
        #expect(vm.gameMode == .solo)
        #expect(!vm.canResumeSession)
        #expect(tokens.tokens.isEmpty)
        #expect(client.sentMessages.count == sentCount)
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
