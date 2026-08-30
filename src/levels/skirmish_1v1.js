import { Terrain } from '../world/Map.js';

// A modest 1v1(+) skirmish map: two mirrored bases with nearby resources,
// a lake and some rocky obstacles in the middle to give pathfinding
// something to route around.
const W = 44, H = 44;

function mirrorNodes(x, y) {
  return [
    { resourceType: 'materials', amount: 10000, x, y, maxHarvesters: 1 },
    // Spaced so the two mines stay visibly separate now that they're drawn
    // wider — at the old +2,+1 their circles nearly met and one's label sat on
    // top of the other.
    { resourceType: 'materials', amount: 10000, x: x + 3, y: y + 1, maxHarvesters: 1 },
  ];
}

const SPAWN_POINTS = [
  { x: 6, y: 6 },
  { x: W - 7, y: H - 7 },
  { x: W - 7, y: 6 },
  { x: 6, y: H - 7 },
];

const RESOURCE_ANCHORS = [
  [9, 9], [W - 11, H - 10], [W - 11, 9], [9, H - 10],
];

const OBSTACLES = [
  { x: 14, y: 10, w: 2, h: 2 }, { x: 28, y: 30, w: 2, h: 2 },
  { x: 22, y: 6, w: 1, h: 3 }, { x: 20, y: 36, w: 1, h: 3 },
  { x: 10, y: 22, w: 3, h: 1 }, { x: 32, y: 20, w: 3, h: 1 },
];

// Deterministic tree scatter: a jittered grid with exclusion zones around
// spawns, resource clusters, obstacles, the lake, and the map edges, so
// trees fill the open "wild" space without blocking anything load-bearing.
function nearAny(x, y, points, minDist) {
  return points.some((p) => Math.hypot(x - p.x, y - p.y) < minDist);
}

function generateTrees() {
  const trees = [];
  for (let gx = 4; gx < W - 3; gx += 4) {
    for (let gy = 4; gy < H - 3; gy += 4) {
      const jitterX = ((gx * 13 + gy * 7) % 5) - 2;
      const jitterY = ((gx * 7 + gy * 17) % 5) - 2;
      const x = gx + jitterX, y = gy + jitterY;

      if (x < 2 || x > W - 3 || y < 2 || y > H - 3) continue;
      if (x >= 16 && x <= 28 && y >= 16 && y <= 28) continue; // lake + margin
      if (nearAny(x, y, SPAWN_POINTS, 5)) continue;
      if (RESOURCE_ANCHORS.some(([rx, ry]) => Math.hypot(x - rx, y - ry) < 4)) continue;
      if (OBSTACLES.some((o) => x >= o.x - 1 && x <= o.x + o.w && y >= o.y - 1 && y <= o.y + o.h)) continue;

      trees.push({ x, y });
    }
  }
  return trees;
}

export const skirmish1v1 = {
  id: 'skirmish_1v1',
  name: 'Twin Hollow',
  width: W,
  height: H,
  spawnPoints: SPAWN_POINTS,
  terrainPatches: [
    { x: 18, y: 18, w: 8, h: 8, type: Terrain.WATER },
    { x: 0, y: 0, w: W, h: 3, type: Terrain.DIRT },
  ],
  obstacles: OBSTACLES,
  resourceNodes: [
    ...mirrorNodes(9, 9),
    ...mirrorNodes(W - 11, H - 10),
    ...mirrorNodes(W - 11, 9),
    ...mirrorNodes(9, H - 10),
  ],
  trees: generateTrees(),
};

export const levelsById = { skirmish_1v1: skirmish1v1 };
