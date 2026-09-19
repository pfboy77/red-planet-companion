import Foundation

func createInitialState() -> GameState {
    GameState.initial
}

func snapshot(_ state: GameState) -> GameSnapshot {
    GameSnapshot(resources: state.resources, tr: state.tr)
}

func restore(from snapshot: GameSnapshot, version: Int) -> GameState {
    GameState(version: version, resources: snapshot.resources, tr: snapshot.tr)
}

// MARK: - Actions

// Add amount to a resource by name
func applyAdd(state: GameState, resourceName: String, delta: Int) -> GameState? {
    guard delta > 0 else { return nil }
    var resources = state.resources
    guard let index = resources.firstIndex(where: { $0.name == resourceName }) else { return nil }
    resources[index].amount += delta
    return GameState(version: state.version, resources: resources, tr: state.tr)
}

// Subtract amount from a resource by name
func applySubtract(state: GameState, resourceName: String, delta: Int) -> GameState? {
    guard delta > 0 else { return nil }
    var resources = state.resources
    guard let index = resources.firstIndex(where: { $0.name == resourceName }) else { return nil }
    guard delta <= resources[index].amount else { return nil }
    resources[index].amount -= delta
    return GameState(version: state.version, resources: resources, tr: state.tr)
}

func validatedResourceMutation(currentAmount: Int, delta: Int, adding: Bool) -> (amount: Int, operation: String)? {
    guard delta > 0 else { return nil }
    if adding { return (delta, "add") }
    guard delta <= currentAmount else { return nil }
    return (currentAmount - delta, "set")
}

// Production phase
func applyProduction(state: GameState) -> GameState {
    var resources = state.resources

    // Transfer Energy → Heat
    if let energyIndex = resources.firstIndex(where: { $0.isEnergy }),
       let heatIndex = resources.firstIndex(where: { $0.isHeat }) {
        let energyAmount = resources[energyIndex].amount
        resources[heatIndex].amount += energyAmount
        resources[energyIndex].amount = 0
    }

    // Production + MC based on TR
    for i in 0..<resources.count {
        let r = resources[i]
        let productionGain = r.production + (r.isMegaCredit ? state.tr : 0)
        resources[i].amount = max(0, resources[i].amount + productionGain)
    }

    return GameState(version: state.version, resources: resources, tr: state.tr)
}

// Reset all resources to 0, TR to 20
func applyReset(state: GameState) -> GameState {
    let zeroResources = state.resources.map {
        Resource(id: $0.id, name: $0.name, amount: 0, production: 0,
                 isMegaCredit: $0.isMegaCredit, isEnergy: $0.isEnergy, isHeat: $0.isHeat)
    }
    return GameState(version: state.version, resources: zeroResources, tr: 20)
}

// Increment TR
func applyIncrementTR(state: GameState) -> GameState {
    let newTR = min(state.tr + 1, 100)
    return GameState(version: state.version, resources: state.resources, tr: newTR)
}

// Decrement TR
func applyDecrementTR(state: GameState) -> GameState {
    let newTR = max(state.tr - 1, 0)
    return GameState(version: state.version, resources: state.resources, tr: newTR)
}

// Update production for a resource
func applyUpdateProduction(state: GameState, resourceName: String, newProduction: Int) -> GameState? {
    var resources = state.resources
    guard let index = resources.firstIndex(where: { $0.name == resourceName }) else { return nil }
    let minProd = resources[index].isMegaCredit ? -5 : 0
    let clamped = max(minProd, min(newProduction, 20))
    resources[index].production = clamped
    return GameState(version: state.version, resources: resources, tr: state.tr)
}

// MARK: - Undo/Redo

func pushSnapshot(to stack: inout [GameSnapshot], state: GameState) -> [GameSnapshot] {
    var stack = stack
    stack.append(snapshot(state))
    if stack.count > 20 { stack.removeFirst() }
    return stack
}

func popUndo(from stack: inout [GameSnapshot]) -> GameState? {
    guard let snapshot = stack.popLast() else { return nil }
    return restore(from: snapshot, version: 1)
}

func popRedo(from stack: inout [GameSnapshot]) -> GameState? {
    guard let snapshot = stack.popLast() else { return nil }
    return restore(from: snapshot, version: 1)
}

// MARK: - Migration

func migrateGameState(from data: Data, to targetVersion: Int) -> Data? {
    guard targetVersion == 1 else { return nil }

    let decoder = JSONDecoder()
    guard var state = try? decoder.decode(GameState.self, from: data),
          state.version <= targetVersion else {
        return nil
    }

    state.version = targetVersion
    return try? JSONEncoder().encode(state)
}
