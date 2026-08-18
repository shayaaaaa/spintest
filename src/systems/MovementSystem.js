import { findPath } from '../world/Pathfinding.js';

const ARRIVE_EPS = 0.05;
const SEPARATION_RADIUS = 0.6;
const SEPARATION_STRENGTH = 1.6;

// Issues a move order: sets state, requests a path via the shared queue.
// `onArrive` (optional) fires once the unit reaches the destination —
// used by attack-move / gather / rally-point flows to chain a next action.
export function moveUnitTo(ctx, unit, tx, ty, onArrive = null) {
  unit.state = 'moving';
  unit.moveTarget = { x: tx, y: ty };
  unit.path = null;
  unit.pathIndex = 0;
  unit.onArrive = onArrive;
  ctx.pathQueue.request(Math.floor(unit.x), Math.floor(unit.y), Math.floor(tx), Math.floor(ty), (path) => {
    // Unit may have been given a new order while the request was queued.
    if (unit.state !== 'moving' || !unit.moveTarget || unit.moveTarget.x !== tx || unit.moveTarget.y !== ty) return;
    unit.path = path || [];
    unit.pathIndex = 0;
  });
}

export function stopUnit(unit) {
  unit.state = 'idle';
  unit.path = null;
  unit.moveTarget = null;
  unit.onArrive = null;
}

export function updateMovement(ctx, dt) {
  ctx.pathQueue.drain();

  for (const unit of ctx.store.all) {
    if (unit.kind !== 'unit' || unit.state !== 'moving') continue;
    if (unit.stunnedUntil && unit.stunnedUntil > ctx.time) continue;
    if (!unit.path) continue; // path still pending

    if (unit.path.length === 0) {
      arrive(ctx, unit);
      continue;
    }

    const wp = unit.path[unit.pathIndex];
    const target = { x: wp.tx + 0.5, y: wp.ty + 0.5 };
    let dx = target.x - unit.x;
    let dy = target.y - unit.y;
    let dist = Math.hypot(dx, dy);

    if (dist < ARRIVE_EPS) {
      unit.pathIndex++;
      if (unit.pathIndex >= unit.path.length) {
        arrive(ctx, unit);
        continue;
      }
      continue;
    }

    // Steer toward waypoint, with light separation from nearby moving units
    // so groups don't perfectly overlap.
    let steerX = dx / dist;
    let steerY = dy / dist;
    const [sepX, sepY] = separation(ctx, unit);
    steerX += sepX * SEPARATION_STRENGTH;
    steerY += sepY * SEPARATION_STRENGTH;
    const steerLen = Math.hypot(steerX, steerY) || 1;

    const step = unit.speed * dt;
    unit.x += (steerX / steerLen) * step;
    unit.y += (steerY / steerLen) * step;
    unit.facing = Math.atan2(steerY, steerX);
  }
}

function separation(ctx, unit) {
  let ox = 0, oy = 0;
  for (const other of ctx.spatialGrid.queryRadius(unit.x, unit.y, SEPARATION_RADIUS)) {
    if (other === unit || other.kind !== 'unit') continue;
    const dx = unit.x - other.x, dy = unit.y - other.y;
    const d = Math.hypot(dx, dy);
    if (d > 0 && d < SEPARATION_RADIUS) {
      const push = (SEPARATION_RADIUS - d) / SEPARATION_RADIUS;
      ox += (dx / d) * push;
      oy += (dy / d) * push;
    }
  }
  return [ox, oy];
}

function arrive(ctx, unit) {
  unit.path = null;
  unit.moveTarget = null;
  const cb = unit.onArrive;
  unit.onArrive = null;
  if (cb) {
    cb(ctx, unit);
  } else {
    unit.state = 'idle';
  }
}

// Recompute a path immediately (used sparingly, e.g. when an obstacle
// appears right under a unit) rather than going through the queue.
export function repathNow(ctx, unit) {
  if (!unit.moveTarget) return;
  const path = findPath(ctx.map.grid, Math.floor(unit.x), Math.floor(unit.y), Math.floor(unit.moveTarget.x), Math.floor(unit.moveTarget.y));
  unit.path = path || [];
  unit.pathIndex = 0;
}
