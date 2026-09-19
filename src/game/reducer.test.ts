import { createInitialGameState } from "./model";
import { changeResource, resetGame, runProduction } from "./reducer";

test("resource changes reject subtraction beyond the current amount", () => {
  const state = createInitialGameState();
  const steel = state.resources.find((resource) => resource.name === "Steel")!;
  expect(changeResource(state, steel.id, -1)).toBeNull();
  expect(state.resources.find((resource) => resource.id === steel.id)?.amount).toBe(0);
});

test("production transfers energy to heat and adds TR to MC", () => {
  const state = createInitialGameState();
  state.resources.find((resource) => resource.name === "Energy")!.amount = 3;
  state.resources.find((resource) => resource.name === "Energy")!.production = 2;
  const next = runProduction(state);
  expect(next.resources.find((resource) => resource.name === "Heat")?.amount).toBe(3);
  expect(next.resources.find((resource) => resource.name === "Energy")?.amount).toBe(2);
  expect(next.resources.find((resource) => resource.name === "MC")?.amount).toBe(20);
});

test("reset returns the canonical initial values", () => {
  const state = createInitialGameState();
  state.tr = 40;
  state.resources[0].amount = 10;
  const next = resetGame(state);
  expect(next.tr).toBe(20);
  expect(next.resources.every((resource) => resource.amount === 0 && resource.production === 0)).toBe(true);
});
