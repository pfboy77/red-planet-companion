import { GameState } from "../types";

export function changeResource(state: GameState, resourceId: string, delta: number): GameState | null {
  const resource = state.resources.find((item) => item.id === resourceId);
  if (!resource || delta === 0 || resource.amount + delta < 0) return null;
  return {
    ...state,
    resources: state.resources.map((item) => item.id === resourceId ? { ...item, amount: item.amount + delta } : item),
  };
}

export function runProduction(state: GameState): GameState {
  let resources = state.resources.map((resource) => ({ ...resource }));
  const energy = resources.find((resource) => resource.isEnergy);
  const heat = resources.find((resource) => resource.isHeat);
  if (energy && heat) {
    heat.amount += energy.amount;
    energy.amount = 0;
  }
  resources = resources.map((resource) => ({
    ...resource,
    amount: Math.max(0, resource.amount + resource.production + (resource.isMegaCredit ? state.tr : 0)),
  }));
  return { ...state, resources };
}

export function resetGame(state: GameState): GameState {
  return { tr: 20, resources: state.resources.map((resource) => ({ ...resource, amount: 0, production: 0 })) };
}
