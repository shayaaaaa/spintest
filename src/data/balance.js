// Tunable constants shared across systems — kept in one place so balance
// passes don't require touching engine code.
export const balance = {
  startingResources: { materials: 200, lumber: 0 },
  maxPopulation: 20, // flat population cap; workers=1, combat units=2, heroes=5 (per-unit supplyCost)
  unitSoftCap: 200,
  heroXpBase: 100,
  heroXpGrowth: 1.35,
};
