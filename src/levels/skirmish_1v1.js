import { Terrain } from '../world/Map.js';

// A modest 1v1(+) skirmish map: two mirrored bases with nearby resources,
// a lake and some rocky obstacles in the middle to give pathfinding
// something to route around.
const W = 44, H = 44;

function mirrorNodes(x, y) {
  return [
    { resourceType: 'materials', amount: 900, x, y, maxHarvesters: 3 },
    { resourceType: 'materials', amount: 900, x: x + 2, y: y + 1, maxHarvesters: 3 },
    { resourceType: 'energy', amount: 500, x: x + 1, y: y - 2, maxHarvesters: 2 },
  ];
}

export const skirmish1v1 = {
  id: 'skirmish_1v1',
  name: 'Twin Hollow',
  width: W,
  height: H,
  spawnPoints: [
    { x: 6, y: 6 },
    { x: W - 7, y: H - 7 },
    { x: W - 7, y: 6 },
    { x: 6, y: H - 7 },
  ],
  terrainPatches: [
    { x: 18, y: 18, w: 8, h: 8, type: Terrain.WATER },
    { x: 0, y: 0, w: W, h: 3, type: Terrain.DIRT },
  ],
  obstacles: [
    { x: 14, y: 10, w: 2, h: 2 }, { x: 28, y: 30, w: 2, h: 2 },
    { x: 22, y: 6, w: 1, h: 3 }, { x: 20, y: 36, w: 1, h: 3 },
    { x: 10, y: 22, w: 3, h: 1 }, { x: 32, y: 20, w: 3, h: 1 },
  ],
  resourceNodes: [
    ...mirrorNodes(9, 9),
    ...mirrorNodes(W - 11, H - 10),
    ...mirrorNodes(W - 11, 9),
    ...mirrorNodes(9, H - 10),
  ],
};

export const levelsById = { skirmish_1v1: skirmish1v1 };
