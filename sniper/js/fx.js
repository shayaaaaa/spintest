// Particles, debris, decals, tracers and explosions. Instanced meshes keep this to a handful of draw calls.
import * as THREE from './three.module.min.js';
import { BOX, disposeOwned } from './models.js';

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _e = new THREE.Euler();
const _v = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

class Pool {
  constructor(scene, geometry, material, max) {
    this.mesh = new THREE.InstancedMesh(geometry, material, max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    const c = new THREE.Color(1, 1, 1);
    for (let i = 0; i < max; i++) this.mesh.setColorAt(i, c);
    scene.add(this.mesh);
    this.max = max;
    this.items = [];
  }
  spawn(o) {
    if (this.items.length >= this.max) this.items.shift();
    this.items.push(o);
    return o;
  }
}

export class FX {
  constructor(scene) {
    this.scene = scene;
    this.bits = new Pool(scene, BOX, new THREE.MeshBasicMaterial({ color: 0xffffff }), 500);
    this.puffs = new Pool(scene, new THREE.IcosahedronGeometry(1, 0), new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, depthWrite: false }), 120);
    const decalGeo = new THREE.CircleGeometry(1, 9); decalGeo.rotateX(-Math.PI / 2);
    this.decals = new THREE.InstancedMesh(decalGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6 }), 80);
    this.decals.count = 0; this.decals.frustumCulled = false; this.decals.renderOrder = 3;
    const dc = new THREE.Color(1, 1, 1);
    for (let i = 0; i < 80; i++) this.decals.setColorAt(i, dc);
    scene.add(this.decals);
    this.decalIdx = 0;
    this.debris = [];
    this.fireballs = [];
    const fbGeo = new THREE.IcosahedronGeometry(1, 1);
    for (let i = 0; i < 6; i++) {
      const m = new THREE.Mesh(fbGeo, new THREE.MeshBasicMaterial({ color: 0xffa040, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
      m.visible = false; scene.add(m);
      this.fireballs.push({ mesh: m, t: 0, life: 0 });
    }
    this.rings = [];
    const ringGeo = new THREE.RingGeometry(0.7, 1, 16);
    for (let i = 0; i < 24; i++) {
      const m = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }));
      m.visible = false; scene.add(m);
      this.rings.push({ mesh: m, t: 0, life: 0 });
    }
    this.ringIdx = 0;
    this.tracer = new THREE.Mesh(BOX, new THREE.MeshBasicMaterial({ color: 0xffe9a0, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.tracer.visible = false;
    scene.add(this.tracer);
    this.tracerT = 0;
    this.lights = [];
  }

  clear() {
    this.bits.items.length = 0;
    this.puffs.items.length = 0;
    this.decals.count = 0;
    for (const d of this.debris) { d.obj.parent?.remove(d.obj); disposeOwned(d.obj); }
    this.debris.length = 0;
    for (const f of this.fireballs) { f.mesh.visible = false; f.life = 0; }
    for (const r of this.rings) { r.mesh.visible = false; r.life = 0; }
    this.tracer.visible = false;
  }

  _bit(p, v, color, size, life, opts = {}) {
    this.bits.spawn({ p: p.clone(), v, c: new THREE.Color(color), size, life, max: life,
      grav: opts.grav ?? 14, drag: opts.drag ?? 0.6, decal: opts.decal || 0, rot: Math.random() * 6, spin: (Math.random() - 0.5) * 12, stick: false });
  }

  blood(point, dir, amount = 14, spread = 1) {
    for (let i = 0; i < amount; i++) {
      const v = new THREE.Vector3(
        dir.x * (2 + Math.random() * 3) + (Math.random() - 0.5) * 4 * spread,
        1.5 + Math.random() * 3.5 * spread,
        dir.z * (2 + Math.random() * 3) + (Math.random() - 0.5) * 4 * spread);
      const col = Math.random() < 0.5 ? 0x8a0d0d : 0xb01818;
      this._bit(point, v, col, 0.05 + Math.random() * 0.08, 0.6 + Math.random() * 0.7, { decal: Math.random() < 0.25 ? 1 : 0 });
    }
    this.puff(point, 0x7a1010, 0.25, 0.45, 2);
  }

  fountain(point, up = UP, amount = 4) {
    for (let i = 0; i < amount; i++) {
      const v = new THREE.Vector3((Math.random() - 0.5) * 1.6 + up.x * 3, 3 + Math.random() * 2.5, (Math.random() - 0.5) * 1.6 + up.z * 3);
      this._bit(point, v, Math.random() < 0.5 ? 0x8a0d0d : 0xa81414, 0.05 + Math.random() * 0.06, 0.7 + Math.random() * 0.4, { decal: Math.random() < 0.08 ? 1 : 0 });
    }
  }

  impact(point, normal, surface = 'dirt') {
    const n = normal || UP;
    const col = surface === 'wood' ? 0x8f6a42 : surface === 'metal' ? 0x9aa0a6 : 0x7a6a4a;
    for (let i = 0; i < 10; i++) {
      const v = new THREE.Vector3(n.x * 3 + (Math.random() - 0.5) * 3, n.y * 3 + Math.random() * 3, n.z * 3 + (Math.random() - 0.5) * 3);
      this._bit(point, v, col, 0.05 + Math.random() * 0.07, 0.5 + Math.random() * 0.4);
    }
    if (surface === 'metal') this.sparks(point, n, 8);
    this.puff(point, surface === 'dirt' ? 0xb8a684 : 0xb0aca4, 0.35, 0.8, 3);
  }

  sparks(point, n = UP, amount = 10) {
    for (let i = 0; i < amount; i++) {
      const v = new THREE.Vector3(n.x * 4 + (Math.random() - 0.5) * 6, n.y * 4 + Math.random() * 4, n.z * 4 + (Math.random() - 0.5) * 6);
      this._bit(point, v, 0xffd25a, 0.03 + Math.random() * 0.03, 0.25 + Math.random() * 0.25, { grav: 9 });
    }
  }

  splinters(point, amount = 8) {
    for (let i = 0; i < amount; i++) {
      const v = new THREE.Vector3((Math.random() - 0.5) * 4, 1 + Math.random() * 3, 1 + Math.random() * 3);
      this._bit(point, v, Math.random() < 0.5 ? 0x8f6a42 : 0x6a4e30, 0.06 + Math.random() * 0.08, 0.6 + Math.random() * 0.4);
    }
  }

  puff(point, color, size, life, n = 1, rise = 0.6) {
    for (let i = 0; i < n; i++) {
      const p = point.clone().add(new THREE.Vector3((Math.random() - 0.5) * size, (Math.random() - 0.5) * size * 0.5, (Math.random() - 0.5) * size));
      this.puffs.spawn({ p, v: new THREE.Vector3((Math.random() - 0.5) * 0.6, rise + Math.random() * 0.4, (Math.random() - 0.5) * 0.6),
        c: new THREE.Color(color), size: size * (0.7 + Math.random() * 0.6), grow: 1.8, life, max: life });
    }
  }

  explosion(point, scale = 1) {
    const f = this.fireballs.find(x => x.life <= 0) || this.fireballs[0];
    f.mesh.position.copy(point).add(new THREE.Vector3(0, 0.6, 0));
    f.t = 0; f.life = 0.55; f.scale = 3.2 * scale; f.mesh.visible = true;
    for (let i = 0; i < 26; i++) {
      const v = new THREE.Vector3((Math.random() - 0.5) * 14, 3 + Math.random() * 9, (Math.random() - 0.5) * 14).multiplyScalar(scale);
      this._bit(point.clone().add(new THREE.Vector3(0, 0.5, 0)), v, Math.random() < 0.5 ? 0x2a2018 : 0x5a4a38, 0.08 + Math.random() * 0.14, 0.9 + Math.random() * 0.7);
    }
    this.sparks(point.clone().add(new THREE.Vector3(0, 0.5, 0)), UP, 16);
    this.puff(point.clone().add(new THREE.Vector3(0, 1, 0)), 0x3a3632, 2.2 * scale, 2.2, 7, 1.6);
    this.puff(point.clone().add(new THREE.Vector3(0, 0.6, 0)), 0xff8a3a, 1.4 * scale, 0.5, 4, 1.0);
    this.decal(point, 2.4 * scale, 0x1c1a18);
  }

  decal(point, size, color) {
    const i = this.decalIdx % 80;
    this.decalIdx++;
    _e.set(0, Math.random() * 6, 0); _q.setFromEuler(_e);
    _s.set(size * (0.7 + Math.random() * 0.6), 1, size * (0.7 + Math.random() * 0.6));
    _m.compose(_v.set(point.x, 0.04 + (i % 7) * 0.002, point.z), _q, _s);
    this.decals.setMatrixAt(i, _m);
    this.decals.setColorAt(i, new THREE.Color(color));
    this.decals.count = Math.min(80, Math.max(this.decals.count, i + 1));
    this.decals.instanceMatrix.needsUpdate = true;
    this.decals.instanceColor.needsUpdate = true;
  }

  // Detaches a mesh (e.g. a head) from its parent and throws it.
  throwPart(mesh, vel, spin = 8, life = 6, half = null) {
    const wp = new THREE.Vector3(), wq = new THREE.Quaternion(), ws = new THREE.Vector3();
    mesh.updateWorldMatrix(true, false);
    mesh.matrixWorld.decompose(wp, wq, ws);
    mesh.parent?.remove(mesh);
    mesh.position.copy(wp); mesh.quaternion.copy(wq); mesh.scale.copy(ws);
    this.scene.add(mesh);
    if (half === null) half = Math.min(ws.x, ws.y, ws.z) * 0.5;
    this.debris.push({ obj: mesh, v: vel.clone(), av: new THREE.Vector3((Math.random() - 0.5) * spin, (Math.random() - 0.5) * spin, (Math.random() - 0.5) * spin),
      life, max: life, half, bleed: mesh.userData.bleed || 0, ws: ws.clone() });
  }

  ringAt(pos, dir, size = 0.25) {
    const r = this.rings[this.ringIdx++ % this.rings.length];
    r.mesh.position.copy(pos);
    r.mesh.lookAt(_v.copy(pos).add(dir));
    r.t = 0; r.life = 0.5; r.size = size; r.mesh.visible = true;
  }

  shootTracer(from, to, opacity = 0.7) {
    const len = from.distanceTo(to);
    if (len < 2) return;
    const mid = from.clone().add(to).multiplyScalar(0.5);
    this.tracer.position.copy(mid);
    this.tracer.lookAt(to);
    this.tracer.scale.set(0.03, 0.03, len);
    this.tracer.material.opacity = opacity;
    this.tracerOp = opacity;
    this.tracer.visible = true;
    this.tracerT = 0.09;
  }

  update(dt, realDt) {
    // bits
    const B = this.bits, bm = B.mesh;
    let n = 0;
    for (let i = B.items.length - 1; i >= 0; i--) {
      const b = B.items[i];
      b.life -= dt;
      if (b.life <= 0) { B.items.splice(i, 1); continue; }
      if (!b.stick) {
        b.v.y -= b.grav * dt;
        b.v.multiplyScalar(Math.max(0, 1 - b.drag * dt));
        b.p.addScaledVector(b.v, dt);
        b.rot += b.spin * dt;
        if (b.p.y < 0.03) {
          b.p.y = 0.03; b.stick = true;
          if (b.decal) this.decal(b.p, 0.25 + Math.random() * 0.35, 0x5a0808);
        }
      }
    }
    for (let i = 0; i < B.items.length; i++) {
      const b = B.items[i];
      const s = b.size * Math.min(1, b.life / (b.max * 0.4));
      _e.set(b.rot, b.rot * 0.7, 0); _q.setFromEuler(_e);
      _s.set(s, b.stick ? s * 0.3 : s, s);
      _m.compose(b.p, _q, _s);
      bm.setMatrixAt(n, _m);
      bm.setColorAt(n, b.c);
      n++;
    }
    bm.count = n;
    bm.instanceMatrix.needsUpdate = true;
    if (bm.instanceColor) bm.instanceColor.needsUpdate = true;

    // puffs
    const P = this.puffs, pm = P.mesh;
    n = 0;
    for (let i = P.items.length - 1; i >= 0; i--) {
      const p = P.items[i];
      p.life -= dt;
      if (p.life <= 0) { P.items.splice(i, 1); continue; }
      p.p.addScaledVector(p.v, dt);
    }
    for (let i = 0; i < P.items.length; i++) {
      const p = P.items[i];
      const k = 1 - p.life / p.max;
      const s = p.size * (1 + k * p.grow) * (k > 0.7 ? (1 - k) / 0.3 : 1);
      _q.identity(); _s.set(s, s, s);
      _m.compose(p.p, _q, _s);
      pm.setMatrixAt(n, _m);
      pm.setColorAt(n, p.c);
      n++;
    }
    pm.count = n;
    pm.instanceMatrix.needsUpdate = true;
    if (pm.instanceColor) pm.instanceColor.needsUpdate = true;

    // debris (heads, helmets, limbs)
    for (let i = this.debris.length - 1; i >= 0; i--) {
      const d = this.debris[i];
      d.life -= dt;
      const o = d.obj;
      if (d.life <= 0) { o.parent?.remove(o); disposeOwned(o); this.debris.splice(i, 1); continue; }
      d.v.y -= 14 * dt;
      o.position.addScaledVector(d.v, dt);
      o.rotation.x += d.av.x * dt; o.rotation.y += d.av.y * dt; o.rotation.z += d.av.z * dt;
      if (o.position.y < d.half) {
        o.position.y = d.half;
        d.v.y = Math.abs(d.v.y) * 0.3;
        d.v.x *= 0.6; d.v.z *= 0.6; d.av.multiplyScalar(0.6);
        if (Math.abs(d.v.y) < 0.5) { d.v.y = 0; d.av.multiplyScalar(0.8); }
      }
      if (d.bleed > 0) { d.bleed -= dt; if (Math.random() < 0.6) this._bit(o.position, new THREE.Vector3((Math.random() - 0.5), 0.5, (Math.random() - 0.5)), 0x8a0d0d, 0.05, 0.5); }
      if (d.life < 1) o.scale.copy(d.ws).multiplyScalar(Math.max(0.01, d.life));
    }

    // fireballs
    for (const f of this.fireballs) {
      if (f.life <= 0) continue;
      f.t += dt;
      const k = f.t / f.life;
      if (k >= 1) { f.life = 0; f.mesh.visible = false; continue; }
      f.mesh.scale.setScalar(f.scale * (0.3 + Math.sqrt(k) * 0.9));
      f.mesh.material.opacity = 1 - k;
      f.mesh.material.color.setHSL(0.08 - k * 0.06, 1, 0.6 - k * 0.25);
    }
    // rings
    for (const r of this.rings) {
      if (r.life <= 0) continue;
      r.t += realDt;
      const k = r.t / r.life;
      if (k >= 1) { r.life = 0; r.mesh.visible = false; continue; }
      r.mesh.scale.setScalar(r.size * (1 + k * 2.5));
      r.mesh.material.opacity = 0.16 * (1 - k);
    }
    // tracer
    if (this.tracer.visible) {
      this.tracerT -= realDt;
      this.tracer.material.opacity = Math.max(0, this.tracerT / 0.09) * this.tracerOp;
      if (this.tracerT <= 0) this.tracer.visible = false;
    }
  }
}
