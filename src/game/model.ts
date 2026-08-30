import { v4 as uuidv4 } from "uuid";
import { GameState, Resource } from "../types";

export function createInitialResources(): Resource[] {
  return [
    { id: uuidv4(), name: "MC", amount: 0, production: 0, isMegaCredit: true },
    { id: uuidv4(), name: "Steel", amount: 0, production: 0 },
    { id: uuidv4(), name: "Titanium", amount: 0, production: 0 },
    { id: uuidv4(), name: "Plants", amount: 0, production: 0 },
    { id: uuidv4(), name: "Energy", amount: 0, production: 0, isEnergy: true },
    { id: uuidv4(), name: "Heat", amount: 0, production: 0, isHeat: true },
  ];
}

export function createInitialGameState(): GameState {
  return { resources: createInitialResources(), tr: 20 };
}
