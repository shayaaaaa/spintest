// Tunable constants shared across systems — kept in one place so balance
// passes don't require touching engine code.
export const balance = {
  startingResources: { materials: 200, energy: 50 },
  startingSupplyCap: 10,
  maxSupply: 100,
  unitSoftCap: 200,
  heroXpBase: 100,
  heroXpGrowth: 1.35,
};
