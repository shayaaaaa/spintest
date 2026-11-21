// Core gameplay: camera, rifle handling, enemies, survivors, missions and the kill cam.
import * as THREE from './three.module.min.js';
import { BASE_FOV, EYE, WALL_Z, WALL_HALF, ZOMBIES, MAPS, LEVELS, WALL_LEVELS, RIFLES, rifleStats, survivalWave } from './data.js';
import { save, persist, upgOf } from './save.js';
import { buildWorld } from './world.js';
import { buildHumanoid, zombieLook, survivorLook, buildRifle, CYL, bas, disposeOwned } from './models.js';
import { FX } from './fx.js';

const UP = new THREE.Vector3(0, 1, 0);
const V1 = new THREE.Vector3(), V2 = new THREE.Vector3();
const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
function lerpAngle(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

// ---------------------------------------------------------------- enemies
class Zombie {
  constructor(g, type, x, z, o = {}) {
    this.g = g; this.type = type;
    const d = this.def = ZOMBIES[type];
    this.m = buildHumanoid({ ...zombieLook(type), scale: d.scale * (d.boss ? 1 : rand(0.93, 1.07)) });
    this.root = this.m.root;
    this.scale = this.root.scale.x;
    this.root.position.set(x, 0, z);
    for (const h of this.m.hit) h.userData.zombie = this;
    this.maxHp = this.hp = d.hp * (o.hpMult || 1);
    this.speed = d.speed * (o.speedMult || 1) * (d.boss ? 1 : rand(0.85, 1.15));
    this.target = new THREE.Vector3(clamp(x * 0.3 + rand(-13, 13), -WALL_HALF + 1.5, WALL_HALF - 1.5), 0, WALL_Z - 0.75 - 0.25 * this.scale);
    this.state = o.rise ? 'rise' : 'walk';
    this.heading = Math.atan2(this.target.x - x, this.target.z - z);
    this.root.rotation.y = this.heading;
    this.phase = Math.random() * 10;
    this.groanT = rand(4, 16);
    this.attackT = rand(0.2, 1);
    this.react = 0;
    this.helmet = !!this.m.helmet;
    this.alive = true;
    this.removeMe = false;
    this.victim = null;
    this.bleed = 0;
    this.name = o.name || d.name;
    this.ambient = !!o.ambient;
    if (o.rise) this.root.position.y = -1.8 * this.scale;
    g.actors.add(this.root);
  }

  get pos() { return this.root.position; }
  hitMeshes() { return this.m.hit.filter(h => h.userData.part !== 'helmet' || this.helmet); }
  headWorld(out = new THREE.Vector3()) { return this.m.head.getWorldPosition(out); }

  computeDamage(part, base) {
    if (part === 'helmet' && this.helmet) return { dmg: base * 0.2, helmet: true, headshot: false };
    if (part === 'head') return { dmg: base * this.def.headMult, headshot: true };
    if (part === 'limb') return { dmg: base * 0.7, headshot: false };
    return { dmg: base, headshot: false };
  }

  hit(part, base, point, dir, pre) {
    const r = pre || this.computeDamage(part, base);
    if (r.helmet) this.knockHelmet(dir);
    this.hp -= r.dmg;
    this.react = this.def.boss ? 0.25 : this.def.wide ? 0.55 : 1;
    if (point) this.g.fx.blood(point, dir, r.headshot ? 20 : 10, this.def.boss ? 1.6 : 1);
    if (this.hp <= 0) {
      this.die(dir, r, base);
      return { killed: true, headshot: !!r.headshot, helmet: !!r.helmet };
    }
    return { killed: false, headshot: !!r.headshot, helmet: !!r.helmet };
  }

  knockHelmet(dir) {
    if (!this.helmet) return;
    this.helmet = false;
    const h = this.m.helmet;
    this.g.fx.sparks(h.getWorldPosition(V1), UP, 12);
    this.g.fx.throwPart(h, new THREE.Vector3(dir.x * 3 + rand(-1, 1), 4 + rand(0, 2), dir.z * 3 + rand(-1, 1)), 12, 5, 0.1 * this.scale);
    this.g.audio.ping();
    this.g.ui.feed('HELMET KNOCKED OFF', 'dim');
    this.g.rebuildHittables();
  }

  die(dir, r, base) {
    const g = this.g, m = this.m, d = this.def;
    this.alive = false;
    this.state = 'dying';
    this.dyingT = 0;
    if (this.victim) { this.victim.release(this); this.victim = null; }
    // fall away from the bullet
    const local = dir.clone().applyAxisAngle(UP, -this.root.rotation.y);
    this.fallDir = local.z < 0 ? -1 : 1;
    if (r.headshot) {
      m.headG.userData.bleed = 0.8;
      g.fx.throwPart(m.headG, new THREE.Vector3(dir.x * 4 + rand(-1.2, 1.2), 3.5 + rand(0, 2.5), dir.z * 4 + rand(-1.2, 1.2)), 11, 6, 0.29 * this.scale);
      this.bleed = 0.9;
    }
    const gib = d.explode || (!d.boss && base >= this.maxHp * 1.15 && base >= 200);
    if (gib) {
      for (const part of [m.shL, m.shR]) {
        g.fx.throwPart(part, new THREE.Vector3(dir.x * 5 + rand(-3, 3), 3 + rand(0, 4), dir.z * 5 + rand(-3, 3)), 14, 5, 0.1 * this.scale);
      }
      if (!r.headshot) g.fx.throwPart(m.headG, new THREE.Vector3(dir.x * 5 + rand(-2, 2), 5 + rand(0, 3), dir.z * 5 + rand(-2, 2)), 12, 6, 0.29 * this.scale);
      g.fx.blood(m.torso.getWorldPosition(V1), dir, 30, 1.8);
    }
    if (d.explode) {
      const p = this.pos.clone();
      this.root.visible = false;
      this.removeMe = true;
      g.later(0.08, () => g.explodeAt(p, 6, 340, { fromBloater: true }));
    }
    g.onZombieDown(this);
  }

  update(dt) {
    const g = this.g, m = this.m, d = this.def, p = this.root.position;
    if (dt <= 0) return;
    if (this.state === 'rise') {
      p.y += dt * 1.1 * this.scale;
      m.shL.rotation.x = -2.7 + Math.sin(this.phase += dt * 5) * 0.2;
      m.shR.rotation.x = -2.6 - Math.sin(this.phase) * 0.2;
      if (Math.random() < 0.3) g.fx.puff(V1.set(p.x + rand(-0.4, 0.4), 0.1, p.z + rand(-0.4, 0.4)), 0x6a5a40, 0.4, 0.8, 1, 0.3);
      if (p.y >= 0) { p.y = 0; this.state = 'walk'; }
      return;
    }
    if (this.state === 'dying') return this.updateDeath(dt);
    if (this.state === 'dead') {
      this.deadT += dt;
      if (this.deadT > 4.5) { p.y -= dt * 0.35; if (p.y < -1.0 * this.scale) this.removeMe = true; }
      return;
    }
    this.groanT -= dt;
    if (this.groanT <= 0) { this.groanT = rand(10, 24); if (!this.ambient) g.groanAt(this); }
    if (this.react > 0) this.react = Math.max(0, this.react - dt * 3);

    if (this.state === 'walk' || this.state === 'chase') {
      let tx = this.target.x, tz = this.target.z;
      const s = g.survivors.length ? g.nearestSurvivor(p, 28) : null;
      if (s) {
        tx = s.pos.x; tz = s.pos.z;
        this.state = 'chase';
        if (Math.hypot(tx - p.x, tz - p.z) < 0.85 * Math.max(1, this.scale)) { this.state = 'grab'; this.victim = s; s.grab(this); return; }
      } else this.state = 'walk';
      if (this.state === 'walk' && p.z >= this.target.z - 0.05) {
        this.state = 'attack';
        if (d.explode && !this.ambient) { this.hp = 0; this.die(new THREE.Vector3(0, 0, -1), {}, 0); g.damageWall(100, this); }
        return;
      }
      let dx = tx - p.x, dz = tz - p.z;
      const dist = Math.hypot(dx, dz) || 1;
      dx /= dist; dz /= dist;
      const R = 0.6 * this.scale;
      for (const o of g.world.obstacles) {
        const ox = p.x - o.x, oz = p.z - o.z;
        const od = Math.hypot(ox, oz) || 0.01;
        const rr = o.r + R;
        if (od < rr + 2.5) {
          let px = -oz / od, pz = ox / od;
          if (px * dx + pz * dz < 0) { px = -px; pz = -pz; }
          const w = (rr + 2.5 - od) / 2.5;
          // only steer when the obstacle is ahead
          if ((-ox) * dx + (-oz) * dz > -0.5) { dx += (px + ox / od * 0.5) * w * 1.4; dz += (pz + oz / od * 0.5) * w * 1.4; }
          if (od < rr) { p.x = o.x + ox / od * rr; p.z = o.z + oz / od * rr; }
        }
      }
      for (const z2 of g.zombies) {
        if (z2 === this || !z2.alive) continue;
        const ox = p.x - z2.pos.x, oz = p.z - z2.pos.z;
        const od = ox * ox + oz * oz;
        const min = 0.7 * (this.scale + z2.scale) * 0.5;
        if (od < min * min && od > 0.0001) { const k = (min - Math.sqrt(od)) * 0.5; const l = Math.sqrt(od); p.x += ox / l * k; p.z += oz / l * k; }
      }
      const want = Math.atan2(dx, dz);
      this.heading = lerpAngle(this.heading, want, 1 - Math.exp(-dt * 4));
      const spd = this.speed * (1 - this.react * 0.85);
      p.x += Math.sin(this.heading) * spd * dt;
      p.z += Math.cos(this.heading) * spd * dt;
      if (p.z > WALL_Z - 0.6) p.z = WALL_Z - 0.6;
      this.root.rotation.y = this.heading;
      this.animWalk(dt, spd);
    } else if (this.state === 'attack') {
      this.root.rotation.y = lerpAngle(this.root.rotation.y, 0, 1 - Math.exp(-dt * 5));
      this.animAttack(dt);
      this.attackT -= dt;
      if (this.attackT <= 0) {
        this.attackT = 1.0;
        if (!this.ambient) g.damageWall(d.dps, this);
        else if (Math.random() < 0.3) g.fx.splinters(V1.set(p.x, 1.0, WALL_Z - 0.2), 3);
      }
    } else if (this.state === 'grab') {
      const v = this.victim;
      if (!v || !v.alive || v.state === 'climb') { this.victim = null; this.state = 'walk'; return; }
      this.root.rotation.y = lerpAngle(this.root.rotation.y, Math.atan2(v.pos.x - p.x, v.pos.z - p.z), 1 - Math.exp(-dt * 8));
      this.animAttack(dt, true);
    }
  }

  animWalk(dt, spd) {
    const m = this.m, d = this.def;
    this.phase += dt * (1.8 + spd * 1.7);
    const s = Math.sin(this.phase), c = Math.cos(this.phase);
    const amp = d.lean ? 0.95 : 0.55;
    m.hipL.rotation.x = s * amp;
    m.hipR.rotation.x = -s * amp;
    if (d.lean) {
      m.shL.rotation.x = -1.1 - s * 0.6;
      m.shR.rotation.x = -1.1 + s * 0.6;
    } else {
      m.shL.rotation.x = -1.42 + Math.sin(this.phase * 0.5) * 0.14;
      m.shR.rotation.x = -1.32 + Math.cos(this.phase * 0.5) * 0.14;
    }
    m.shL.rotation.z = -0.1; m.shR.rotation.z = 0.1;
    m.body.position.y = Math.abs(c) * 0.05;
    m.body.rotation.z = s * (d.boss ? 0.09 : 0.06);
    m.body.rotation.x = (d.lean || 0) - this.react * 0.45;
    m.neck.rotation.z = Math.sin(this.phase * 0.5) * 0.2;
    m.neck.rotation.x = 0.12;
  }

  animAttack(dt, grab = false) {
    const m = this.m;
    this.phase += dt * (grab ? 9 : 6.5);
    const s = Math.sin(this.phase);
    m.shL.rotation.x = -1.95 + s * (grab ? 0.25 : 0.75);
    m.shR.rotation.x = -1.95 - s * (grab ? 0.25 : 0.75);
    m.hipL.rotation.x = 0.12; m.hipR.rotation.x = -0.12;
    m.body.rotation.x = 0.16 + s * 0.06 - this.react * 0.45;
    m.body.rotation.z = 0;
    m.neck.rotation.x = 0.25 + s * 0.1;
  }

  updateDeath(dt) {
    const m = this.m;
    this.dyingT += dt;
    const k = Math.min(1, this.dyingT / 0.55);
    const e = k * k;
    m.body.rotation.x += (this.fallDir * 1.5 * e - m.body.rotation.x) * Math.min(1, dt * 20);
    m.body.position.y = 0.17 * e;
    m.body.rotation.z *= 0.9;
    for (const h of [m.hipL, m.hipR]) h.rotation.x *= Math.max(0, 1 - dt * 6);
    m.shL.rotation.x += ((this.fallDir < 0 ? -2.9 : -0.3) - m.shL.rotation.x) * Math.min(1, dt * 6);
    m.shR.rotation.x += ((this.fallDir < 0 ? -2.6 : -0.5) - m.shR.rotation.x) * Math.min(1, dt * 6);
    if (this.bleed > 0) {
      this.bleed -= dt;
      this.g.fx.fountain(m.neck.getWorldPosition(V1), V2.set(0, 1, 0), 2);
    }
    if (k >= 1 && this.dyingT > 0.6) {
      this.state = 'dead'; this.deadT = 0;
      this.g.fx.puff(V1.set(this.pos.x, 0.15, this.pos.z), 0x8a7a60, 0.6 * this.scale, 0.9, 3, 0.3);
      this.g.fx.decal(this.pos, 0.6 * this.scale, 0x4a0606);
    }
  }
}

// ---------------------------------------------------------------- survivors
class Survivor {
  constructor(g, x, z) {
    this.g = g;
    this.m = buildHumanoid({ ...survivorLook(), scale: rand(0.88, 0.98) });
    this.root = this.m.root;
    this.scale = this.root.scale.x;
    this.root.position.set(x, 0, z);
    for (const h of this.m.hit) h.userData.survivor = this;
    this.hp = 100;
    this.state = 'run';
    this.speed = rand(2.1, 2.5);
    this.target = new THREE.Vector3(rand(-10, 10), 0, WALL_Z - 0.4);
    this.heading = Math.atan2(this.target.x - x, this.target.z - z);
    this.phase = Math.random() * 6;
    this.grabbers = new Set();
    this.alive = true;
    this.removeMe = false;
    this.t = 0;
    this.helpT = rand(1, 4);
    g.actors.add(this.root);
  }
  get pos() { return this.root.position; }
  get free() { return this.alive && (this.state === 'run' || this.state === 'grabbed'); }

  grab(z) {
    this.grabbers.add(z);
    if (this.state === 'run') {
      this.state = 'grabbed';
      const g = this.g;
      if (g.time - (g.lastGrabAlert || 0) > 2) { g.lastGrabAlert = g.time; g.ui.feed('SURVIVOR GRABBED! SHOOT THE ATTACKER', 'bad'); g.audio.scream(g.panOf(this.pos)); }
    }
  }
  release(z) { this.grabbers.delete(z); if (this.grabbers.size === 0 && this.state === 'grabbed') this.state = 'run'; }

  kill(friendly = false) {
    if (!this.alive) return;
    this.alive = false;
    this.state = 'dying';
    this.dyingT = 0;
    for (const z of this.grabbers) { z.victim = null; z.state = 'walk'; }
    this.grabbers.clear();
    if (this.m.marker) this.m.marker.visible = false;
    this.g.fx.blood(this.m.torso.getWorldPosition(V1), V2.set(0, 0, -1), 16);
    this.g.audio.scream(this.g.panOf(this.pos));
    this.g.onSurvivorLost(this, friendly);
  }

  update(dt) {
    const m = this.m, p = this.root.position, g = this.g;
    this.t += dt;
    if (m.marker) { m.marker.position.y = 2.35 + Math.sin(this.t * 4) * 0.12; m.marker.rotation.y += dt * 2.5; }
    if (this.state === 'run') {
      let dx = this.target.x - p.x, dz = this.target.z - p.z;
      const dist = Math.hypot(dx, dz) || 1;
      dx /= dist; dz /= dist;
      for (const o of g.world.obstacles) {
        const ox = p.x - o.x, oz = p.z - o.z, od = Math.hypot(ox, oz) || 0.01, rr = o.r + 0.5;
        if (od < rr + 2.5 && (-ox) * dx + (-oz) * dz > -0.5) {
          let px = -oz / od, pz = ox / od;
          if (px * dx + pz * dz < 0) { px = -px; pz = -pz; }
          const w = (rr + 2.5 - od) / 2.5;
          dx += (px + ox / od * 0.5) * w * 1.4; dz += (pz + oz / od * 0.5) * w * 1.4;
        }
        if (od < rr) { p.x = o.x + ox / od * rr; p.z = o.z + oz / od * rr; }
      }
      for (const z of g.zombies) {
        if (!z.alive) continue;
        const ox = p.x - z.pos.x, oz = p.z - z.pos.z, od = Math.hypot(ox, oz);
        if (od < 6 && od > 0.01) { const w = (6 - od) / 6 * 0.9; dx += ox / od * w; dz += oz / od * w * 0.4; }
      }
      this.heading = lerpAngle(this.heading, Math.atan2(dx, dz), 1 - Math.exp(-dt * 5));
      p.x += Math.sin(this.heading) * this.speed * dt;
      p.z += Math.cos(this.heading) * this.speed * dt;
      this.root.rotation.y = this.heading;
      this.phase += dt * 11;
      const s = Math.sin(this.phase);
      m.hipL.rotation.x = s * 0.9; m.hipR.rotation.x = -s * 0.9;
      m.shL.rotation.x = -s * 0.9; m.shR.rotation.x = s * 0.9;
      m.body.position.y = Math.abs(Math.cos(this.phase)) * 0.08;
      m.body.rotation.x = 0.15;
      this.helpT -= dt;
      if (this.helpT <= 0) { this.helpT = rand(4, 8); }
      if (p.z >= WALL_Z - 0.9) { this.state = 'climb'; this.climbT = 0; }
    } else if (this.state === 'grabbed') {
      this.hp -= 30 * this.grabbers.size * dt;
      this.phase += dt * 14;
      const s = Math.sin(this.phase);
      m.shL.rotation.x = -2.6 + s * 0.5; m.shR.rotation.x = -2.6 - s * 0.5;
      m.hipL.rotation.x = s * 0.2; m.hipR.rotation.x = -s * 0.2;
      m.body.rotation.z = s * 0.15;
      if (Math.random() < dt * 2) g.fx.blood(m.torso.getWorldPosition(V1), V2.set(rand(-1, 1), 0, rand(-1, 1)), 3);
      if (this.hp <= 0) this.kill();
    } else if (this.state === 'climb') {
      this.climbT += dt;
      p.y = Math.sin(Math.min(1, this.climbT / 0.9) * Math.PI) * 1.4;
      p.z += dt * 1.6;
      m.shL.rotation.x = -2.8; m.shR.rotation.x = -2.8;
      if (this.climbT > 0.9) { this.removeMe = true; this.alive = false; g.onSurvivorSaved(this); }
    } else if (this.state === 'dying') {
      this.dyingT += dt;
      const k = Math.min(1, this.dyingT / 0.6);
      m.body.rotation.x = 1.5 * k * k;
      m.body.position.y = 0.17 * k;
      if (this.dyingT > 6) { p.y -= dt * 0.3; if (p.y < -1) this.removeMe = true; }
    }
  }
}

// ---------------------------------------------------------------- weapon viewmodel
function flashTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const x = c.getContext('2d');
  const gr = x.createRadialGradient(64, 64, 2, 64, 64, 62);
  gr.addColorStop(0, 'rgba(255,255,235,1)'); gr.addColorStop(0.25, 'rgba(255,210,110,0.9)'); gr.addColorStop(1, 'rgba(255,120,30,0)');
  x.fillStyle = gr;
  x.beginPath();
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2, r = i % 2 ? 26 : 62;
    x.lineTo(64 + Math.cos(a) * r, 64 + Math.sin(a) * r);
  }
  x.closePath(); x.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

class ViewModel {
  constructor(camera) {
    this.holder = new THREE.Group();
    camera.add(this.holder);
    this.rest = new THREE.Vector3(0.19, -0.185, -0.5);
    this.ads = new THREE.Vector3(0.0, -0.075, -0.3);
    this.kick = 0; this.adsK = 0; this.reloadK = 0; this.boltK = 0; this.t = 0;
    this.showcase = false; this.showT = 0;
    const tex = flashTexture();
    this.flashMat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
    this.flashT = 0;
  }
  setRifle(def) {
    if (this.gun) this.holder.remove(this.gun);
    const { group, muzzle } = buildRifle(def);
    this.gun = group; this.muzzle = muzzle; this.def = def;
    this.holder.add(group);
    const f = new THREE.Group();
    const a = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.34), this.flashMat);
    const b = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.5), this.flashMat);
    b.rotation.y = Math.PI / 2; b.position.z = -0.18; b.rotation.z = Math.PI / 2;
    const c = b.clone(); c.rotation.x = Math.PI / 2;
    f.add(a, b, c);
    f.visible = false;
    muzzle.add(f);
    this.flash = f;
  }
  fire() { this.kick = 1; this.flashT = 0.05; this.flash.visible = true; this.flash.rotation.z = Math.random() * 6; }
  update(dt, g) {
    this.t += dt;
    this.kick = Math.max(0, this.kick - dt * 5.5);
    const wantAds = g.scoped ? 1 : 0;
    this.adsK += (wantAds - this.adsK) * Math.min(1, dt * 18);
    const r = g.rifle;
    const rel = g.reloading > 0 ? Math.sin(Math.min(1, 1 - g.reloading / r.reload) * Math.PI) : 0;
    this.reloadK += (rel - this.reloadK) * Math.min(1, dt * 12);
    const bolt = !r.semi && g.chamber > 0 && g.reloading <= 0 ? Math.sin(clamp(1 - g.chamber / r.bolt, 0, 1) * Math.PI) : 0;
    this.boltK += (bolt - this.boltK) * Math.min(1, dt * 20);
    if (this.flashT > 0) { this.flashT -= dt; if (this.flashT <= 0) this.flash.visible = false; }
    const gun = this.gun;
    if (this.showcase) {
      this.showT += dt;
      this.holder.visible = true;
      // park the rifle in the empty left half of the armory screen, side-on
      const cam = g.camera, d = 1.7;
      const halfH = d * Math.tan(cam.fov * Math.PI / 360), halfW = halfH * cam.aspect;
      const portrait = cam.aspect < 1;
      gun.position.set(portrait ? 0.1 : -halfW * 0.5 + 0.2, portrait ? halfH * 0.42 : halfH * 0.3, -d);
      gun.rotation.set(0.06, Math.PI / 2 + Math.sin(this.showT * 0.5) * 0.3, 0.04);
      gun.scale.setScalar(portrait ? 0.8 : Math.min(1.05, halfW * 0.62));
      return;
    }
    gun.scale.setScalar(0.66);
    const bob = Math.sin(this.t * 1.6) * 0.004;
    gun.position.copy(this.rest).lerp(this.ads, this.adsK);
    gun.position.y += bob - this.reloadK * 0.16 - this.boltK * 0.02;
    gun.position.z += this.kick * 0.07;
    gun.rotation.set(this.kick * 0.16 - this.reloadK * 0.5, 0.04 * (1 - this.adsK), this.reloadK * 0.5 + this.boltK * 0.25);
    if (gun.userData.bolt) gun.userData.bolt.position.z = 0.1 + this.boltK * 0.08;
    this.holder.visible = (g.state === 'playing' || g.state === 'over' || g.state === 'paused') && !g.scopeShown;
  }
}

// ---------------------------------------------------------------- game
export class Game {
  constructor(canvas, ui, audio) {
    this.ui = ui; this.audio = audio;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.maxPR = Math.min(window.devicePixelRatio || 1, 2);
    this.pr = save.settings.quality === 'low' ? 1 : this.maxPR;
    this.renderer.setPixelRatio(this.pr);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(BASE_FOV, 1, 0.05, 2200);
    this.camera.rotation.order = 'YXZ';
    this.scene.add(this.camera);
    this.actors = new THREE.Group();
    this.scene.add(this.actors);
    this.fx = new FX(this.scene);
    this.gun = new ViewModel(this.camera);
    this.ray = new THREE.Raycaster();
    this.time = 0;
    this.state = 'menu';
    this.mode = null;
    this.yaw = 0; this.pitch = -0.1;
    this.chamber = 0; this.reloading = 0; this.ammo = 0;
    this.scoped = false; this.scopeShown = false; this.zoomT = 0.6;
    this.fov = BASE_FOV;
    this.recoil = 0; this.recoilYaw = 0; this.shake = 0;
    this.zombies = []; this.survivors = []; this.hittables = [];
    this.queue = []; this.timers = [];
    this.focusT = 0;
    this.kc = null;
    this.lastKillcam = -99;
    this.mapIndex = -1;
    this.menuT = 0;
    this.perf = { t: 0, n: 0 };
    this.bullet = this.makeBullet();
    this.equip(save.equipped);
    this.loadMap(0);
    this.resize();
  }

  makeBullet() {
    const g = new THREE.Group();
    const body = new THREE.Mesh(CYL, bas(0xd8a640));
    body.scale.set(0.042, 0.19, 0.042); body.rotation.x = Math.PI / 2;
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.042, 0.1, 10), bas(0xb07a3a));
    tip.rotation.x = Math.PI / 2; tip.position.z = 0.145;
    g.add(body, tip);
    g.visible = false;
    this.scene.add(g);
    return g;
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setQuality(q) {
    save.settings.quality = q; persist();
    this.pr = q === 'low' ? 1 : this.maxPR;
    this.renderer.setPixelRatio(this.pr);
    this.resize();
  }

  equip(id) {
    save.equipped = id;
    this.rifle = rifleStats(id, upgOf(id));
    this.gun.setRifle(this.rifle);
    this.ammo = this.rifle.mag;
  }

  loadMap(i) {
    if (this.mapIndex === i && this.world) return;
    if (this.world) { this.scene.remove(this.world.root); this.world.dispose(); }
    this.clearActors();
    this.mapIndex = i;
    const M = MAPS[i];
    this.world = buildWorld(M);
    this.scene.add(this.world.root);
    this.scene.fog = new THREE.Fog(M.fog, M.fogNear, M.fogFar);
    this.scene.background = new THREE.Color(M.fog);
    this.rebuildHittables();
  }

  clearActors() {
    for (const z of this.zombies) { this.actors.remove(z.root); disposeOwned(z.root); }
    for (const s of this.survivors) { this.actors.remove(s.root); disposeOwned(s.root); }
    this.zombies = []; this.survivors = [];
    this.fx.clear();
    this.timers = [];
  }

  rebuildHittables() {
    const list = this.world ? [...this.world.colliders] : [];
    for (const z of this.zombies) if (z.alive) list.push(...z.hitMeshes());
    for (const s of this.survivors) if (s.alive) list.push(...s.m.hit);
    this.hittables = list;
  }

  later(t, fn, real = false) { this.timers.push({ t, fn, real }); }

  // ------------------------------------------------------------ mission setup
  startCampaign(index) {
    const L = LEVELS[index];
    this.mode = 'campaign';
    this.level = L;
    this.begin(L.map);
    this.hpMult = L.hpMult; this.speedMult = L.speedMult; this.maxAlive = L.maxAlive;
    this.queue = this.buildQueue(L.comp, L.waves);
    if (L.type === 'boss') {
      const at = Math.max(2, Math.floor(this.queue.length * 0.25));
      this.queue.splice(at, 0, { boss: true });
    }
    if (L.type === 'rescue') {
      this.survivorQueue = L.survivors;
      this.survivorT = 2.5;
      this.maxAlive = Math.min(this.maxAlive, 9);
    }
    const sub = L.type === 'defend' ? 'Eliminate every infected' : L.type === 'rescue' ? `Save at least ${L.required} survivors` : `Kill the ${L.boss.name}`;
    this.ui.banner(L.name.toUpperCase(), sub);
  }

  startSurvival(mapIndex) {
    this.mode = 'survival';
    this.level = { type: 'survival', map: mapIndex, name: 'Survival' };
    this.begin(mapIndex);
    this.wave = 0;
    this.nextSurvivalWave();
  }

  nextSurvivalWave() {
    this.wave++;
    const W = survivalWave(this.wave);
    this.hpMult = W.hpMult; this.speedMult = W.speedMult; this.maxAlive = W.maxAlive;
    this.queue = this.buildQueue(W.comp, 1);
    if (W.boss) this.queue.splice(3, 0, { boss: true, name: W.boss.name, hpMult: W.boss.hpMult });
    this.waveBonus = W.bonus;
    this.waveBreak = 2.5;
    this.ui.banner(`WAVE ${this.wave}`, this.wave === 1 ? 'Hold out as long as you can' : `Wave bonus +$${this.waveBonus}`);
    this.audio.horn();
  }

  begin(mapIndex) {
    this.loadMap(mapIndex);
    this.clearActors();
    this.rebuildHittables();
    this.equip(save.equipped);
    this.wallMax = WALL_LEVELS[save.wall].hp;
    this.wallHp = this.wallMax;
    this.world.barricade.setHealth(1);
    this.chamber = 0; this.reloading = 0;
    this.scoped = false; this.scopeShown = false;
    this.yaw = 0; this.pitch = -0.12;
    this.focusT = 0; this.audio.setFocus(false); this.ui.focus(false);
    this.stats = { kills: 0, heads: 0, shots: 0, hits: 0, earned: 0, saved: 0, lost: 0, friendly: 0 };
    this.streak = 0;
    this.spawnT = 2.5; this.waveBreak = 0; this.waveNum = 1;
    this.ending = null; this.bossDead = false; this.boss = null;
    this.survivorQueue = 0;
    this.lastKillcam = this.time;
    this.state = 'playing';
    this.gun.showcase = false;
    this.ui.setScoped(false);
  }

  buildQueue(comp, waves) {
    const list = [];
    for (const [type, n] of Object.entries(comp)) for (let i = 0; i < n; i++) list.push(type);
    shuffle(list);
    // open with a few walkers so the player can settle in
    const front = [];
    for (let i = 0; i < list.length && front.length < 3; i++) {
      if (list[i] === 'walker') { front.push(list.splice(i, 1)[0]); i--; }
    }
    const ordered = front.concat(list);
    const q = [];
    const per = Math.ceil(ordered.length / waves);
    for (let w = 0; w < waves; w++) {
      if (w > 0) q.push({ wave: w + 1 });
      for (const t of ordered.slice(w * per, (w + 1) * per)) q.push({ type: t });
    }
    return q;
  }

  aliveCount() { let n = 0; for (const z of this.zombies) if (z.alive) n++; return n; }
  remainingCount() { return this.queue.filter(q => q.type || q.boss).length + this.aliveCount(); }

  spawnZombie(type, o = {}) {
    let x = 0, z = -80, tries = 0;
    const rescueNear = this.level?.type === 'rescue' && Math.random() < 0.55;
    const runners = this.survivors.filter(s => s.free);
    do {
      if (rescueNear && runners.length) {
        const s = pick(runners);
        x = s.pos.x + (Math.random() < 0.5 ? -1 : 1) * rand(5, 15);
        z = s.pos.z + rand(8, 24);
        if (Math.hypot(x - s.pos.x, z - s.pos.z) < 8) continue;
      } else {
        const a = rand(-0.95, 0.95), r = rand(52, 106);
        x = Math.sin(a) * r; z = -Math.cos(a) * r;
      }
      x = clamp(x, -44, 44); z = clamp(z, -118, rescueNear ? -30 : -38);
      tries++;
    } while (tries < 14 && this.world.obstacles.some(ob => Math.hypot(ob.x - x, ob.z - z) < ob.r + 1.2));
    const rise = !o.ambient && type !== 'boss' && Math.random() < 0.3;
    const zb = new Zombie(this, type, x, z, { hpMult: (o.hpMult || 1) * (this.hpMult || 1), speedMult: this.speedMult || 1, rise, name: o.name, ambient: o.ambient });
    this.zombies.push(zb);
    this.rebuildHittables();
    return zb;
  }

  spawnSurvivor() {
    const a = rand(-0.7, 0.7), r = rand(95, 112);
    const s = new Survivor(this, clamp(Math.sin(a) * r, -40, 40), clamp(-Math.cos(a) * r, -118, -90));
    this.survivors.push(s);
    this.rebuildHittables();
    this.ui.feed('SURVIVOR SPOTTED. COVER THEM', 'good');
    this.audio.chime();
  }

  nearestSurvivor(p, maxD) {
    let best = null, bd = maxD * maxD;
    for (const s of this.survivors) {
      if (!s.free) continue;
      const dx = s.pos.x - p.x, dz = s.pos.z - p.z, d = dx * dx + dz * dz;
      if (d < bd) { bd = d; best = s; }
    }
    return best;
  }

  updateSpawner(dt) {
    if (this.level?.type === 'rescue' && this.survivorQueue > 0) {
      this.survivorT -= dt;
      if (this.survivorT <= 0) { this.survivorQueue--; this.survivorT = rand(9, 13); this.spawnSurvivor(); }
    }
    if (this.waveBreak > 0) { this.waveBreak -= dt; return; }
    if (!this.queue.length) {
      if (this.mode === 'survival' && this.aliveCount() === 0) {
        this.stats.earned += this.waveBonus;
        this.ui.feed(`WAVE ${this.wave} CLEARED  +$${this.waveBonus}`, 'gold');
        this.nextSurvivalWave();
        return;
      }
      if (this.level?.type === 'rescue' && (this.survivorQueue > 0 || this.survivors.some(s => s.free))) {
        this.queue = this.buildQueue({ walker: 4, runner: 2 }, 1);
      }
      return;
    }
    const head = this.queue[0];
    if (head.wave) {
      if (this.aliveCount() === 0) {
        this.queue.shift();
        this.waveNum = head.wave;
        this.ui.banner(`WAVE ${head.wave}`, `${this.remainingCount()} infected incoming`);
        this.audio.horn();
        this.waveBreak = 3;
      }
      return;
    }
    if (head.boss) {
      if (this.aliveCount() > 2) return;
      this.queue.shift();
      const bname = head.name || this.level.boss?.name || 'Butcher';
      const b = this.spawnZombie('boss', { hpMult: head.hpMult || this.level.boss?.hpMult || 1, name: bname });
      b.isBoss = true;
      this.boss = b;
      this.ui.banner(`THE ${bname.toUpperCase()}`, 'Aim for the head');
      this.audio.horn();
      this.later(0.4, () => this.audio.groan(this.panOf(b.pos), 0.6, 0.75));
      return;
    }
    this.spawnT -= dt;
    if (this.spawnT > 0 || this.aliveCount() >= this.maxAlive) return;
    this.queue.shift();
    this.spawnZombie(head.type);
    this.spawnT = rand(0.7, 2.4) * (this.level?.type === 'rescue' ? 1.3 : 1);
  }

  // ------------------------------------------------------------ events
  panOf(p) {
    const dx = p.x - EYE.x, dz = p.z - EYE.z;
    const l = Math.hypot(dx, dz) || 1;
    return clamp((dx * Math.cos(this.yaw) - dz * Math.sin(this.yaw)) / l, -1, 1);
  }

  groanAt(z) {
    const d = Math.hypot(z.pos.x, z.pos.z);
    const vol = (z.def.boss ? 0.6 : 0.3) * clamp(1 - d / 130, 0.05, 1);
    this.audio.groan(this.panOf(z.pos), vol, z.def.boss ? 0.75 : z.def.lean ? 1.25 : 1);
  }

  damageWall(amount, z) {
    if (this.state !== 'playing' && this.state !== 'killcam') return;
    if (this.wallHp <= 0) return;
    this.wallHp = Math.max(0, this.wallHp - amount);
    this.world.barricade.setHealth(this.wallHp / this.wallMax);
    this.fx.splinters(V1.set(z.pos.x, 0.9, WALL_Z - 0.1), z.def.boss ? 14 : 5);
    if (Math.random() < 0.6 || z.def.boss) this.audio.wood(this.panOf(z.pos), z.def.boss ? 0.7 : 0.3);
    if (z.def.boss) this.shake += 0.8;
    this.ui.wallHit();
  }

  explodeAt(p, radius, dmg, o = {}) {
    this.fx.explosion(p, radius / 6);
    const d0 = Math.hypot(p.x, p.z);
    this.audio.explosion(clamp(1.2 - d0 / 120, 0.3, 1));
    this.shake += d0 < 30 ? 1.4 : 0.5;
    let kills = 0;
    for (const z of this.zombies) {
      if (!z.alive) continue;
      const d = Math.hypot(z.pos.x - p.x, z.pos.z - p.z);
      if (d > radius) continue;
      const dir = V2.set(z.pos.x - p.x, 0.5, z.pos.z - p.z).normalize().clone();
      const out = z.hit('body', 0, null, dir, { dmg: dmg * (1 - d / radius * 0.6), headshot: false });
      if (out.killed) { kills++; this.onKill(z, false, true); }
    }
    if (!o.mortar) for (const s of this.survivors) if (s.alive && s.state !== 'climb' && Math.hypot(s.pos.x - p.x, s.pos.z - p.z) < radius * 0.7) s.kill();
    if (o.fromBloater && p.z > WALL_Z - 5) this.damageWall(120, { pos: p, def: {} });
    if (kills >= 2 && !o.silent) this.ui.feed(`CHAIN REACTION ×${kills}`, 'gold');
  }

  onZombieDown(z) {
    this.rebuildHittables();
    if (z === this.boss) { this.bossDead = true; }
  }

  onKill(z, headshot, explosive = false) {
    if (this.state !== 'playing' && this.state !== 'killcam') return;
    if (z.ambient) return;
    const d = z.def;
    let cash = d.cash;
    if (headshot) cash = Math.round(cash * 1.5);
    this.stats.kills++;
    this.stats.earned += cash;
    if (headshot) {
      this.stats.heads++;
      this.streak++;
      this.ui.bigText(this.streak > 1 ? `HEADSHOT ×${this.streak}` : 'HEADSHOT', 'head');
      this.audio.headshot();
    } else if (!explosive) {
      this.streak = 0;
    }
    this.ui.feed(`${(d.boss ? z.name : d.name).toUpperCase()}${headshot ? '  HEADSHOT' : explosive ? '  BLAST' : ''}  +$${cash}`, headshot ? 'head' : '');
    if (d.boss) { this.ui.banner(`${z.name.toUpperCase()} DOWN`, `+$${cash}`); this.shake += 1; }
  }

  onSurvivorSaved(s) {
    this.stats.saved++;
    this.stats.earned += 100;
    this.ui.feed('SURVIVOR SAFE  +$100', 'good');
    this.audio.chime();
  }

  onSurvivorLost(s, friendly) {
    this.stats.lost++;
    if (friendly) {
      this.stats.friendly++;
      this.stats.earned = Math.max(0, this.stats.earned - 150);
      this.ui.bigText('FRIENDLY FIRE', 'bad');
      this.ui.feed('YOU SHOT A SURVIVOR  -$150', 'bad');
    } else this.ui.feed('SURVIVOR LOST', 'bad');
    this.rebuildHittables();
  }

  // ------------------------------------------------------------ player actions
  zoomLevel() { return 2 + (this.rifle.zoom - 2) * this.zoomT; }

  look(dx, dy) {
    if (this.state !== 'playing') return;
    const k = save.settings.sens * (this.camera.fov * Math.PI / 180) / Math.max(320, window.innerHeight) * 1.15;
    this.yaw -= dx * k;
    this.pitch -= dy * k * (save.settings.invertY ? -1 : 1);
    this.yaw = clamp(this.yaw, -1.22, 1.22);
    this.pitch = clamp(this.pitch, -0.86, 0.32);
  }

  toggleScope(on = !this.scoped) {
    if (this.state !== 'playing') return;
    this.scoped = on;
    if (!on) { this.scopeShown = false; this.ui.setScoped(false); }
    this.audio.click(0, on ? 1400 : 1000, 0.15);
  }

  setZoom(t) { this.zoomT = clamp(t, 0, 1); }

  startReload() {
    if ((this.state !== 'playing' && this.state !== 'killcam') || this.reloading > 0 || this.ammo >= this.rifle.mag) return;
    this.reloading = this.rifle.reload;
    this.audio.reload(this.rifle.reload);
  }

  useItem(key) {
    if (this.state !== 'playing' || !(save.items[key] > 0)) return;
    if (key === 'focus' && this.focusT > 0) return;
    if (key === 'repair' && this.wallHp >= this.wallMax) { this.ui.feed('WALL IS ALREADY INTACT', 'dim'); return; }
    save.items[key]--; persist();
    if (key === 'focus') {
      this.focusT = 8;
      this.audio.setFocus(true);
      this.ui.focus(true);
      this.ui.feed('FOCUS: THE INFECTED ARE SLOWED', 'good');
    } else if (key === 'repair') {
      this.wallHp = Math.min(this.wallMax, this.wallHp + this.wallMax * 0.4);
      this.world.barricade.setHealth(this.wallHp / this.wallMax);
      for (let i = 0; i < 6; i++) this.fx.splinters(V1.set(rand(-WALL_HALF, WALL_HALF), 1, WALL_Z), 4);
      this.audio.wood(0, 0.5); this.later(0.25, () => this.audio.wood(-0.4, 0.5), true); this.later(0.5, () => this.audio.wood(0.4, 0.5), true);
      this.ui.feed('WALL REPAIRED', 'good');
    } else if (key === 'strike') {
      this.ui.feed('MORTAR STRIKE INBOUND', 'gold');
      this.audio.whistle();
      const targets = this.zombies.filter(z => z.alive && z.pos.z > WALL_Z - 45).map(z => z.pos.clone());
      for (let i = 0; i < 12; i++) {
        const p = targets.length && i < targets.length * 1.5 ? pick(targets).clone().add(new THREE.Vector3(rand(-2, 2), 0, rand(-2, 2)))
          : new THREE.Vector3(rand(-WALL_HALF, WALL_HALF), 0, rand(WALL_Z - 35, WALL_Z - 4));
        this.later(0.9 + i * 0.16, () => this.explodeAt(p, 6, 600, { silent: i < 11, mortar: true }), true);
      }
    }
  }

  fire() {
    if (this.state !== 'playing') return;
    if (this.reloading > 0 || this.chamber > 0) return;
    if (this.ammo <= 0) { this.audio.dry(); this.startReload(); return; }
    const r = this.rifle;
    this.ammo--;
    this.chamber = r.bolt;
    this.stats.shots++;
    this.audio.shot(r.recoil);
    if (!r.semi && this.ammo > 0) this.audio.bolt(0.12);
    this.gun.fire();
    if (this.scopeShown) this.ui.scopeFlash();
    this.camera.updateMatrixWorld();
    const origin = this.camera.getWorldPosition(new THREE.Vector3());
    const dir = new THREE.Vector3(0, 0, -1);
    dir.applyQuaternion(this.camera.quaternion);
    this.recoil += (this.scopeShown ? 0.028 : 0.05) * r.recoil;
    this.recoilYaw += (Math.random() - 0.5) * 0.012 * r.recoil;
    this.shake += 0.35 * r.recoil;

    const shot = this.traceShot(origin, dir);
    // kill cam on the final kill, a boss kill, or now and then on a long headshot
    const kills = shot.res.filter(h => h.kind === 'z' && h.willKill);
    let cam = null;
    if (save.settings.killcam && kills.length) {
      const L = this.level;
      const finalKill = this.mode === 'campaign' && L.type === 'defend' && !this.queue.some(q => q.type || q.boss) && this.aliveCount() === kills.length;
      const bossKill = kills.find(h => h.z.def.boss);
      const longHead = kills.find(h => h.dmg.headshot && h.point.distanceTo(origin) > 55);
      if (finalKill) cam = kills[kills.length - 1];
      else if (bossKill) cam = bossKill;
      else if (longHead && this.time - this.lastKillcam > 25 && Math.random() < 0.22) cam = longHead;
    }
    if (cam) this.startKillcam(shot, cam);
    else this.applyShot(shot);
    if (this.ammo === 0) this.later(r.bolt * 0.6, () => this.startReload(), true);
  }

  traceShot(origin, dir) {
    this.scene.updateMatrixWorld();
    this.ray.set(origin, dir);
    this.ray.far = 800;
    const hits = this.ray.intersectObjects(this.hittables, false);
    const res = [];
    let pen = this.rifle.pen;
    const seen = new Set();
    let end = origin.clone().addScaledVector(dir, 500);
    for (const h of hits) {
      const ud = h.object.userData;
      if (ud.zombie) {
        const z = ud.zombie;
        if (!z.alive || seen.has(z)) continue;
        if (ud.part === 'helmet' && !z.helmet) continue;
        seen.add(z);
        const dm = z.computeDamage(ud.part, this.rifle.dmg);
        res.push({ kind: 'z', z, part: ud.part, point: h.point.clone(), dmg: dm, willKill: z.hp - dm.dmg <= 0 });
        if (--pen <= 0) { end = h.point.clone(); break; }
      } else if (ud.survivor) {
        if (!ud.survivor.alive) continue;
        res.push({ kind: 's', s: ud.survivor, point: h.point.clone() });
        end = h.point.clone();
        break;
      } else {
        const n = h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld) : null;
        res.push({ kind: 'static', point: h.point.clone(), normal: n, surface: ud.surface || 'dirt' });
        end = h.point.clone();
        break;
      }
    }
    return { res, end, origin, dir };
  }

  applyShot(shot, cinematic = false) {
    let kills = 0;
    let hitAny = false;
    for (const h of shot.res) {
      if (h.kind === 'z') {
        const z = h.z;
        if (!z.alive) continue;
        hitAny = true;
        const dm = z.computeDamage(h.part, this.rifle.dmg);
        const out = z.hit(h.part, this.rifle.dmg, h.point, shot.dir, dm);
        this.stats.hits++;
        if (out.killed) { kills++; this.onKill(z, out.headshot); }
        else this.audio.hit(this.panOf(z.pos));
      } else if (h.kind === 's') {
        h.s.kill(true);
      } else {
        this.fx.impact(h.point, h.normal, h.surface);
        const pan = this.panOf(h.point);
        if (h.surface === 'metal' || h.surface === 'wood') this.audio.ricochet(pan); else this.audio.dirt(pan);
      }
    }
    if (hitAny) this.ui.hitmarker(kills > 0);
    if (kills >= 2) {
      const bonus = 30 * kills;
      this.stats.earned += bonus;
      this.ui.feed(`${kills === 2 ? 'DOUBLE' : kills === 3 ? 'TRIPLE' : 'MULTI'} KILL  +$${bonus}`, 'gold');
      this.ui.bigText(kills === 2 ? 'DOUBLE KILL' : 'TRIPLE KILL', 'gold');
    }
    if (!this.scopeShown && !cinematic) {
      const from = this.gun.muzzle.getWorldPosition(new THREE.Vector3());
      this.fx.shootTracer(from, shot.end);
    }
  }

  // ------------------------------------------------------------ kill cam
  startKillcam(shot, target) {
    this.state = 'killcam';
    this.lastKillcam = this.time;
    const from = shot.origin.clone().addScaledVector(shot.dir, 2.5);
    const to = target.point.clone();
    const dist = from.distanceTo(to);
    const side = new THREE.Vector3().crossVectors(shot.dir, UP).normalize();
    const up = new THREE.Vector3().crossVectors(side, shot.dir).normalize();
    this.kc = { shot, from, to, dir: shot.dir.clone(), side, up, t: 0, dur: clamp(dist / 38, 0.9, 2.2), phase: 'fly', ringT: 0, spin: Math.random() < 0.5 ? 1 : -1, target: target.z };
    this.bullet.visible = true;
    this.ui.killcam(true);
    this.audio.whoosh(this.kc.dur);
    this.camera.fov = 40;
    this.camera.updateProjectionMatrix();
  }

  updateKillcam(dt) {
    const k = this.kc, cam = this.camera;
    k.t += dt;
    if (k.phase === 'fly') {
      const u = Math.min(1, k.t / k.dur);
      const pos = V1.copy(k.from).lerp(k.to, u);
      this.bullet.position.copy(pos);
      this.bullet.lookAt(V2.copy(pos).add(k.dir));
      this.bullet.rotateZ(k.t * 20);
      const ang = u * 1.5 * k.spin + 0.5;
      cam.position.copy(pos)
        .addScaledVector(k.side, Math.cos(ang) * 0.26)
        .addScaledVector(k.up, Math.sin(ang) * 0.14 + 0.1)
        .addScaledVector(k.dir, -0.85);
      cam.up.set(0, 1, 0);
      cam.lookAt(V2.copy(pos).addScaledVector(k.dir, 0.9).lerp(k.to, 0.8));
      this.fx.shootTracer(k.from, V2.copy(pos).addScaledVector(k.dir, -0.3), 0.3);
      k.ringT -= dt;
      if (k.ringT <= 0) { k.ringT = 0.07; this.fx.ringAt(pos.clone().addScaledVector(k.dir, 0.15), k.dir, 0.05); }
      this.fx.update(0, dt);
      this.gun.update(dt, this);
      if (u >= 1) {
        this.bullet.visible = false;
        this.applyShot(k.shot, true);
        k.phase = 'impact'; k.t = 0;
        k.camOff = k.side.clone().multiplyScalar(3.4 * k.spin).addScaledVector(UP, 0.9).addScaledVector(k.dir, -3.2);
        k.look = k.to.clone();
        this.shake = 0;
      }
    } else {
      this.updateWorld(dt * 0.16, dt);
      const u = k.t / 1.8;
      const off = k.camOff.clone().applyAxisAngle(UP, u * 0.5 * k.spin);
      cam.position.copy(k.look).add(off);
      cam.lookAt(k.look);
      if (k.t >= 1.8) this.endKillcam();
    }
  }

  endKillcam() {
    this.kc = null;
    this.state = 'playing';
    this.bullet.visible = false;
    this.ui.killcam(false);
    this.camera.fov = this.fov;
    this.camera.updateProjectionMatrix();
  }

  // ------------------------------------------------------------ flow
  checkEnd(dt) {
    if (this.ending) {
      this.ending.t -= dt;
      if (this.ending.t <= 0) this.finish(this.ending.win, this.ending.reason);
      return;
    }
    if (this.wallHp <= 0) {
      this.ui.banner('WALL BREACHED', 'The outpost has fallen');
      this.audio.lose();
      this.ending = { win: false, t: 2.4, reason: 'The infected broke through the wall.' };
      return;
    }
    if (this.mode === 'survival') return;
    const L = this.level;
    if (L.type === 'defend') {
      if (!this.queue.length && this.aliveCount() === 0) this.ending = { win: true, t: 1.4 };
    } else if (L.type === 'boss') {
      if (this.bossDead) this.ending = { win: true, t: 2.0 };
    } else if (L.type === 'rescue') {
      if (this.stats.lost > L.survivors - L.required) {
        this.ui.banner('MISSION FAILED', 'Too many survivors were lost');
        this.audio.lose();
        this.ending = { win: false, t: 2.4, reason: 'Too many survivors were lost.' };
      } else if (this.stats.saved + this.stats.lost >= L.survivors) this.ending = { win: true, t: 1.4 };
    }
    if (this.ending?.win) { this.ui.banner('MISSION COMPLETE', ''); this.audio.win(); }
  }

  finish(win, reason) {
    this.ending = null;
    this.state = 'over';
    this.scoped = false; this.scopeShown = false; this.ui.setScoped(false);
    if (this.focusT > 0) { this.focusT = 0; this.audio.setFocus(false); this.ui.focus(false); }
    const st = this.stats;
    let stars = 0, bonus = 0, first = false;
    const L = this.level;
    if (this.mode === 'campaign' && win) {
      if (L.type === 'rescue') stars = clamp(3 - st.lost, 1, 3);
      else { const f = this.wallHp / this.wallMax; stars = f >= 0.75 ? 3 : f >= 0.4 ? 2 : 1; }
      first = !(save.stars[L.i] > 0);
      bonus = Math.round(L.reward * (0.6 + 0.2 * (stars - 1)) * (first ? 1 : 0.5) / 10) * 10;
      save.stars[L.i] = Math.max(save.stars[L.i] || 0, stars);
      if (save.unlocked < L.i + 1 && L.i + 1 < LEVELS.length) save.unlocked = L.i + 1;
    }
    let best = false;
    if (this.mode === 'survival') {
      const id = MAPS[L.map].id;
      const reached = this.wave - 1;
      if (reached > (save.best[id] || 0)) { save.best[id] = reached; best = true; }
    }
    const total = st.earned + bonus;
    save.cash += total;
    save.stats.kills += st.kills; save.stats.heads += st.heads; save.stats.shots += st.shots; save.stats.hits += st.hits;
    persist();
    this.ui.showResult({ win, mode: this.mode, level: L, stats: st, stars, bonus, total, reason, first, wave: this.wave, best });
  }

  quitToMenu() {
    this.state = 'menu';
    this.mode = null;
    this.level = null;
    this.scoped = false; this.scopeShown = false;
    this.ui.setScoped(false);
    if (this.focusT > 0) { this.focusT = 0; this.audio.setFocus(false); this.ui.focus(false); }
    if (this.kc) this.endKillcam();
    this.state = 'menu';
    this.clearActors();
    this.rebuildHittables();
    this.world.barricade.setHealth(1);
    this.fov = BASE_FOV; this.camera.fov = BASE_FOV; this.camera.updateProjectionMatrix();
    this.equip(save.equipped);
  }

  // ------------------------------------------------------------ per frame
  update(dt) {
    this.time += dt;
    if (this.state === 'paused') return;
    if (this.state === 'killcam') { this.updateKillcam(dt); return; }
    let ws = 1;
    if (this.state === 'playing' && this.focusT > 0) {
      ws = 0.35;
      this.focusT -= dt;
      if (this.focusT <= 0) { this.audio.setFocus(false); this.ui.focus(false); }
    }
    if (this.state === 'playing' || this.state === 'over') this.updatePlayer(dt);
    else this.updateMenu(dt);
    this.updateWorld(dt * ws, dt);
    if (this.state === 'playing') {
      this.updateSpawner(dt * ws);
      this.checkEnd(dt);
      this.trackPerf(dt);
    }
  }

  updateWorld(wdt, dt) {
    for (const z of this.zombies) z.update(wdt);
    for (const s of this.survivors) s.update(wdt);
    let removed = false;
    for (let i = this.zombies.length - 1; i >= 0; i--) {
      if (this.zombies[i].removeMe) { const r = this.zombies[i].root; this.actors.remove(r); disposeOwned(r); this.zombies.splice(i, 1); removed = true; }
    }
    for (let i = this.survivors.length - 1; i >= 0; i--) {
      if (this.survivors[i].removeMe) { const r = this.survivors[i].root; this.actors.remove(r); disposeOwned(r); this.survivors.splice(i, 1); removed = true; }
    }
    if (removed) this.rebuildHittables();
    this.fx.update(wdt, dt);
    this.world.update(wdt, this.time);
    for (let i = this.timers.length - 1; i >= 0; i--) {
      const t = this.timers[i];
      t.t -= t.real ? dt : wdt;
      if (t.t <= 0) { this.timers.splice(i, 1); t.fn(); }
    }
    this.gun.update(dt, this);
  }

  updatePlayer(dt) {
    const r = this.rifle;
    if (this.chamber > 0) this.chamber = Math.max(0, this.chamber - dt);
    if (this.reloading > 0) {
      this.reloading -= dt;
      if (this.reloading <= 0) { this.reloading = 0; this.ammo = r.mag; }
    }
    if (this.scoped && !this.scopeShown && this.gun.adsK > 0.8) { this.scopeShown = true; this.ui.setScoped(true); }
    const targetFov = this.scopeShown ? BASE_FOV / this.zoomLevel() : BASE_FOV;
    this.fov += (targetFov - this.fov) * (1 - Math.exp(-dt * 18));
    if (Math.abs(this.camera.fov - this.fov) > 0.0005) { this.camera.fov = this.fov; this.camera.updateProjectionMatrix(); }
    this.recoil *= Math.exp(-dt * 7);
    this.recoilYaw *= Math.exp(-dt * 7);
    this.shake *= Math.exp(-dt * 9);
    const sw = this.scopeShown ? r.sway * 0.0026 : 0.0005;
    const t = this.time;
    const sx = (Math.sin(t * 0.9) * 0.7 + Math.sin(t * 2.1 + 1.3) * 0.3) * sw;
    const sy = (Math.sin(t * 1.3 + 2) * 0.6 + Math.sin(t * 2.9) * 0.3) * sw;
    const zoomDamp = this.fov / BASE_FOV;
    const shx = (Math.random() - 0.5) * this.shake * 0.02 * zoomDamp, shy = (Math.random() - 0.5) * this.shake * 0.02 * zoomDamp;
    this.camera.position.set(EYE.x, EYE.y, EYE.z);
    this.camera.rotation.set(this.pitch + this.recoil + sy + shy, this.yaw + this.recoilYaw + sx + shx, 0);
  }

  updateMenu(dt) {
    this.menuT += dt;
    if (this.camera.fov !== BASE_FOV) { this.camera.fov = BASE_FOV; this.camera.updateProjectionMatrix(); }
    this.camera.position.set(EYE.x, EYE.y, EYE.z);
    const yaw = Math.sin(this.menuT * 0.06) * 0.75;
    const pitch = -0.1 + Math.sin(this.menuT * 0.045) * 0.04;
    this.camera.rotation.set(pitch, yaw, 0);
    this.yaw = yaw;
    // ambient infected walking toward the wall in the background
    if (this.aliveCount() < 7 && Math.random() < dt * 0.8) {
      const types = ['walker', 'walker', 'walker', 'runner', 'brute', 'soldier'];
      this.hpMult = 1; this.speedMult = 1;
      this.spawnZombie(pick(types), { ambient: true });
    }
    for (const z of this.zombies) if (z.alive && z.state === 'attack' && Math.random() < dt * 0.02) { z.alive = false; z.removeMe = true; }
  }

  trackPerf(dt) {
    if (save.settings.quality !== 'auto') return;
    const p = this.perf;
    p.t += dt; p.n++;
    if (p.t > 3) {
      const avg = p.t / p.n;
      if (avg > 0.027 && this.pr > 1) {
        this.pr = Math.max(1, this.pr - 0.25);
        this.renderer.setPixelRatio(this.pr);
        this.resize();
      }
      p.t = 0; p.n = 0;
    }
  }

  // Range to whatever is under the reticle (for the scope readout).
  rangeAtCenter() {
    this.ray.setFromCamera({ x: 0, y: 0 }, this.camera);
    this.ray.far = 600;
    const meshes = [];
    for (const z of this.zombies) if (z.alive) meshes.push(z.m.head, z.m.torsoMesh);
    const hit = this.ray.intersectObjects(meshes, false)[0];
    if (hit) return hit.distance;
    const d = this.ray.ray.direction;
    if (d.y < -0.001) return Math.min(999, (EYE.y) / -d.y);
    return null;
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}

export { RIFLES };
