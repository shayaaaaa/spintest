import { moveUnitTo, stopUnit } from '../systems/MovementSystem.js';
import { issueGatherOrder, leaveGatherNode } from '../systems/GatheringSystem.js';
import { Visibility } from '../world/FogOfWar.js';
import { tileVisibility } from '../render/layers/FogLayer.js';

const PICK_RADIUS = 0.65;
const FORMATION_SPACING = 0.9;

// Arranges `count` units in a compact grid centered on the origin, as
// {dx, dy} offsets to add to a group move order's target point.
function formationOffsets(count) {
  if (count <= 1) return [{ dx: 0, dy: 0 }];
  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  const offsets = [];
  for (let i = 0; i < count; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    offsets.push({
      dx: (col - (cols - 1) / 2) * FORMATION_SPACING,
      dy: (row - (rows - 1) / 2) * FORMATION_SPACING,
    });
  }
  return offsets;
}

// Translates TouchInput gestures into game commands / camera moves.
// `view` is the mutable UI/render state object owned by main.js:
// { camera, selection, dragBox, buildGhost, abilityTargeting }
export class InputMapper {
  constructor(ctx, view) {
    this.ctx = ctx;
    this.view = view;
  }

  callbacks() {
    return {
      onTap: (p) => this.handleTap(p),
      onBoxSelectStart: (p) => this.handleBoxSelectStart(p),
      onBoxSelectMove: (p) => this.handleBoxSelectMove(p),
      onBoxSelectEnd: (p) => this.handleBoxSelectEnd(p),
      onPan: (d) => this.handlePan(d),
      onPanEnd: () => {},
      onPinch: (p) => this.handlePinch(p),
      onPinchEnd: () => {},
    };
  }

  isBusy() {
    return !!(this.view.buildGhost || this.view.abilityTargeting);
  }

  handlePan({ dx, dy }) {
    const { camera } = this.view;
    if (this.view.buildGhost) {
      const delta = { x: dx / camera.pixelsPerTile, y: dy / camera.pixelsPerTile };
      this.view.buildGhost.x += delta.x;
      this.view.buildGhost.y += delta.y;
      this.view.onBuildGhostMoved?.();
      return;
    }
    camera.panPixels(dx, dy);
  }

  handlePinch({ scale, centerX, centerY }) {
    this.view.camera.zoomAt(centerX, centerY, scale);
  }

  handleBoxSelectStart(p) {
    if (this.isBusy()) return;
    // A hold that lands on an entity shows its info card instead of
    // starting a rubber-band box (an empty-ground hold still box-selects).
    const world = this.view.camera.screenToWorld(p.x, p.y);
    const hit = this.pickEntityAt(world.x, world.y);
    if (hit) {
      this._suppressBoxSelect = true;
      this.view.onLongPressEntity?.(hit, p);
      return;
    }
    this._suppressBoxSelect = false;
    this.view.dragBox = { startX: p.x, startY: p.y, curX: p.x, curY: p.y };
  }

  handleBoxSelectMove(p) {
    if (!this.view.dragBox) return;
    this.view.dragBox.curX = p.x;
    this.view.dragBox.curY = p.y;
  }

  handleBoxSelectEnd(p) {
    const box = this.view.dragBox;
    this.view.dragBox = null;
    if (this._suppressBoxSelect) { this._suppressBoxSelect = false; this.view.onLongPressEnd?.(); return; }
    if (!box || this.isBusy()) return;
    const end = p || { x: box.curX, y: box.curY };
    const a = this.view.camera.screenToWorld(box.startX, box.startY);
    const b = this.view.camera.screenToWorld(end.x, end.y);
    const minX = Math.min(a.x, b.x), maxX = Math.max(a.x, b.x);
    const minY = Math.min(a.y, b.y), maxY = Math.max(a.y, b.y);

    const picked = [];
    for (const u of this.ctx.store.unitsOf(this.ctx.localPlayerId)) {
      if (u.x >= minX && u.x <= maxX && u.y >= minY && u.y <= maxY) picked.push(u.id);
    }
    if (picked.length > 0) this.view.selection.set(picked);
  }

  handleTap(p) {
    const world = this.view.camera.screenToWorld(p.x, p.y);

    if (this.view.abilityTargeting) return this.resolveAbilityTarget(world);
    if (this.view.buildGhost) return this.resolvePlacementTap(world);

    const hit = this.pickEntityAt(world.x, world.y);
    if (hit && hit.ownerId === this.ctx.localPlayerId) {
      this.view.selection.set([hit.id]);
      return;
    }

    const selected = this.view.selection.entities(this.ctx.store).filter((e) => e.kind === 'unit');
    if (selected.length === 0) {
      if (!hit) this.view.selection.clear();
      return;
    }

    // Any new order supersedes a unit's previous one — including a resource
    // node reservation, active or queued. Drop it here so a unit pulled off
    // gather duty never leaves a phantom slot/queue spot that nothing will
    // ever come back to claim.
    for (const u of selected) leaveGatherNode(this.ctx, u);

    if (hit && hit.kind === 'resourceNode') {
      for (const u of selected) {
        if (u.canGather) issueGatherOrder(this.ctx, u, hit);
        else moveUnitTo(this.ctx, u, hit.x, hit.y);
      }
    } else if (hit && hit.hp !== undefined && hit.ownerId !== this.ctx.localPlayerId) {
      for (const u of selected) {
        if (u.dmgMax > 0) {
          stopUnit(u);
          u.targetId = hit.id;
          u.state = 'attacking';
        } else {
          moveUnitTo(this.ctx, u, hit.x, hit.y);
        }
      }
    } else {
      // Spread a group move across a small formation instead of sending
      // every unit to the identical tile — avoids units permanently
      // contending for one spot, and reads better than a stack.
      const offsets = formationOffsets(selected.length);
      selected.forEach((u, i) => moveUnitTo(this.ctx, u, world.x + offsets[i].dx, world.y + offsets[i].dy));
    }
  }

  resolvePlacementTap(world) {
    const ghost = this.view.buildGhost;
    const w = ghost.footprint.w / 2, h = ghost.footprint.h / 2;
    if (world.x >= ghost.x - w && world.x <= ghost.x + w && world.y >= ghost.y - h && world.y <= ghost.y + h) {
      this.view.onConfirmPlacement?.();
    }
  }

  resolveAbilityTarget(world) {
    const targeting = this.view.abilityTargeting;
    if (targeting.targeting === 'unit') {
      const hit = this.pickEntityAt(world.x, world.y);
      if (hit) this.view.onAbilityTarget?.({ id: hit.id, x: hit.x, y: hit.y });
    } else {
      this.view.onAbilityTarget?.({ x: world.x, y: world.y });
    }
  }

  pickEntityAt(x, y) {
    let best = null, bestDist = Infinity;
    const fog = this.ctx.fogByOwner[this.ctx.localPlayerId];
    for (const e of this.ctx.store.all) {
      if (e.hp === undefined && e.kind !== 'resourceNode') continue;
      // A worked-out node is on its way out (a stripped tree is mid-fall) —
      // don't let it swallow taps meant for whatever is still standing there.
      if (e.kind === 'resourceNode' && e.amount <= 0) continue;
      const isOwn = e.ownerId === this.ctx.localPlayerId;
      if (!isOwn) {
        const vis = tileVisibility(fog, e.x, e.y);
        const requireCurrentlyVisible = e.kind === 'unit';
        if (requireCurrentlyVisible ? vis !== Visibility.VISIBLE : vis === Visibility.HIDDEN) continue;
      }
      // Resource nodes are tappable across the whole circle they're drawn as,
      // never smaller than the baseline touch target — a bigger gold mine
      // should be tappable where it actually looks, not just near its middle.
      const radius = e.kind === 'building' ? Math.max(e.footprint.w, e.footprint.h) / 2
        : e.kind === 'resourceNode' ? Math.max(PICK_RADIUS, e.radius ?? PICK_RADIUS)
        : PICK_RADIUS;
      const d = Math.hypot(e.x - x, e.y - y);
      if (d <= radius && d < bestDist) { bestDist = d; best = e; }
    }
    return best;
  }
}
