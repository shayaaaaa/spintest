import { Grid } from './Grid.js';

// Terrain type ids used for rendering variety and (later) movement modifiers.
export const Terrain = {
  GRASS: 0,
  DIRT: 1,
  WATER: 2, // unwalkable
  CLIFF: 3, // unwalkable
};

export class GameMap {
  constructor(levelData) {
    this.width = levelData.width;
    this.height = levelData.height;
    this.grid = new Grid(this.width, this.height);
    this.terrain = new Uint8Array(this.width * this.height).fill(Terrain.GRASS);
    this.spawnPoints = levelData.spawnPoints || [];
    this.resourceNodeSpecs = levelData.resourceNodes || [];

    this._applyTerrainPatches(levelData.terrainPatches || []);
    this._applyObstacles(levelData.obstacles || []);
  }

  _applyTerrainPatches(patches) {
    for (const patch of patches) {
      for (let y = patch.y; y < patch.y + patch.h; y++) {
        for (let x = patch.x; x < patch.x + patch.w; x++) {
          if (!this.grid.inBounds(x, y)) continue;
          this.terrain[this.grid.index(x, y)] = patch.type;
          if (patch.type === Terrain.WATER || patch.type === Terrain.CLIFF) {
            this.grid.setBlocked(x, y, true);
          }
        }
      }
    }
  }

  _applyObstacles(obstacles) {
    for (const ob of obstacles) {
      this.grid.setRectBlocked(ob.x, ob.y, ob.w || 1, ob.h || 1, true);
    }
  }

  terrainAt(tx, ty) {
    if (!this.grid.inBounds(tx, ty)) return Terrain.CLIFF;
    return this.terrain[this.grid.index(tx, ty)];
  }
}
