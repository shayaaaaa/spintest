import { findPath } from '../world/Pathfinding.js';

const ARRIVE_EPS = 0.08;
const SEPARATION_RADIUS = 0.6;
const SEPARATION_STRENGTH = 1.6;
// Within this distance of a unit's *final* waypoint, separation tapers off
// entirely so units can actually settle at a shared destination instead of
// neighbors continuously shoving them back out of the arrival radius.
const SEPARATION_TAPER_RADIUS = 0.4;

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
    unit.finalTargetPrecise = isPreciseFinalTarget(unit.path, tx, ty);
  });
}

// True when the path's last waypoint is genuinely the requested tile — i.e.
// (tx,ty) was walkable and findPath went straight there. False when the
// requested tile was blocked (e.g. a building's center) and findPath
// silently substituted the nearest walkable neighbor instead: that
// substitute is only a tile, with no sub-tile precision behind it, so it's
// wrong to steer at the original (unreachable) point in that case — see the
// isFinalWaypoint branch in updateMovement.
function isPreciseFinalTarget(path, tx, ty) {
  const last = path[path.length - 1];
  return !!last && last.tx === Math.floor(tx) && last.ty === Math.floor(ty);
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
    const isFinalWaypoint = unit.pathIndex === unit.path.length - 1;
    // Intermediate waypoints are tile-centers purely for routing around
    // obstacles. The *final* one should be the exact destination that was
    // actually requested (unit.moveTarget, already stored at full precision
    // by moveUnitTo) rather than the center of whichever tile it floors
    // into — snapping the final stop to a tile center means two different
    // requested destinations only need to floor onto the same tile to
    // collapse into one literal shared target, which is exactly how
    // multiple units end up fighting over "the same spot" even when each
    // was given its own distinct point to head to.
    //
    // That only holds when the requested point was itself walkable, though
    // (finalTargetPrecise) — if it was blocked (e.g. a building's center)
    // and findPath silently substituted the nearest walkable tile instead,
    // steering at the original unreachable point would send every unit
    // toward that same blocked spot regardless of which substitute tile
    // their own path actually resolved to. In that case the substitute
    // tile's center is the most precision there is.
    const target = (isFinalWaypoint && unit.finalTargetPrecise) ? unit.moveTarget : { x: wp.tx + 0.5, y: wp.ty + 0.5 };
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
    // so groups don't perfectly overlap — tapered out near the final
    // waypoint so units can settle at a shared destination instead of
    // fighting their neighbors for it forever.
    let steerX = dx / dist;
    let steerY = dy / dist;
    if (!isFinalWaypoint || dist > SEPARATION_TAPER_RADIUS) {
      const [sepX, sepY] = separation(ctx, unit);
      steerX += sepX * SEPARATION_STRENGTH;
      steerY += sepY * SEPARATION_STRENGTH;
    }
    const steerLen = Math.hypot(steerX, steerY) || 1;

    // Never step further than the remaining distance to the waypoint —
    // without this, a unit within one tick's travel of a waypoint
    // overshoots past it every frame, and combined with separation's
    // restoring push that overshoot becomes a stable back-and-forth
    // oscillation instead of settling.
    const step = Math.min(unit.speed * dt, dist);
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
  unit.finalTargetPrecise = isPreciseFinalTarget(unit.path, unit.moveTarget.x, unit.moveTarget.y);
}
