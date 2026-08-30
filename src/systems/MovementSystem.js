
const ARRIVE_EPS = 0.08;
// Intermediate waypoints only exist to steer a unit around obstacles, so being
// anywhere inside the tile counts as having reached one; only the final
// waypoint, the actual destination, needs sub-tile precision. Demanding
// ARRIVE_EPS of every waypoint is a trap: neighbours pressing on a unit can
// easily hold it a tenth of a tile off a waypoint's exact centre, which is
// close enough to be plainly there and still too far to count as arrived, and
// it then circles that point forever without ever advancing to the next one.
const WAYPOINT_EPS = 0.45;
// Trips shorter than this ignore crowd routing — see moveUnitTo.
const CROWD_AVOIDANCE_MIN_TRIP = 3;
// A path is computed once and then followed, so it can go stale: units that
// were not there when it was planned can settle across it afterwards — a gather
// queue forming over the route a worker had already set off along, most
// obviously. The worker then keeps pressing into a wall that did not exist when
// it set out, and without noticing it will do so indefinitely. So a unit that
// stops making headway toward its next waypoint replans against the world as it
// is now, which is also when the crowd cost above gets a chance to route it
// around the obstruction.
const STUCK_REPATH_SECONDS = 1.2;
const STUCK_PROGRESS_EPS = 0.08;
// How close two particular units can get before they are visibly touching: the
// sum of the radii their sprites are actually drawn at (see bodyRadiusOf in
// entities/Unit.js). It varies by more than a third across the roster — a
// hexagon vehicle is far wider than a worker — so it is measured per pair
// rather than assumed. Avoidance deliberately begins well outside it (see
// SEPARATION_RADIUS) so a unit has room to steer clear rather than only
// reacting once it is already on top of someone.
function contactDistance(a, b) {
  return (a.bodyRadius ?? 0.27) + (b.bodyRadius ?? 0.27);
}
// Widest body in the roster, for the fixed spacing rules (queue gaps, follow
// distances) that have to hold for whatever unit happens to be involved.
const MAX_UNIT_DIAMETER = 0.79;
// Wider than the sprite on purpose: avoidance has to begin early enough that a
// unit can actually slide clear before it arrives on top of its neighbour.
const SEPARATION_RADIUS = 1.0;
const SEPARATION_STRENGTH = 2.4;
// Separation is capped below the seek vector's magnitude (which is always 1,
// being a unit vector). Combined with the perpendicular projection in
// updateMovement, this is what makes oscillation structurally impossible
// rather than merely tuned-away: see the comment there.
const SEPARATION_MAX = 0.9;
// Avoidance eases out over the last stretch of a unit's *own* final approach so
// it commits to its assigned spot and lands on it. Without this a lingering
// sideways push makes a unit skate around its own destination and never reach
// the arrival threshold — an orbit instead of a stop. It's safe to let go of
// avoidance here because every assigned destination (harvest slot, queue-line
// spot, formation offset) is already spaced wider apart than the units are,
// so units that have settled cannot be overlapping in the first place.
const ARRIVE_COMMIT_RADIUS = 0.55;
// How fast contact resolution can separate two bodies. Must stay well under how
// fast units actually travel (a worker does 2.6): resolution is a correction,
// not a means of locomotion, and if it can outrun a unit's own movement it stops
// being subordinate to it and becomes a second force competing with
// goal-seeking — tried at 4.0 and it produced exactly the shoved-back-and-forth
// oscillation and stalled units that the steering design exists to rule out.
const BODY_SEPARATION_SPEED = 1.3;
// Units genuinely inside one another — dropped onto the same spot, or shoved
// together by something else — are a different case from two brushing past each
// other, and get separated much faster. Raising the speed for *shallow* contact
// is what misbehaved at 4.0, because there it competes with a unit's own
// travel; deep overlap is never ambiguous and never wants to be left standing,
// so urgency is scaled by how far inside each other the bodies actually are.
const BODY_SEPARATION_DEEP_SPEED = 4.0;
const BODY_SEPARATION_DEEP_FRACTION = 0.4;
// Convoy following. When the queue shuffles forward, a worker still walking to
// its old place gets retargeted one place closer, so it now has further to go
// than the worker ahead of it and closes the gap — measured as the single
// biggest remaining source of sprite overlap, all of it landing on the queue
// line itself. Braking behind whoever is directly ahead fixes that, and can
// only ever scale forward speed down, never reverse it, so it cannot introduce
// oscillation. It applies only to a neighbour travelling roughly the same way:
// yielding to one coming head-on would have both units stop and wait for each
// other. A neighbour standing still is handled separately — generally by
// sliding around it, and within a queue by QUEUE_FOLLOW_GAP below.
const FOLLOW_DISTANCE = 1.0;
const FOLLOW_LANE_HALFWIDTH = 0.55;
// Tight on purpose. Two units only ever brake for each other if each is "ahead"
// of the other, which is impossible once their headings are required to agree
// within about 45 degrees — a loose threshold here let two units on diverging
// paths each yield to the other and both stop dead, permanently.
const FOLLOW_SAME_DIR_DOT = 0.7;
// A brake never brings a unit to a full stop, so no arrangement of units can
// stall one indefinitely; it only ever yields to a neighbour that is itself
// still moving, and that neighbour pulling away reopens the gap.
const FOLLOW_MIN_SCALE = 0.15;
// Sub-tile offset applied to every waypoint that is just a tile center. Two
// units routing through the same tile would otherwise steer at the identical
// point at its middle and pile up there — measured in the live game as the
// single remaining overlap hotspot, every deep overlap landing on one exact
// tile center. Giving each unit its own stable spot inside the tile removes the
// shared target; this is the same idea as the subcells real RTS engines divide
// each cell into. It also spreads workers out around a blocked destination like
// the Townhall, where the path resolves to one substitute tile for everybody.
const SUBCELL_RADIUS = 0.34;
// Queue discipline. A worker stepping forward in a line must not walk into
// whoever is ahead of it, even while that one is still standing still: during a
// reflow the whole line is retargeted at once but they do not all start moving
// on the same tick, so a follower would otherwise treat its stalled leader as a
// static obstacle and slide around it, ending up alongside instead of behind.
// Like the general follow-brake it never brings a unit to a complete stop. An
// earlier version did, reasoning that a queue always drains from its front so
// any obstruction must eventually clear — but that assumes a queue already in
// order. Workers that begin standing on the line instead brake against each
// other in a ring, nothing drains, and the group locks up for good; testing
// caught it as a worker stalled for a full minute and an economy that never
// earned a single resource. Keeping every brake strictly above zero preserves
// the property this whole design rests on: every unit closes some distance on
// its goal every tick, so nothing can deadlock.
// Kept below LINE_SPACING so a worker can still reach its own place in the line
// (it stops short only if it has closed to nearer than the worker ahead's spot),
// and above the width of a worker so it stops before their bodies touch
// (gather queues only ever hold workers, the narrowest body in the roster).
const QUEUE_FOLLOW_GAP = 0.7;

// Issues a move order: sets state, requests a path via the shared queue.
// `onArrive` (optional) fires once the unit reaches the destination —
// used by attack-move / gather / rally-point flows to chain a next action.
export function moveUnitTo(ctx, unit, tx, ty, onArrive = null) {
  unit.state = 'moving';
  unit.moveTarget = { x: tx, y: ty };
  unit.path = null;
  unit.pathIndex = 0;
  unit.onArrive = onArrive;
  unit.stuckBest = undefined;
  unit.stuckSince = ctx.time;
  requestPathFor(ctx, unit, tx, ty);
}

// Queues the actual path request for a unit already set up to move toward
// (tx,ty). Separate from moveUnitTo so a repath can reissue it without
// disturbing the unit's order, arrival callback or destination.
function requestPathFor(ctx, unit, tx, ty) {
  // Long trips route around crowds; short ones don't. A worker shuffling one
  // place up its queue is moving less than a tile, and letting a detour cost
  // reshape a move that small would send it looping around its own neighbours
  // instead of simply stepping forward.
  const avoidCrowds = Math.hypot(tx - unit.x, ty - unit.y) > CROWD_AVOIDANCE_MIN_TRIP;
  ctx.pathQueue.request(Math.floor(unit.x), Math.floor(unit.y), Math.floor(tx), Math.floor(ty), (path) => {
    // Unit may have been given a new order while the request was queued.
    if (unit.state !== 'moving' || !unit.moveTarget || unit.moveTarget.x !== tx || unit.moveTarget.y !== ty) return;
    unit.path = path || [];
    // A path starts with the tile the unit is already standing on. Walking to
    // that tile's centre achieves nothing and, when neighbours are crowding the
    // unit, may not even be reachable — so start from the first waypoint that
    // actually goes somewhere.
    unit.pathIndex = (unit.path.length > 1
      && unit.path[0].tx === Math.floor(unit.x)
      && unit.path[0].ty === Math.floor(unit.y)) ? 1 : 0;
    unit.finalTargetPrecise = isPreciseFinalTarget(unit.path, tx, ty);
  }, avoidCrowds);
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
  ctx.pathQueue.drain(stationaryOccupancy(ctx));

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
    const target = (isFinalWaypoint && unit.finalTargetPrecise)
      ? unit.moveTarget
      : { x: wp.tx + 0.5 + subCellX(unit), y: wp.ty + 0.5 + subCellY(unit) };
    let dx = target.x - unit.x;
    let dy = target.y - unit.y;
    let dist = Math.hypot(dx, dy);

    if (unit.stuckBest === undefined || dist < unit.stuckBest - STUCK_PROGRESS_EPS) {
      unit.stuckBest = dist;
      unit.stuckSince = ctx.time;
    } else if (ctx.time - unit.stuckSince > STUCK_REPATH_SECONDS) {
      unit.stuckBest = undefined;
      unit.stuckSince = ctx.time;
      requestPathFor(ctx, unit, unit.moveTarget.x, unit.moveTarget.y);
      continue;
    }

    if (dist < (isFinalWaypoint ? ARRIVE_EPS : WAYPOINT_EPS)) {
      unit.pathIndex++;
      unit.stuckBest = undefined;
      unit.stuckSince = ctx.time;
      if (unit.pathIndex >= unit.path.length) {
        arrive(ctx, unit);
        continue;
      }
      continue;
    }

    // Steer toward the waypoint, bent aside by separation from neighbors.
    //
    // Separation is projected *perpendicular* to the direction of travel: any
    // component pointing back along the path is discarded. That single
    // constraint is what makes this stable. A raw separation force competes
    // with goal-seeking head-on — push away, drift back in, push away again —
    // and with several neighbors summing at once it can outweigh the seek
    // vector entirely, which is a limit cycle, i.e. the oscillation. With the
    // backward component removed and the magnitude capped below the seek
    // vector's, the blended steer always keeps a positive component along the
    // direction to the target (dot(dir + sep, dir) >= 1 > 0), so every single
    // tick still closes distance on the goal. A unit cannot ping-pong when it
    // is provably always moving closer, so no taper or damping is needed and
    // separation can stay live right up to arrival — which is precisely where
    // crowding used to happen once the old taper switched it off.
    const dirX = dx / dist, dirY = dy / dist;
    let steerX = dirX, steerY = dirY;
    const [rawX, rawY] = separation(ctx, unit);
    const rawLen = Math.hypot(rawX, rawY);
    if (rawLen > 1e-6) {
      // Avoidance is applied as a purely *sideways* slide, never as a push back
      // down the path, and that is what makes it stable. The seek vector is a
      // unit vector and the slide is exactly perpendicular to it, so the
      // blended steer always has a forward component of exactly 1: every tick
      // closes distance on the goal no matter how crowded things are. A unit
      // that is provably always getting closer cannot ping-pong, so there is no
      // limit cycle for it to fall into — which is the oscillation.
      const nX = -dirY, nY = dirX; // left-hand normal of the travel direction
      const lateralPref = rawX * nX + rawY * nY;
      // A neighbour dead ahead produces a push that is *entirely* backward, with
      // no sideways preference to read. Merely dropping the opposing component
      // there would leave no avoidance at all, which is exactly how a unit ends
      // up walking straight through a stationary one. So fall back to a fixed
      // side and round the obstacle instead. Two units meeting head-on travel in
      // opposite directions, so each picking its own left sends them past each
      // other on opposite sides — the same convention that makes keep-right
      // traffic work.
      const side = Math.abs(lateralPref) > 1e-3 ? Math.sign(lateralPref) : 1;
      let mag = Math.min(rawLen * SEPARATION_STRENGTH, SEPARATION_MAX);
      if (isFinalWaypoint) mag *= Math.min(1, dist / ARRIVE_COMMIT_RADIUS);
      steerX = dirX + nX * side * mag;
      steerY = dirY + nY * side * mag;
    }
    const steerLen = Math.hypot(steerX, steerY) || 1;

    // Never step further than the remaining distance to the waypoint —
    // without this, a unit within one tick's travel of a waypoint
    // overshoots past it every frame, and combined with separation's
    // restoring push that overshoot becomes a stable back-and-forth
    // oscillation instead of settling.
    const stepX = steerX / steerLen, stepY = steerY / steerLen;
    const step = Math.min(unit.speed * dt * convoyBrake(ctx, unit, stepX, stepY), dist);
    unit.x += stepX * step;
    unit.y += stepY * step;
    unit.facing = Math.atan2(steerY, steerX);
    // Remembered so followers can tell whether this unit is going their way.
    unit.dirX = stepX; unit.dirY = stepY;
  }

  resolveBodyOverlaps(ctx, dt);
}

// Final pass: separate any bodies that are actually touching.
//
// The steering above avoids collisions it can *see coming*, but nothing there
// undoes an overlap that has already happened — a unit turning into the queue
// from the side, say, closes the gap along an axis its follow-brake isn't
// watching, and the brake can then only stop it closing further, not back it
// out. This is the same split physics engines make between avoidance and
// contact resolution, and it is the last thing needed to get overlap to zero.
//
// It is purely repulsive, which is what makes it safe: the push exists only
// while two bodies intersect, always points them apart, and fades to nothing as
// they clear, so separation increases monotonically and the pass settles. There
// is no goal-seeking for it to fight, hence no oscillation.
//
// Only units that are moving or idle get pushed — whichever unit is *going*
// somewhere is the one that yields. A unit with a committed position
// (harvesting, standing in line, unloading) is never shoved off its assigned
// spot, so this cannot fight the gather queue for position.
// Tiles held by units that are standing still, for the crowd-routing cost in
// findPath. Only settled units count: a unit in transit is about to be somewhere
// else, so routing around where it happens to be this instant would be chasing
// noise. A wall of parked workers, on the other hand — a full gather queue, say
// — is exactly what a long trip needs to go around rather than get wedged
// against, which without this is precisely what happens.
function stationaryOccupancy(ctx) {
  const occupied = new Set();
  for (const unit of ctx.store.all) {
    if (unit.kind !== 'unit' || unit.state === 'moving') continue;
    occupied.add(`${Math.floor(unit.x)},${Math.floor(unit.y)}`);
  }
  return occupied;
}

function resolveBodyOverlaps(ctx, dt) {
  for (const unit of ctx.store.all) {
    if (unit.kind !== 'unit') continue;
    if (unit.state !== 'idle' && unit.state !== 'moving') continue;
    let px = 0, py = 0, deepest = 0;
    for (const other of ctx.spatialGrid.queryRadius(unit.x, unit.y, MAX_UNIT_DIAMETER)) {
      if (other === unit || other.kind !== 'unit') continue;
      const contact = contactDistance(unit, other);
      let dx = unit.x - other.x, dy = unit.y - other.y;
      let d = Math.hypot(dx, dy);
      if (d >= contact) continue;
      if (d < 1e-4) {
        // Exactly coincident — there's no direction to push along, so pick one
        // from the unit's id. Deterministic (same every tick and every replay)
        // and spread by the golden angle so a whole stack fans out instead of
        // every unit choosing the same escape direction.
        const a = unit.id * 2.399963229728653;
        dx = Math.cos(a); dy = Math.sin(a); d = 1;
      }
      const push = (contact - d) / contact;
      if (push > deepest) deepest = push;
      px += (dx / d) * push; py += (dy / d) * push;
    }
    const len = Math.hypot(px, py);
    if (len < 1e-6) continue;
    const urgency = Math.min(1, Math.max(0, (deepest - BODY_SEPARATION_DEEP_FRACTION) / (1 - BODY_SEPARATION_DEEP_FRACTION)));
    const speed = BODY_SEPARATION_SPEED + (BODY_SEPARATION_DEEP_SPEED - BODY_SEPARATION_SPEED) * urgency;
    // Damped: the step shrinks with the remaining overlap, so units ease apart
    // and stop rather than overshooting into a new collision.
    const step = Math.min(speed * dt, len * 0.5);
    const nx = unit.x + (px / len) * step;
    const ny = unit.y + (py / len) * step;
    if (ctx.map.grid.isWalkable(Math.floor(nx), Math.floor(ny))) { unit.x = nx; unit.y = ny; }
  }
}

// Raw repulsion from nearby units. Neighbours that have stopped moving are
// weighted harder and seen from further away: avoidance is a shared effort
// between two movers, each solving half the problem, but a unit that has parked
// (harvesting, waiting in line, idle) contributes nothing to getting out of the
// way, so the one still moving has to do all of it — and therefore has to begin
// earlier and swing wider to clear the same gap. Measured against the live
// game, the moving-past-a-parked-worker case was the large majority of all
// remaining sprite overlap before this weighting existed.
const STATIONARY_WEIGHT = 1.9;
const STATIONARY_RADIUS_SCALE = 1.35;

// Each unit's own resting place within a tile, spread by the golden angle so a
// crowd fans out across the tile instead of several units picking the same
// direction. Derived from the id alone: stable across ticks (a wandering offset
// would itself be a moving target to chase) and identical on every replay.
function subCellX(unit) { return Math.cos(unit.id * 2.399963229728653) * SUBCELL_RADIUS; }
function subCellY(unit) { return Math.sin(unit.id * 2.399963229728653) * SUBCELL_RADIUS; }

// Speed multiplier in [0,1]: eases off as the unit closes on whoever is
// directly ahead of it in its own lane and travelling the same way.
function convoyBrake(ctx, unit, dirX, dirY) {
  let scale = 1;
  if (unit.queueAheadId) {
    const lead = ctx.store.get(unit.queueAheadId);
    if (lead) {
      const vx = lead.x - unit.x, vy = lead.y - unit.y;
      const ahead = vx * dirX + vy * dirY;
      const gap = Math.hypot(vx, vy);
      if (ahead > 0 && gap < FOLLOW_DISTANCE) {
        scale = Math.min(scale, Math.max(FOLLOW_MIN_SCALE, (gap - QUEUE_FOLLOW_GAP) / (FOLLOW_DISTANCE - QUEUE_FOLLOW_GAP)));
      }
    }
  }
  for (const other of ctx.spatialGrid.queryRadius(unit.x, unit.y, FOLLOW_DISTANCE)) {
    if (other === unit || other.kind !== 'unit') continue;
    if (other.state !== 'moving' && other.state !== 'movingToDropoff') continue;
    if (other.dirX === undefined) continue;
    if (other.dirX * dirX + other.dirY * dirY < FOLLOW_SAME_DIR_DOT) continue; // not going our way
    const vx = other.x - unit.x, vy = other.y - unit.y;
    const ahead = vx * dirX + vy * dirY;
    if (ahead <= 0) continue; // behind us
    if (Math.abs(-vx * dirY + vy * dirX) > FOLLOW_LANE_HALFWIDTH) continue; // not in our lane
    if (ahead >= FOLLOW_DISTANCE) continue;
    const contact = contactDistance(unit, other);
    const s = Math.max(FOLLOW_MIN_SCALE, (ahead - contact) / Math.max(1e-3, FOLLOW_DISTANCE - contact));
    if (s < scale) scale = s;
  }
  return scale;
}

function separation(ctx, unit) {
  let ox = 0, oy = 0;
  const maxRadius = SEPARATION_RADIUS * STATIONARY_RADIUS_SCALE;
  for (const other of ctx.spatialGrid.queryRadius(unit.x, unit.y, maxRadius)) {
    if (other === unit || other.kind !== 'unit') continue;
    const parked = other.state !== 'moving' && other.state !== 'movingToDropoff';
    const radius = parked ? maxRadius : SEPARATION_RADIUS;
    const weight = parked ? STATIONARY_WEIGHT : 1;
    const dx = unit.x - other.x, dy = unit.y - other.y;
    const d = Math.hypot(dx, dy);
    if (d > 0 && d < radius) {
      const push = ((radius - d) / radius) * weight;
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
