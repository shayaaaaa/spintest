// Horde mode: the player commands the infected against an outpost held by AI defenders.
// Brains (earned over time) pay for zombies during a siege; DNA (earned per siege) pays for the Lab.
import * as THREE from './three.module.min.js';
import { BASE_FOV, WALL_Z, WALL_HALF, ZOMBIES, HORDE_UNITS, HORDE_ABILITIES, HORDE_LEVELS, HORDE_UNLOCK_MISSION,
  HIVE, MUTATION, DEFENDER_SLOTS, hordeRound, weaponStats } from './data.js';
import { save, persist } from './save.js';
import { buildHumanoid, buildWeapon, lam, BOX } from './models.js';

const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const UP = new THREE.Vector3(0, 1, 0);
const V = new THREE.Vector3(), V2 = new THREE.Vector3();
export const DEPLOY = { zMin: -78, zMax: -32, xMax: 44 };
const MAX_UNITS = 28;
const CONE = new THREE.ConeGeometry(1, 1, 4);
const RING = (() => { const g = new THREE.RingGeometry(0.82, 1, 28); g.rotateX(-Math.PI / 2); return g; })();
// bright ring under each of the player's zombies so the horde is easy to follow from above
const UNIT_RING_MAT = new THREE.MeshBasicMaterial({ color: 0x8cff6a, transparent: true, opacity: 0.85, depthWrite: false, fog: false, side: THREE.DoubleSide });

export const hordeOpen = () => save.unlocked >= HORDE_UNLOCK_MISSION;
export const unitDef = key => HORDE_UNITS.find(u => u.key === key);
export function unitMult(key) {
  const L = save.horde.mut[key] || 0;
  return { level: L, hp: 1 + MUTATION.hp * L, speed: 1 + MUTATION.speed * L, wall: 1 + MUTATION.wall * L };
}
// Ability level 0 = locked, 1 = unlocked, each further level is one upgrade.
export function abilityStats(key) {
  const A = HORDE_ABILITIES.find(a => a.key === key), lvl = save.horde.abil[key] || 0;
  if (!A || !lvl) return null;
  const up = lvl - 1;
  return { ...A, up, cd: A.cd + A.cdPer * up, dur: (A.dur || 0) + (A.durPer || 0) * up, n: (A.n || 0) + (A.nPer || 0) * up };
}
export const brainIncome = () => HIVE.base * (1 + HIVE.per * (save.horde.income || 0));
export const fmtTime = s => `${Math.floor(s / 60)}:${String(Math.max(0, Math.floor(s % 60))).padStart(2, '0')}`;

function damageFalloff(w, dist) {
  if (!w.falloff) return w.dmg;
  const [a, b, m] = w.falloff;
  return w.dmg * (1 - clamp((dist - a) / (b - a), 0, 1) * (1 - m));
}

const DEF_NAME = { sniper: 'Sniper', gunner: 'Gunner', rocket: 'Rockets' };

class Defender {
  constructor(g, spec, root) {
    this.g = g; this.spec = spec; this.kind = spec.kind;
    this.name = DEF_NAME[spec.kind];
    this.w = weaponStats(spec.w);
    this.acc = spec.acc;
    const S = DEFENDER_SLOTS[spec.slot];
    this.m = buildHumanoid({ human: true, skin: [0xf1c27d, 0xc68642, 0xe0ac69, 0x8d5524][Math.floor(Math.random() * 4)],
      shirt: 0x4e5a39, pants: 0x3b4229, vest: 0x2f3524, helmet: true, hair: null, shoe: 0x22201c, scale: 1.05 });
    this.root = this.m.root;
    this.root.position.set(S.x, S.y, S.z);
    this.root.rotation.y = Math.PI;
    const { group, muzzle } = buildWeapon(this.w);
    if (group.userData.hands) group.userData.hands.visible = false;
    group.rotation.y = Math.PI;
    if (this.kind === 'rocket') { group.scale.setScalar(1.15); group.position.set(0.2, 1.42, 0.05); }
    else { group.scale.setScalar(this.kind === 'gunner' ? 1.05 : 0.95); group.position.set(0.13, 1.08, 0.3); }
    this.m.body.add(group);
    this.muzzle = muzzle;
    this.m.shR.rotation.x = -1.3; this.m.shL.rotation.x = -1.45; this.m.shL.rotation.z = -0.35;
    // red marker so defenders are easy to spot from the far end of the field
    const mk = new THREE.Mesh(CONE, new THREE.MeshBasicMaterial({ color: 0xff3a2a, fog: false }));
    mk.material.userData.dispose = true;
    mk.scale.set(0.32, -0.5, 0.32); mk.position.y = 2.6;
    this.root.add(mk); this.marker = mk;
    root.add(this.root);
    if (this.kind === 'sniper') {
      this.laser = new THREE.Mesh(BOX, new THREE.MeshBasicMaterial({ color: 0xff2a1a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
      this.laser.material.userData.dispose = true;
      this.laser.visible = false;
      root.add(this.laser);
    }
    if (this.kind === 'rocket') {
      this.ring = new THREE.Mesh(RING, new THREE.MeshBasicMaterial({ color: 0xff3a2a, transparent: true, opacity: 0, depthWrite: false, fog: false, side: THREE.DoubleSide }));
      this.ring.material.userData.dispose = true;
      this.ring.visible = false;
      this.ring.renderOrder = 4;
      root.add(this.ring);
    }
    this.ammo = this.w.mag;
    this.reloadT = 0; this.coolT = rand(0.8, 1.8); this.aimT = 0; this.retarget = 0; this.burst = 0;
    this.target = null; this.aimPoint = null; this.state = 'idle'; this.t = Math.random() * 6; this.gone = false;
    this.range = this.kind === 'gunner' ? 28 : this.kind === 'rocket' ? 115 : 170;
  }

  eye(out = new THREE.Vector3()) { return out.set(this.root.position.x, this.root.position.y + 1.6, this.root.position.z); }
  inRange(z) { return Math.hypot(z.pos.x - this.root.position.x, z.pos.z - this.root.position.z) <= this.range; }
  valid(z) { return z.alive && z.horde && z.state !== 'rise' && this.inRange(z) && this.g.canSee(this.eye(V2), z); }
  face(p) { this.root.rotation.y = Math.atan2(p.x - this.root.position.x, p.z - this.root.position.z); }

  pick() {
    const g = this.g, zs = g.zombies.filter(z => this.valid(z));
    if (!zs.length) return null;
    if (this.kind === 'gunner') {
      let best = null, bd = 1e9;
      for (const z of zs) { const d = z.pos.distanceToSquared(this.root.position); if (d < bd) { bd = d; best = z; } }
      return best;
    }
    if (this.kind === 'rocket') {
      let best = null, bs = 2.4;
      for (const z of zs) {
        if (z.pos.z > WALL_Z - 3.5) continue;   // too close to their own wall
        let n = 0;
        for (const o of g.zombies) if (o.alive && o.horde && o.pos.distanceToSquared(z.pos) < 25) n++;
        const s = n + (z.def.boss || z.def.wide ? 2 : 0);
        if (s > bs) { bs = s; best = z; }
      }
      return best;
    }
    // sniper: biggest threat first, weighted by how close it is to the wall
    let best = null, bs = -1;
    for (const z of zs) {
      let w = z.def.boss ? 2.2 : z.def.lean ? 1.3 : z.def.wide ? 1.2 : 1;
      if (z.def.explode) {
        let n = 0;
        for (const o of g.zombies) if (o !== z && o.alive && o.horde && o.pos.distanceToSquared(z.pos) < 36) n++;
        w = n >= 2 ? 2 : 1.3;
      }
      const s = (140 - Math.abs(z.pos.z - WALL_Z)) * w * rand(0.85, 1.15);
      if (s > bs) { bs = s; best = z; }
    }
    return best;
  }

  update(dt) {
    if (this.gone) return;
    const g = this.g;
    this.t += dt;
    this.marker.position.y = 2.6 + Math.sin(this.t * 3) * 0.12;
    if (this.reloadT > 0) {
      this.reloadT -= dt;
      this.state = 'reloading';
      this.hideAim();
      if (this.reloadT <= 0) { this.reloadT = 0; this.ammo = this.w.mag; this.state = 'idle'; }
      return;
    }
    if (this.coolT > 0) this.coolT -= dt;
    // rockets commit to a spot on the ground, so a quick horde can get out of the way
    if (this.kind !== 'rocket' && this.target && !this.valid(this.target)) { this.target = null; this.aimT = 0; }
    if (this.kind === 'rocket' && this.target && !this.target.alive && this.aimT < 0.2) { this.target = null; this.aimT = 0; }
    if (!this.target) {
      this.retarget -= dt;
      if (this.retarget <= 0) {
        this.retarget = 0.25;
        this.target = this.pick();
        this.aimT = 0;
        if (this.target && this.kind === 'rocket') this.aimPoint = new THREE.Vector3(this.target.pos.x, 0.3, this.target.pos.z);
      }
    }
    if (!this.target) { this.state = 'idle'; this.hideAim(); return; }
    this.face(this.kind === 'rocket' ? this.aimPoint : this.target.pos);
    this.state = 'aiming';
    const need = this.kind === 'sniper' ? 1.5 - this.acc * 0.6 : this.kind === 'gunner' ? 0.35 : 1.5;
    this.aimT += dt * (g.fogT > 0 ? 0.45 : 1);
    this.showAim(Math.min(1, this.aimT / need));
    if (this.aimT >= need && this.coolT <= 0) this.fire();
  }

  showAim(k) {
    if (this.laser) {
      const from = this.eye(V);
      const to = this.target.headWorld(V2);
      const len = from.distanceTo(to);
      this.laser.position.copy(from).add(to).multiplyScalar(0.5);
      this.laser.lookAt(to);
      this.laser.scale.set(0.09, 0.09, len);
      const flick = k > 0.8 ? 0.25 * Math.sin(this.t * 40) : 0;
      this.laser.material.opacity = (0.2 + 0.55 * k + flick) * (this.g.fogT > 0 ? 0.4 : 1);
      this.laser.visible = true;
    }
    if (this.ring && this.aimPoint) {
      this.ring.position.set(this.aimPoint.x, 0.08, this.aimPoint.z);
      this.ring.scale.setScalar(this.w.blast * (1.35 - 0.35 * k));
      this.ring.material.opacity = 0.35 + 0.45 * k * (0.6 + 0.4 * Math.sin(this.t * 18));
      this.ring.visible = true;
    }
  }
  hideAim() { if (this.laser) this.laser.visible = false; if (this.ring) this.ring.visible = false; }

  fire() {
    const g = this.g, w = this.w, z = this.target;
    this.ammo--;
    this.root.updateMatrixWorld(true);
    const from = this.muzzle.getWorldPosition(new THREE.Vector3());
    if (this.kind === 'rocket') {
      g.spawnRocket(from, this.aimPoint.clone(), w, true);
      g.audio.rocket();
      this.coolT = w.bolt + 0.8;
      this.target = null; this.aimT = 0; this.hideAim();
    } else {
      const eye = this.eye(new THREE.Vector3());
      const dist = eye.distanceTo(z.pos);
      const fog = g.fogT > 0;
      const p = this.kind === 'sniper'
        ? this.acc - (z.def.lean ? 0.12 : 0) - (fog ? 0.4 : 0)
        : this.acc * 0.85 * (1 - dist / this.range * 0.4) * (fog ? 0.4 : 1);
      let part = Math.random() < (this.kind === 'sniper' ? this.acc * 0.6 : 0.12) ? 'head' : 'body';
      if (part === 'head' && z.helmet) part = 'helmet';
      const at = part === 'body' ? z.m.torso.getWorldPosition(new THREE.Vector3()) : z.headWorld();
      if (Math.random() < p) {
        const dir = at.clone().sub(eye).normalize();
        const base = this.kind === 'gunner' ? damageFalloff(w, dist) : w.dmg;
        const out = z.hit(part, base, at, dir, z.computeDamage(part, base, w.hs));
        if (out.killed) g.onUnitLost(z, out.headshot);
        g.fx.shootTracer(from, at, this.kind === 'sniper' ? 0.85 : 0.5, this.kind === 'sniper' ? 0.07 : 0.045);
      } else {
        const miss = at.clone().add(new THREE.Vector3(rand(-1.6, 1.6), 0, rand(-1.6, 1.6)));
        miss.y = 0.05;
        g.fx.impact(miss, UP, 'dirt');
        g.fx.shootTracer(from, miss, 0.5, 0.045);
        if (this.kind === 'sniper') g.hstats.dodged++;
      }
      if (this.kind === 'sniper') { g.audio.shot(0.8); this.coolT = w.bolt + 0.35; this.target = null; this.aimT = 0; this.hideAim(); }
      else {
        g.audio.auto(w.dmg >= 45);
        this.coolT = w.bolt;
        if (++this.burst >= 6) { this.burst = 0; this.coolT += 0.8; }
      }
    }
    g.fx.puff(from, 0xffe0a0, 0.18, 0.12, 1, 0);
    if (this.ammo <= 0) { this.reloadT = w.reload * (this.kind === 'rocket' ? 1.3 : 1.1); this.target = null; this.hideAim(); }
  }

  flee() {
    this.gone = true;
    this.hideAim();
    this.g.fx.puff(this.root.position.clone().add(UP), 0xb8b0a0, 1, 0.8, 4, 0.6);
    this.root.visible = false;
  }
}

function nest(group, x, z) {
  const wood = lam(0x7a5a3a), bag = lam(0xa8996e);
  const b = (sx, sy, sz, px, py, pz, m) => { const o = new THREE.Mesh(BOX, m); o.scale.set(sx, sy, sz); o.position.set(px, py, pz); group.add(o); };
  b(2.8, 1.2, 2.4, x, 0.6, z + 0.3, wood);
  for (let i = -1; i <= 1; i++) b(0.9, 0.36, 0.5, x + i * 0.92, 1.38, z - 0.75, bag);
  b(0.5, 0.36, 0.9, x - 1.25, 1.38, z, bag); b(0.5, 0.36, 0.9, x + 1.25, 1.38, z, bag);
}
function scaffold(group, x, z) {
  const wood = lam(0x6a4e34), floor = lam(0x8a6a46);
  const b = (sx, sy, sz, px, py, pz, m) => { const o = new THREE.Mesh(BOX, m); o.scale.set(sx, sy, sz); o.position.set(px, py, pz); group.add(o); };
  for (const [dx, dz] of [[-1.2, -1.2], [1.2, -1.2], [-1.2, 1.2], [1.2, 1.2]]) b(0.22, 5, 0.22, x + dx, 2.5, z + dz, wood);
  b(3, 0.2, 3, x, 4.9, z, floor);
  b(3, 0.08, 0.08, x, 5.6, z - 1.45, wood);
  b(0.1, 5, 0.08, x - 0.4, 2.5, z + 1.5, wood); b(0.1, 5, 0.08, x + 0.4, 2.5, z + 1.5, wood);
  for (let y = 0.6; y < 5; y += 0.6) b(0.9, 0.06, 0.06, x, y, z + 1.5, wood);
}

// Methods mixed into Game.
export const HordeMixin = {
  startHorde(index, map = 0) {
    const endless = index === 'endless';
    const L = endless ? hordeRound(1, map) : HORDE_LEVELS[index];
    this.mode = 'horde';
    this.hordeIndex = index;
    this.hordeMap = L.map;
    this.round = 1;
    this.level = L;
    this.loadMap(L.map);
    this.clearActors();
    this.clearHorde();
    this.hordeRoot = new THREE.Group();
    this.scene.add(this.hordeRoot);
    this.makeDeployZone();
    this.scoped = false; this.scopeShown = false; this.ui.setScoped(false);
    this.focusT = 0; this.audio.setFocus(false); this.ui.focus(false);
    this.gun.showcase = false;
    this.brains = HIVE.start;
    this.income = brainIncome();
    this.cardCD = {}; this.abilCD = {};
    this.fogT = 0; this.roarT = 0; this.burrowN = 0; this.bossUsed = false;
    this.selCard = 'walker';
    this.hstats = { sent: 0, lost: 0, dmg: 0, dodged: 0 };
    this.stats = { kills: 0, heads: 0, shots: 0, hits: 0, earned: 0, saved: 0, lost: 0, friendly: 0 };
    this.ending = null;
    this.boss = null; this.bossDead = false;
    this.setupRound(L);
    this.rig = { x: 0, z: -40, d: 95 };
    this.camLook = null;
    this.camera.fov = BASE_FOV; this.camera.updateProjectionMatrix();
    this.state = 'playing';
    this.ui.banner(L.name.toUpperCase(), endless ? 'Break as many outposts as you can' : `Break the wall in ${fmtTime(L.time)}`);
    this.audio.horn();
  },

  setupRound(L) {
    this.wallMax = L.wall; this.wallHp = L.wall;
    this.world.barricade.setHealth(1);
    this.hTime = L.time; this.hTimeMax = L.time;
    if (this.roundRoot) {
      this.hordeRoot.remove(this.roundRoot);
      this.roundRoot.traverse(o => { if (o.geometry && o.geometry.userData.own) o.geometry.dispose(); if (o.material && o.material.userData && o.material.userData.dispose) o.material.dispose(); });
    }
    this.roundRoot = new THREE.Group();
    this.hordeRoot.add(this.roundRoot);
    const slots = new Set(L.defenders.map(d => d.slot));
    if (slots.has('nestL')) nest(this.roundRoot, DEFENDER_SLOTS.nestL.x, DEFENDER_SLOTS.nestL.z);
    if (slots.has('nestR')) nest(this.roundRoot, DEFENDER_SLOTS.nestR.x, DEFENDER_SLOTS.nestR.z);
    if (slots.has('scaffold')) scaffold(this.roundRoot, DEFENDER_SLOTS.scaffold.x, DEFENDER_SLOTS.scaffold.z);
    this.defenders = L.defenders.map(spec => new Defender(this, spec, this.roundRoot));
  },

  makeDeployZone() {
    const w = DEPLOY.xMax * 2, d = DEPLOY.zMax - DEPLOY.zMin;
    const g = new THREE.PlaneGeometry(w, d); g.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0x7bd66a, transparent: true, opacity: 0.08, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }));
    m.material.userData.dispose = true;
    m.position.set(0, 0.06, (DEPLOY.zMin + DEPLOY.zMax) / 2);
    m.renderOrder = 2;
    this.hordeRoot.add(m);
    const edge = new THREE.LineSegments(new THREE.EdgesGeometry(g), new THREE.LineBasicMaterial({ color: 0x9cf08a, transparent: true, opacity: 0.6 }));
    edge.material.userData.dispose = true;
    edge.position.copy(m.position); edge.position.y = 0.1;
    this.hordeRoot.add(edge);
    this.zone = { m, edge, flash: 0 };
    this.marks = [];
    for (let i = 0; i < 6; i++) {
      const r = new THREE.Mesh(RING, new THREE.MeshBasicMaterial({ color: 0x9cf08a, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }));
      r.material.userData.dispose = true;
      r.visible = false; r.renderOrder = 4;
      this.hordeRoot.add(r);
      this.marks.push({ mesh: r, t: 0 });
    }
    this.markIdx = 0;
  },

  clearHorde() {
    if (this.hordeRoot) {
      this.scene.remove(this.hordeRoot);
      this.hordeRoot.traverse(o => {
        if (o.geometry && (o.geometry.userData.own || o.geometry.type === 'PlaneGeometry' || o.geometry.type === 'EdgesGeometry')) o.geometry.dispose();
        if (o.material && o.material.userData && o.material.userData.dispose) o.material.dispose();
      });
    }
    this.hordeRoot = null; this.roundRoot = null;
    this.defenders = []; this.marks = [];
  },

  updateHorde(dt) {
    if (this.state === 'playing') {
      if (!this.ending) {
        this.brains += this.income * dt;
        this.hTime -= dt;
        for (const k in this.cardCD) this.cardCD[k] = Math.max(0, this.cardCD[k] - dt);
        for (const k in this.abilCD) this.abilCD[k] = Math.max(0, this.abilCD[k] - dt);
        for (const d of this.defenders) d.update(dt);
        if (this.wallHp <= 0) this.breach();
        else if (this.hTime <= 0) {
          this.hTime = 0;
          this.ending = { win: false, t: 2.4 };
          for (const d of this.defenders) d.hideAim();
          this.ui.banner(this.level.endless ? 'THE OUTPOST HELD' : "TIME'S UP", this.level.endless ? `You broke ${this.round - 1} outpost${this.round === 2 ? '' : 's'}` : 'The outpost held');
          this.audio.lose();
        }
      } else {
        this.ending.t -= dt;
        if (this.ending.t <= 0) {
          const e = this.ending;
          this.ending = null;
          if (e.next) this.nextHordeRound(); else this.finishHorde(e.win);
        }
      }
      if (this.fogT > 0) {
        this.fogT -= dt;
        this.fogPuffT -= dt;
        if (this.fogPuffT <= 0) { this.fogPuffT = 0.5; this.fogPuff(2); }
      }
      if (this.roarT > 0) this.roarT -= dt;
    }
    for (const z of this.zombies) if (z.hordeRing && z.hordeRing.visible && !z.alive) z.hordeRing.visible = false;
    for (const mk of this.marks) {
      if (!mk.mesh.visible) continue;
      mk.t -= dt;
      mk.mesh.scale.setScalar(1.2 + (0.7 - mk.t) * 2);
      mk.mesh.material.opacity = Math.max(0, mk.t / 0.7) * 0.8;
      if (mk.t <= 0) mk.mesh.visible = false;
    }
    if (this.zone) {
      this.zone.flash = Math.max(0, this.zone.flash - dt);
      const bad = this.zone.flash > 0;
      this.zone.m.material.color.setHex(bad ? 0xff5a44 : 0x7bd66a);
      this.zone.m.material.opacity = bad ? 0.22 : this.burrowN > 0 ? 0.03 : 0.08;
    }
    this.hordeCamera(dt);
  },

  hordeCamera(dt) {
    const r = this.rig, pitch = 0.88;
    const want = V.set(r.x, Math.sin(pitch) * r.d, r.z - Math.cos(pitch) * r.d);
    if (!this.camLook) { this.camLook = new THREE.Vector3(r.x, 0, r.z); this.camera.position.copy(want); }
    const k = 1 - Math.exp(-dt * 6);
    this.camera.position.lerp(want, k);
    this.camLook.lerp(V2.set(r.x, 0, r.z), k);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.camLook);
    if (this.camera.fov !== BASE_FOV) { this.camera.fov = BASE_FOV; this.camera.updateProjectionMatrix(); }
  },

  hordePan(dx, dy) {
    if (this.mode !== 'horde' || this.state !== 'playing' || this.ending) return;
    const k = 0.93 * this.rig.d / Math.max(320, window.innerHeight);
    this.rig.x = clamp(this.rig.x + dx * k, -45, 45);
    this.rig.z = clamp(this.rig.z + dy * k * 1.4, -92, -8);
  },

  hordeZoom(f) {
    if (this.mode !== 'horde' || this.ending) return;
    this.rig.d = clamp(this.rig.d * f, 30, 125);
  },

  // Screen point -> ground point -> send a zombie there.
  hordeTap(cx, cy, key = this.selCard) {
    if (this.mode !== 'horde' || this.state !== 'playing' || this.ending) return false;
    this.camera.updateMatrixWorld();
    this.ray.setFromCamera({ x: cx / window.innerWidth * 2 - 1, y: -(cy / window.innerHeight) * 2 + 1 }, this.camera);
    const o = this.ray.ray.origin, d = this.ray.ray.direction;
    if (d.y >= -0.01) return false;
    const t = -o.y / d.y;
    return this.deployUnit(key, o.x + d.x * t, o.z + d.z * t);
  },

  selectCard(key) {
    if (!save.horde.units[key]) return;
    this.selCard = key;
  },

  deployUnit(key, x, z) {
    if (this.mode !== 'horde' || this.state !== 'playing' || this.ending) return false;
    const U = unitDef(key);
    if (!U || !save.horde.units[key]) return false;
    if (U.once && this.bossUsed) { this.ui.feed('ONE BUTCHER PER SIEGE', 'dim'); return false; }
    if ((this.cardCD[key] || 0) > 0) return false;
    if (this.brains < U.cost) { this.hint('NOT ENOUGH BRAINS'); return false; }
    if (this.aliveCount() >= MAX_UNITS) { this.hint('TOO MANY OF YOURS ON THE FIELD'); return false; }
    let burrow = false;
    if (this.burrowN > 0 && !U.once) {
      burrow = true;
      x = clamp(x, -WALL_HALF + 2, WALL_HALF - 2);
      z = WALL_Z - rand(4, 7);
      this.burrowN--;
    } else if (z < DEPLOY.zMin || z > DEPLOY.zMax || Math.abs(x) > DEPLOY.xMax) {
      this.hint('SEND ZOMBIES FROM THE GREEN ZONE');
      this.zone.flash = 0.6;
      return false;
    }
    for (const o of this.world.obstacles) {
      const d = Math.hypot(x - o.x, z - o.z);
      if (d < o.r + 0.8) { const k = (o.r + 0.9) / (d || 1); x = o.x + (x - o.x) * k; z = o.z + (z - o.z) * k; }
    }
    this.brains -= U.cost;
    this.cardCD[key] = U.cd;
    if (U.once) this.bossUsed = true;
    const M = unitMult(key);
    const zb = this.createZombie(key, x, z, { hpMult: M.hp, speedMult: M.speed, rise: true, name: key === 'boss' ? 'Butcher' : undefined });
    zb.horde = true;
    zb.dpsMult = M.wall;
    zb.riseRate = burrow ? 2.2 : 3;
    zb.target.x = clamp(x + rand(-1.5, 1.5), -WALL_HALF + 1.5, WALL_HALF - 1.5);
    zb.heading = Math.atan2(zb.target.x - x, zb.target.z - z);
    zb.root.rotation.y = zb.heading;
    const ring = new THREE.Mesh(RING, UNIT_RING_MAT);
    ring.position.y = 0.06; ring.scale.setScalar(0.62 * (zb.m.W || 1)); ring.renderOrder = 3;
    zb.root.add(ring);
    zb.hordeRing = ring;
    if (key === 'boss') { this.boss = zb; this.ui.banner('THE BUTCHER RISES', ''); }
    this.hstats.sent++;
    this.audio.deploy();
    this.fx.puff(new THREE.Vector3(x, 0.2, z), 0x6a5a40, 0.6, 0.8, 4, 0.4);
    const mk = this.marks[this.markIdx++ % this.marks.length];
    mk.mesh.position.set(x, 0.12, z); mk.t = 0.7; mk.mesh.visible = true;
    mk.mesh.material.color.setHex(burrow ? 0xd8a640 : 0x9cf08a);
    return true;
  },

  // the same warning at most every 1.5 s, so rapid taps don't flood the feed
  hint(text) {
    if (this.lastHint === text && this.time - this.lastHintT < 1.5) return;
    this.lastHint = text; this.lastHintT = this.time;
    this.ui.feed(text, 'bad');
  },

  useAbility(key) {
    if (this.mode !== 'horde' || this.state !== 'playing' || this.ending) return;
    const A = abilityStats(key);
    if (!A || (this.abilCD[key] || 0) > 0) return;
    this.abilCD[key] = A.cd;
    if (key === 'fog') {
      this.fogT = A.dur; this.fogPuffT = 0;
      this.fogPuff(14);
      this.audio.fog();
      this.ui.feed('FOG ROLLS IN: THE DEFENDERS ARE HALF BLIND', 'good');
    } else if (key === 'roar') {
      this.roarT = A.dur;
      this.audio.roar();
      for (const z of this.zombies) if (z.alive && z.horde) this.fx.puff(z.pos.clone().add(UP), 0xb04030, 0.4, 0.5, 1, 0.8);
      this.ui.feed('ROAR: THE HORDE CHARGES', 'good');
    } else if (key === 'burrow') {
      this.burrowN = A.n;
      this.audio.dirt(0);
      this.ui.feed(`BURROW: YOUR NEXT ${A.n} ZOMBIES DIG UP AT THE WALL`, 'good');
    }
  },

  fogPuff(n) {
    // smoke banks in front of the defenders' line, low enough to see your horde over them
    const col = [0xd8dadc, 0xb8aca4, 0x5a6478][this.level ? this.level.map : 0];
    for (let i = 0; i < n; i++) {
      const p = new THREE.Vector3(rand(-34, 34), rand(1.5, 3.2), rand(WALL_Z - 30, WALL_Z - 3));
      this.fx.puff(p, col, rand(2.6, 3.8), rand(3, 4.5), 1, 0.05);
    }
  },

  // Line of sight from a defender to a zombie's chest, blocked by tall cover between them.
  canSee(eye, z) {
    const ty = 1.1 * z.scale, dx = z.pos.x - eye.x, dz = z.pos.z - eye.z, L2 = dx * dx + dz * dz;
    if (L2 < 1) return true;
    for (const o of this.world.obstacles) {
      const t = ((o.x - eye.x) * dx + (o.z - eye.z) * dz) / L2;
      if (t <= 0 || t >= 1) continue;
      const px = eye.x + dx * t - o.x, pz = eye.z + dz * t - o.z;
      if (px * px + pz * pz > o.r * o.r) continue;
      if (eye.y + (ty - eye.y) * t < (o.h || 2)) return false;
    }
    return true;
  },

  onUnitLost(z) {
    this.hstats.lost++;
    if (z.def.boss) this.ui.feed('THE BUTCHER HAS FALLEN', 'bad');
    else if (z.def.wide && this.time - (this.lastLossMsg || 0) > 3) { this.lastLossMsg = this.time; this.ui.feed('A BRUTE WENT DOWN', 'bad'); }
  },

  breach() {
    this.wallHp = 0;
    this.world.barricade.setHealth(0);
    const endless = !!this.level.endless;
    this.ending = { win: true, t: 3.6, next: endless };
    this.ui.banner(endless ? `OUTPOST ${this.round} DOWN` : 'WALL DOWN!', endless ? 'Another one is waiting' : 'The outpost is overrun');
    this.audio.horn(); this.audio.win();
    let sx = 0, n = 0;
    for (const z of this.zombies) {
      if (!z.alive || z.state === 'rise') continue;
      if (z.pos.z > WALL_Z - 12) { sx += z.pos.x; n++; }
      z.ambient = true; z.breach = true; z.state = 'walk';
      z.target.set(rand(-5, 5), 0, rand(-4, -1.5));
    }
    for (const d of this.defenders) d.flee();
    for (let i = 0; i < 8; i++) this.fx.puff(new THREE.Vector3(rand(-WALL_HALF, WALL_HALF), 0.6, WALL_Z), 0x9a8a6a, 1.4, 1.4, 2, 0.5);
    this.rig = { x: n ? clamp(sx / n * 0.6, -20, 20) : 0, z: -20, d: 40 };
  },

  nextHordeRound() {
    this.round++;
    for (const z of this.zombies) { z.alive = false; z.removeMe = true; }
    for (const k of this.rockets) this.scene.remove(k.mesh);
    this.rockets = [];
    const L = hordeRound(this.round, this.hordeMap);
    this.level = L;
    this.setupRound(L);
    this.brains += 40 + this.round * 10;
    this.burrowN = 0; this.boss = null;
    this.rig = { x: 0, z: -40, d: 95 };
    this.ui.banner(`ROUND ${this.round}`, `${L.defenders.length} defenders · wall ${L.wall.toLocaleString('en-US')}`);
    this.audio.horn();
  },

  finishHorde(win) {
    this.state = 'over';
    const H = save.horde, L = this.level, st = this.hstats;
    const dna = Math.floor(st.dmg / 15);
    let bonus = 0, stars = 0, first = false, best = false;
    const rounds = this.round - 1;
    if (L.endless) {
      bonus = rounds * 80;
      if (rounds > (H.best || 0)) { H.best = rounds; best = true; }
    } else if (win) {
      const f = this.hTime / this.hTimeMax;
      stars = f >= 0.4 ? 3 : f >= 0.2 ? 2 : 1;
      first = !(H.stars[L.i] > 0);
      bonus = Math.round(L.reward * (0.6 + 0.2 * (stars - 1)) * (first ? 1 : 0.4) / 5) * 5;
      H.stars[L.i] = Math.max(H.stars[L.i] || 0, stars);
      if (H.unlocked < L.i + 1 && L.i + 1 < HORDE_LEVELS.length) H.unlocked = L.i + 1;
    }
    H.dna += dna + bonus;
    persist();
    for (const d of this.defenders) d.hideAim();
    this.ui.showHordeResult({ win, level: L, stats: st, stars, dna, bonus, total: dna + bonus, first, rounds, best, timeLeft: this.hTime });
  },
};

export { HORDE_LEVELS, HORDE_UNITS, HORDE_ABILITIES, ZOMBIES };
