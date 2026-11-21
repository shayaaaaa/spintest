// Procedural low-poly maps. Static scenery is merged into a few meshes to keep draw calls low on phones.
import * as THREE from './three.module.min.js';
import { WALL_Z, WALL_HALF } from './data.js';
import { BOX } from './models.js';

export function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(x, z) {
  const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
export function noise2(x, z) {
  const xi = Math.floor(x), zi = Math.floor(z);
  const xf = x - xi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = zf * zf * (3 - 2 * zf);
  const a = hash(xi, zi), b = hash(xi + 1, zi), c = hash(xi, zi + 1), d = hash(xi + 1, zi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

let flatSea = false;
export function groundHeight(x, z) {
  if (flatSea && z < -192) return -1;
  const d = Math.hypot(x * 0.8, z + 70);
  const t = smooth(150, 300, d);
  if (t <= 0) return 0;
  return t * (6 + 22 * noise2(x * 0.012, z * 0.012) + 6 * noise2(x * 0.04, z * 0.04));
}

// ---------- geometry merging ----------
const baseGeos = {
  box: new THREE.BoxGeometry(1, 1, 1),
  cyl6: new THREE.CylinderGeometry(1, 1, 1, 6),
  cyl8: new THREE.CylinderGeometry(1, 1, 1, 8),
  cyl12: new THREE.CylinderGeometry(1, 1, 1, 12),
  cone4: new THREE.ConeGeometry(1, 1, 4),
  cone6: new THREE.ConeGeometry(1, 1, 6),
  cone7: new THREE.ConeGeometry(1, 1, 7),
  ico: new THREE.IcosahedronGeometry(1, 0),
  dome: new THREE.SphereGeometry(1, 10, 5, 0, Math.PI * 2, 0, Math.PI / 2),
  // triangular prism with its ridge along z, apex at +1, base at -0.5
  prism: (() => { const g = new THREE.CylinderGeometry(1, 1, 1, 3); g.rotateX(-Math.PI / 2); return g; })(),
  plane: (() => { const g = new THREE.PlaneGeometry(1, 1); g.rotateX(-Math.PI / 2); return g; })(),
  disc: (() => { const g = new THREE.CircleGeometry(1, 16); g.rotateX(-Math.PI / 2); return g; })(),
};
const nonIndexed = {};
function geo(key) {
  if (!nonIndexed[key]) { const g = baseGeos[key]; nonIndexed[key] = g.index ? g.toNonIndexed() : g; }
  return nonIndexed[key];
}

class GeoBuilder {
  constructor(ao = true) { this.pos = []; this.nor = []; this.col = []; this.ao = ao; }
  add(key, x, y, z, sx, sy, sz, color, ry = 0, rx = 0, rz = 0, jitter = 0.06) {
    const g = geo(key);
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(x, y, z),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ')),
      new THREE.Vector3(sx, sy, sz));
    const nm = new THREE.Matrix3().getNormalMatrix(m);
    const c = new THREE.Color(color);
    const j = 1 + (Math.random() * 2 - 1) * jitter;
    const p = g.attributes.position, n = g.attributes.normal;
    const v = new THREE.Vector3(), nv = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(m);
      nv.fromBufferAttribute(n, i).applyMatrix3(nm).normalize();
      this.pos.push(v.x, v.y, v.z);
      this.nor.push(nv.x, nv.y, nv.z);
      const ao = this.ao ? 0.7 + 0.3 * Math.min(1, Math.max(0, v.y) / 3) : 1;
      this.col.push(c.r * j * ao, c.g * j * ao, c.b * j * ao);
    }
  }
  // box with its bottom resting at y0
  boxB(x, y0, z, sx, sy, sz, color, ry = 0, jitter) { this.add('box', x, y0 + sy / 2, z, sx, sy, sz, color, ry, 0, 0, jitter); }
  build(material) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return new THREE.Mesh(g, material);
  }
  get empty() { return this.pos.length === 0; }
}

// ---------- reusable props ----------
function pine(gb, x, z, s, rng, dark = 0x2f5a32) {
  const y = groundHeight(x, z);
  gb.add('cyl6', x, y + 0.9 * s, z, 0.22 * s, 1.8 * s, 0.22 * s, 0x5a3e28);
  const c = [dark, 0x3a6a3a, 0x335f36][Math.floor(rng() * 3)];
  gb.add('cone7', x, y + 2.6 * s, z, 1.7 * s, 2.6 * s, 1.7 * s, c, rng() * 6);
  gb.add('cone7', x, y + 3.9 * s, z, 1.3 * s, 2.2 * s, 1.3 * s, c, rng() * 6);
  gb.add('cone7', x, y + 5.0 * s, z, 0.85 * s, 1.8 * s, 0.85 * s, c, rng() * 6);
}
function roundTree(gb, x, z, s, rng, col) {
  const y = groundHeight(x, z);
  gb.add('cyl6', x, y + 1.2 * s, z, 0.25 * s, 2.4 * s, 0.25 * s, 0x5e4430);
  const c = col ?? [0x4f8a3a, 0x5e9a40, 0x6aa548, 0x4a7f36][Math.floor(rng() * 4)];
  gb.add('ico', x, y + 3.2 * s, z, 1.8 * s, 1.6 * s, 1.8 * s, c, rng() * 6);
  gb.add('ico', x + 0.8 * s, y + 2.7 * s, z + 0.3 * s, 1.1 * s, 1.0 * s, 1.1 * s, c, rng() * 6);
}
function deadTree(gb, x, z, s, rng) {
  const y = groundHeight(x, z);
  gb.add('cyl6', x, y + 1.6 * s, z, 0.2 * s, 3.2 * s, 0.2 * s, 0x4a3a2e);
  for (let i = 0; i < 3; i++) {
    const a = rng() * Math.PI * 2;
    gb.add('cyl6', x + Math.cos(a) * 0.5 * s, y + (2.2 + i * 0.5) * s, z + Math.sin(a) * 0.5 * s, 0.07 * s, 1.4 * s, 0.07 * s, 0x4a3a2e, a, 0.9, 0);
  }
}
function rock(gb, x, z, s, color = 0x8a8a84) {
  gb.add('ico', x, groundHeight(x, z) + 0.3 * s, z, s, 0.6 * s, s * 0.9, color, Math.random() * 6);
}
function car(gb, x, z, ry, color, flipped = false) {
  const cos = Math.cos(ry), sin = Math.sin(ry);
  const off = (lx, lz) => [x + lx * cos + lz * sin, z - lx * sin + lz * cos];
  const [cx, cz] = off(0, -0.2);
  const wheels = [[-1, 1.35], [1, 1.35], [-1, -1.35], [1, -1.35]];
  if (!flipped) {
    gb.boxB(x, 0.35, z, 2.0, 0.75, 4.2, color, ry);
    gb.boxB(cx, 1.1, cz, 1.8, 0.62, 2.2, 0x2a3440, ry);
    gb.boxB(cx, 1.72, cz, 1.86, 0.08, 2.0, color, ry);
    for (const [lx, lz] of wheels) { const [wx, wz] = off(lx, lz); gb.add('cyl8', wx, 0.38, wz, 0.38, 0.28, 0.38, 0x1b1b1b, ry, 0, Math.PI / 2); }
    const [hx, hz] = off(0, 2.11);
    gb.boxB(hx, 0.55, hz, 1.6, 0.18, 0.05, 0x777766, ry);
  } else {
    gb.boxB(cx, 0, cz, 1.8, 0.62, 2.2, 0x22262a, ry);
    gb.boxB(x, 0.62, z, 2.0, 0.75, 4.2, color, ry);
    for (const [lx, lz] of wheels) { const [wx, wz] = off(lx, lz); gb.add('cyl8', wx, 1.6, wz, 0.38, 0.28, 0.38, 0x1b1b1b, ry, 0, Math.PI / 2); }
  }
}
function crate(gb, x, z, s = 1, color = 0x9a7448, ry = 0) {
  gb.boxB(x, 0, z, s, s, s, color, ry);
  gb.boxB(x, s * 0.45, z, s * 1.02, s * 0.1, s * 1.02, 0x6a4e30, ry);
}
function barrel(gb, x, z, color) {
  gb.add('cyl8', x, 0.5, z, 0.32, 1.0, 0.32, color);
  gb.add('cyl8', x, 0.75, z, 0.33, 0.06, 0.33, 0x333333);
}
function house(gb, glow, x, z, w, d, h, color, roof, ry, rng, opts = {}) {
  gb.boxB(x, 0, z, w, h, d, color, ry);
  const cos = Math.cos(ry), sin = Math.sin(ry);
  const off = (lx, lz) => [x + lx * cos + lz * sin, z - lx * sin + lz * cos];
  if (opts.flat) {
    gb.boxB(x, h, z, w + 0.3, 0.3, d + 0.3, roof, ry);
  } else {
    gb.add('prism', x, h + 0.8, z, w * 0.6, 1.6, d + 0.4, roof, ry);
  }
  // windows on the front (+z local) face
  const floors = Math.max(1, Math.floor(h / 3));
  const cols = Math.max(1, Math.floor(w / 2.6));
  for (let f = 0; f < floors; f++) {
    for (let c = 0; c < cols; c++) {
      const lx = -w / 2 + (c + 0.5) * (w / cols);
      const ly = 1.4 + f * 3;
      if (f === 0 && c === Math.floor(cols / 2) && opts.door !== false) {
        const [dx, dz] = off(lx, d / 2 + 0.03);
        gb.boxB(dx, 0, dz, 1.1, 2.1, 0.1, 0x4a3426, ry);
        continue;
      }
      const [wx, wz] = off(lx, d / 2 + 0.03);
      const lit = opts.lit && rng() < 0.3;
      if (lit) glow.boxB(wx, ly - 0.1, wz, 1.0, 1.1, 0.08, 0xffc46a, ry, 0);
      else if (opts.boarded && rng() < 0.6) {
        gb.boxB(wx, ly - 0.1, wz, 1.0, 1.1, 0.06, 0x1d2430, ry);
        gb.add('box', wx, ly + 0.45, wz + 0.02, 1.3, 0.18, 0.08, 0x8a6a48, ry, 0, (rng() - 0.5) * 0.6);
        gb.add('box', wx, ly + 0.1, wz + 0.02, 1.3, 0.18, 0.08, 0x8a6a48, ry, 0, (rng() - 0.5) * 0.6);
      } else gb.boxB(wx, ly - 0.1, wz, 1.0, 1.1, 0.06, 0x1d2430, ry);
    }
  }
}
function fenceLine(gb, x0, z0, x1, z1, color = 0x8a6a48, h = 1.1) {
  const len = Math.hypot(x1 - x0, z1 - z0);
  const n = Math.max(1, Math.round(len / 2.4));
  const ry = Math.atan2(x1 - x0, z1 - z0);
  for (let i = 0; i <= n; i++) {
    const t = i / n, x = x0 + (x1 - x0) * t, z = z0 + (z1 - z0) * t;
    gb.boxB(x, groundHeight(x, z), z, 0.14, h + 0.15, 0.14, 0x6a4e34);
  }
  const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2, y = groundHeight(mx, mz);
  gb.add('box', mx, y + h * 0.4, mz, 0.06, 0.12, len, color, ry);
  gb.add('box', mx, y + h * 0.85, mz, 0.06, 0.12, len, color, ry);
}
function lamp(gb, glow, x, z, h = 6, side = 1) {
  gb.add('cyl6', x, h / 2, z, 0.08, h, 0.08, 0x3a3d40);
  gb.add('box', x + side * 0.6, h, z, 1.3, 0.08, 0.08, 0x3a3d40);
  glow.boxB(x + side * 1.15, h - 0.18, z, 0.4, 0.14, 0.25, 0xfff0b0);
}

// ---------- sky ----------
function makeSky(M) {
  const g = new THREE.SphereGeometry(900, 24, 14);
  const top = new THREE.Color(M.skyTop), hor = new THREE.Color(M.skyHorizon), c = new THREE.Color();
  const p = g.attributes.position;
  const cols = [];
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i) / 900;
    const t = Math.pow(Math.max(0, y), 0.55);
    c.copy(hor).lerp(top, t);
    if (y < 0) c.copy(hor).multiplyScalar(0.85);
    cols.push(c.r, c.g, c.b);
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }));
  m.renderOrder = -10;
  return m;
}

function makeDisc(M) {
  const d = new THREE.Vector3(...M.disc.dir).normalize().multiplyScalar(820);
  const grp = new THREE.Group();
  const core = new THREE.Mesh(new THREE.CircleGeometry(M.disc.size, 24), new THREE.MeshBasicMaterial({ color: M.disc.color, fog: false, depthWrite: false }));
  const halo = new THREE.Mesh(new THREE.CircleGeometry(M.disc.size * 2.6, 24), new THREE.MeshBasicMaterial({ color: M.disc.color, fog: false, transparent: true, opacity: M.night ? 0.12 : 0.22, depthWrite: false }));
  grp.add(halo); grp.add(core);
  core.position.z = 0.5;
  grp.position.copy(d);
  grp.lookAt(0, 0, 0);
  grp.renderOrder = -9;
  core.renderOrder = -8; halo.renderOrder = -9;
  return grp;
}

function makeClouds(M, rng) {
  const gb = new GeoBuilder(false);
  const col = M.night ? 0x1d2840 : M.id === 'town' ? 0xd69a86 : 0xf4f7fa;
  for (let i = 0; i < 22; i++) {
    const a = -Math.PI / 2 + (rng() - 0.5) * 3.4;
    const r = 450 + rng() * 300;
    const x = Math.cos(a) * r, z = Math.sin(a) * r, y = 110 + rng() * 120;
    const n = 3 + Math.floor(rng() * 4);
    for (let k = 0; k < n; k++) {
      gb.add('ico', x + (k - n / 2) * 22 + rng() * 10, y + rng() * 8, z + rng() * 16, 22 + rng() * 18, 9 + rng() * 6, 16 + rng() * 10, col, rng() * 6, 0, 0, 0.04);
    }
  }
  return gb.build(new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, transparent: true, opacity: M.night ? 0.7 : 0.92, depthWrite: false }));
}

function makeMountains(M, rng) {
  const gb = new GeoBuilder(false);
  for (let i = 0; i < 46; i++) {
    const a = (i / 46) * Math.PI * 2 + rng() * 0.1;
    const r = 520 + rng() * 140;
    const h = 50 + rng() * 110;
    const c = new THREE.Color(M.mountains).multiplyScalar(0.85 + rng() * 0.3).getHex();
    gb.add('cone6', Math.cos(a) * r, h / 2 - 10, Math.sin(a) * r, 70 + rng() * 80, h, 70 + rng() * 60, c, rng() * 6, 0, 0, 0.02);
  }
  const m = gb.build(new THREE.MeshBasicMaterial({ vertexColors: true, fog: false }));
  m.renderOrder = -7;
  return m;
}

function makeStars(rng) {
  const pts = [];
  for (let i = 0; i < 700; i++) {
    const u = rng() * Math.PI * 2, v = 0.06 + rng() * 0.9;
    const r = 850;
    pts.push(Math.cos(u) * Math.cos(v * Math.PI / 2) * r, Math.sin(v * Math.PI / 2) * r, Math.sin(u) * Math.cos(v * Math.PI / 2) * r);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const m = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xcfd8ff, size: 2.5, sizeAttenuation: false, fog: false, depthWrite: false }));
  m.renderOrder = -9;
  return m;
}

function makeGround(M, rng) {
  const size = 1100, seg = 110;
  const g = new THREE.PlaneGeometry(size, size, seg, seg);
  g.rotateX(-Math.PI / 2);
  const p = g.attributes.position;
  const c1 = new THREE.Color(M.ground), c2 = new THREE.Color(M.ground2), c = new THREE.Color();
  const cols = [];
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i);
    const h = groundHeight(x, z);
    p.setY(i, h);
    const n = noise2(x * 0.05, z * 0.05) * 0.7 + noise2(x * 0.2, z * 0.2) * 0.3;
    c.copy(c1).lerp(c2, n);
    if (h > 4) c.lerp(new THREE.Color(M.mountains), Math.min(0.5, (h - 4) / 40));
    c.multiplyScalar(0.92 + rng() * 0.12);
    cols.push(c.r, c.g, c.b);
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  g.computeVertexNormals();
  const m = new THREE.Mesh(g.toNonIndexed(), new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
  m.userData.surface = 'dirt';
  return m;
}

// ---------- tower (player position) ----------
function buildTower(gb) {
  const wood = 0x7a5a3a, dark = 0x5a4028;
  for (const [x, z] of [[-1.3, -1.2], [1.3, -1.2], [-1.3, 1.5], [1.3, 1.5]]) gb.boxB(x, 0, z, 0.32, 8.1, 0.32, dark);
  gb.boxB(0, 7.8, 0.15, 3.0, 0.2, 3.1, wood);                       // floor
  for (let i = 0; i < 6; i++) gb.boxB(-1.25 + i * 0.5, 7.98, 0.15, 0.46, 0.03, 3.05, 0x8a6a46);
  gb.boxB(0, 8.1, -1.36, 2.9, 0.08, 0.08, dark);                     // front rail
  gb.boxB(-1.36, 7.98, -1.3, 0.1, 0.42, 0.1, dark);
  gb.boxB(1.36, 7.98, -1.3, 0.1, 0.42, 0.1, dark);
  // side sandbags
  for (const sx of [-1.35, 1.35]) {
    for (let i = 0; i < 4; i++) {
      gb.add('box', sx, 8.06, -0.9 + i * 0.72, 0.42, 0.18, 0.66, 0xa8996e, 0, 0, 0, 0.08);
      gb.add('box', sx, 8.22, -0.55 + i * 0.6, 0.38, 0.16, 0.6, 0xb0a276, 0, 0, 0, 0.08);
    }
  }
  // cross braces
  gb.add('box', 0, 4, -1.2, 0.12, 8.6, 0.12, dark, 0, 0, 0.32);
  gb.add('box', 0, 4, -1.2, 0.12, 8.6, 0.12, dark, 0, 0, -0.32);
  gb.add('box', -1.3, 4, 0.15, 0.12, 8.6, 0.12, dark, 0, 0.36, 0);
  gb.add('box', 1.3, 4, 0.15, 0.12, 8.6, 0.12, dark, 0, -0.36, 0);
  // ammo crate on the floor, left
  gb.boxB(-0.95, 8.0, -0.8, 0.7, 0.35, 0.45, 0x4e5a36, 0.3);
  gb.boxB(-0.95, 8.35, -0.8, 0.72, 0.04, 0.47, 0x3e482a, 0.3);
  // spent casings
  for (let i = 0; i < 6; i++) gb.add('cyl6', 0.2 + Math.random() * 0.8, 8.02, -0.3 + Math.random() * 0.9, 0.02, 0.08, 0.02, 0xc8a040, Math.random() * 3, Math.PI / 2, 0, 0.1);
}

// ---------- barricade ----------
class Barricade {
  constructor(root, gb, M) {
    const n = 34;
    this.n = n;
    const wood = M.id === 'yard' ? 0x8a7a62 : 0x8f6a42;
    this.mesh = new THREE.InstancedMesh(BOX, new THREE.MeshLambertMaterial({ color: 0xffffff }), n);
    this.mesh.userData.surface = 'wood';
    this.base = [];
    const w = (WALL_HALF * 2) / n;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
    const col = new THREE.Color();
    for (let i = 0; i < n; i++) {
      const x = -WALL_HALF + (i + 0.5) * w;
      const h = 1.15 + Math.random() * 0.4;
      e.set(-0.08 + (Math.random() - 0.5) * 0.08, (Math.random() - 0.5) * 0.1, (Math.random() - 0.5) * 0.09);
      q.setFromEuler(e);
      m.compose(new THREE.Vector3(x, h / 2, WALL_Z + (Math.random() - 0.5) * 0.1), q, new THREE.Vector3(w * 0.92, h, 0.14));
      this.base.push(m.clone());
      this.mesh.setMatrixAt(i, m);
      col.setHex(wood).multiplyScalar(0.8 + Math.random() * 0.35);
      this.mesh.setColorAt(i, col);
    }
    root.add(this.mesh);
    this.order = [...Array(n).keys()].sort(() => Math.random() - 0.5);
    this.visible = n;
    // static frame: posts, rails, sandbags, spikes
    for (let x = -WALL_HALF; x <= WALL_HALF + 0.01; x += 4.4) gb.boxB(x, 0, WALL_Z + 0.12, 0.22, 1.5, 0.22, 0x5a4028);
    gb.add('box', 0, 0.45, WALL_Z + 0.14, WALL_HALF * 2, 0.12, 0.1, 0x5e4430);
    gb.add('box', 0, 0.95, WALL_Z + 0.14, WALL_HALF * 2, 0.12, 0.1, 0x5e4430);
    for (let x = -WALL_HALF + 0.4; x < WALL_HALF; x += 0.75) {
      gb.add('box', x, 0.14, WALL_Z + 0.55, 0.72, 0.28, 0.5, 0xa8996e, (Math.random() - 0.5) * 0.2, 0, 0, 0.1);
    }
    for (let x = -WALL_HALF + 1; x < WALL_HALF; x += 2.2) {
      gb.add('cyl6', x, 0.55, WALL_Z - 0.9, 0.06, 1.6, 0.06, 0x6a5038, 0, -0.75, 0, 0.1);
    }
    // wall ends
    gb.boxB(-WALL_HALF - 0.6, 0, WALL_Z, 1.2, 2.2, 1.2, 0x7a7a72);
    gb.boxB(WALL_HALF + 0.6, 0, WALL_Z, 1.2, 2.2, 1.2, 0x7a7a72);
  }
  setHealth(frac) {
    const want = frac <= 0 ? 0 : Math.max(1, Math.ceil(this.n * Math.pow(frac, 0.85)));
    if (want === this.visible) return;
    this.visible = want;
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let k = 0; k < this.n; k++) {
      const i = this.order[k];
      this.mesh.setMatrixAt(i, k < want ? this.base[i] : zero);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.computeBoundingSphere();
  }
}

// ---------- maps ----------
function inField(x, z) { return Math.abs(x) < 42 && z < -10 && z > -128; }

function buildFarm(ctx) {
  const { gb, deco, glow, obstacles, rng, extra } = ctx;
  // dirt road leading to the outpost
  for (let z = -16; z > -420; z -= 8) {
    const x = Math.sin(z * 0.012) * 6;
    deco.add('plane', x, 0.02, z - 4, 6.5, 1, 8.6, 0x9b7b52, Math.cos(z * 0.012) * 0.07, 0, 0, 0.05);
  }
  // farmhouse (left)
  house(gb, glow, -50, -64, 12, 9, 6, 0xe4dccb, 0x7a3428, Math.PI / 2 - 0.2, rng, { boarded: true });
  gb.boxB(-50, 6, -64, 1, 4, 1, 0x7a5a4a);
  obstacles.push({ x: -50, z: -64, r: 8 });
  // barn (right)
  house(gb, glow, 46, -96, 14, 18, 8, 0xa8322b, 0x4d3a30, -Math.PI / 2 + 0.15, rng, { door: false });
  {
    const ry = -Math.PI / 2 + 0.15, cos = Math.cos(ry), sin = Math.sin(ry);
    gb.boxB(46 + 9.05 * sin, 0, -96 + 9.05 * cos, 6.4, 5.2, 0.1, 0xf0e8dc, ry);
    gb.boxB(46 + 9.12 * sin, 0, -96 + 9.12 * cos, 5.6, 4.7, 0.1, 0x7a2420, ry);
  }
  obstacles.push({ x: 46, z: -96, r: 11 });
  // silo
  gb.add('cyl12', 62, 8, -114, 3.2, 16, 3.2, 0xb8bcc0);
  gb.add('dome', 62, 16, -114, 3.3, 2.6, 3.3, 0x9aa0a6);
  obstacles.push({ x: 62, z: -114, r: 4 });
  // windmill
  const wx = -78, wz = -138;
  gb.add('cone4', wx, 8, wz, 2.2, 16, 2.2, 0x8a8a8a, Math.PI / 4);
  gb.boxB(wx, 15.5, wz, 1.4, 1.2, 1.6, 0x7a5a3a);
  const blades = new THREE.Group();
  const bgb = new GeoBuilder(false);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    bgb.add('box', -Math.sin(a) * 3.4, Math.cos(a) * 3.4, 0, 0.9, 6.2, 0.06, 0xdedad0, 0, 0, a, 0);
  }
  bgb.add('box', 0, 0, -0.1, 0.6, 0.6, 0.4, 0x5a5a5a, 0, 0, 0, 0);
  const bm = bgb.build(new THREE.MeshLambertMaterial({ vertexColors: true }));
  blades.add(bm);
  blades.position.set(wx, 16.1, wz + 1.0);
  extra.push({ obj: blades, update: (dt) => { blades.rotation.z += dt * 0.6; } });
  ctx.root.add(blades);
  // hay bales in the field
  for (const [x, z] of [[-14, -38], [-11, -40], [16, -58], [22, -82], [-24, -88], [5, -104], [-30, -52]]) {
    gb.add('cyl8', x, 0.75, z, 0.75, 1.4, 0.75, 0xd8b85a, rng() * 3, 0, Math.PI / 2);
    obstacles.push({ x, z, r: 1.2 });
  }
  // tractor
  {
    const x = 18, z = -44;
    gb.boxB(x, 0.8, z, 1.6, 1.2, 3.0, 0x3f8a3a, 0.5);
    gb.boxB(x - 0.3, 2.0, z + 0.5, 1.4, 1.3, 1.4, 0x2a4a2a, 0.5);
    gb.add('cyl12', x - 0.8, 0.9, z + 1.4, 0.9, 0.45, 0.9, 0x1c1c1c, 0.5, 0, Math.PI / 2);
    gb.add('cyl12', x + 0.8, 0.9, z + 1.0, 0.9, 0.45, 0.9, 0x1c1c1c, 0.5, 0, Math.PI / 2);
    gb.add('cyl12', x - 0.4, 0.5, z - 1.0, 0.5, 0.35, 0.5, 0x1c1c1c, 0.5, 0, Math.PI / 2);
    gb.add('cyl12', x + 1.0, 0.5, z - 1.4, 0.5, 0.35, 0.5, 0x1c1c1c, 0.5, 0, Math.PI / 2);
    obstacles.push({ x, z, r: 2.6 });
  }
  // fences
  fenceLine(gb, -62, -20, -62, -150);
  fenceLine(gb, 66, -20, 66, -80);
  fenceLine(gb, -62, -150, -20, -150);
  fenceLine(gb, -40, -30, -62, -30);
  // corn field (outside the corridor on the right)
  for (let x = 72; x < 110; x += 2.2) {
    for (let z = -20; z > -110; z -= 1.6) {
      deco.add('cone4', x + (rng() - 0.5) * 0.5, 1.0, z + (rng() - 0.5) * 0.4, 0.45, 2.0, 0.45, rng() < 0.5 ? 0xc2b44a : 0x9aa63e, rng() * 3, 0, 0, 0.1);
    }
  }
  // scarecrow
  gb.boxB(72, 0, -40, 0.15, 2.6, 0.15, 0x6a4e34);
  gb.add('box', 72, 2.1, -40, 1.8, 0.12, 0.12, 0x6a4e34);
  gb.boxB(72, 1.4, -40, 0.6, 0.8, 0.35, 0x8a4a3a);
  gb.boxB(72, 2.2, -40, 0.45, 0.45, 0.45, 0xd8c890);
  gb.add('cone6', 72, 2.75, -40, 0.5, 0.4, 0.5, 0x7a6a3a);
  // trees: dense line behind, scattered at sides
  for (let i = 0; i < 260; i++) {
    const a = -Math.PI / 2 + (rng() - 0.5) * 2.9;
    const r = 70 + rng() * 230;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (inField(x, z) || (Math.abs(x) < 70 && z > -150 && z < -10)) continue;
    if (Math.abs(x - Math.sin(z * 0.012) * 6) < 6) continue;
    const s = 0.9 + rng() * 0.8;
    if (rng() < 0.55) pine(gb, x, z, s, rng); else roundTree(gb, x, z, s, rng);
  }
  for (const [x, z] of [[-30, -110], [28, -120], [-36, -26], [34, -30], [-8, -128]]) {
    roundTree(gb, x, z, 1.1, rng);
    obstacles.push({ x, z, r: 1.2 });
  }
  // rocks and grass
  for (let i = 0; i < 26; i++) rock(gb, (rng() - 0.5) * 130, -20 - rng() * 120, 0.4 + rng() * 0.9);
  for (let i = 0; i < 700; i++) {
    const x = (rng() - 0.5) * 160, z = -12 - rng() * 170;
    deco.add('cone4', x, 0.18, z, 0.18, 0.36, 0.18, rng() < 0.5 ? 0x4f7a32 : 0x6a943e, rng() * 3, 0, 0, 0.1);
  }
  // power poles along the road
  const wires = [];
  for (let z = -30; z > -260; z -= 26) {
    const x = Math.sin(z * 0.012) * 6 + 6;
    gb.add('cyl6', x, 4.5, z, 0.14, 9, 0.14, 0x5a4434);
    gb.add('box', x, 8.4, z, 1.8, 0.12, 0.12, 0x5a4434);
    wires.push([x - 0.8, 8.5, z], [x + 0.8, 8.5, z]);
  }
  addWires(ctx, wires, 0x2a2a2a);
}

function addWires(ctx, posts, color) {
  const pts = [];
  for (let i = 0; i + 2 < posts.length; i += 2) {
    for (const k of [0, 1]) {
      const a = posts[i + k], b = posts[i + 2 + k];
      const seg = 6;
      for (let s = 0; s < seg; s++) {
        const t0 = s / seg, t1 = (s + 1) / seg;
        const sag0 = Math.sin(t0 * Math.PI) * 0.8, sag1 = Math.sin(t1 * Math.PI) * 0.8;
        pts.push(a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0 - sag0, a[2] + (b[2] - a[2]) * t0);
        pts.push(a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1 - sag1, a[2] + (b[2] - a[2]) * t1);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  ctx.root.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color })));
}

function buildTown(ctx) {
  const { gb, deco, glow, obstacles, rng } = ctx;
  // asphalt plaza and street
  deco.add('plane', 0, 0.02, -75, 92, 1, 126, 0x4a4642, 0, 0, 0, 0.02);
  deco.add('plane', 0, 0.02, -280, 14, 1, 300, 0x4a4642, 0, 0, 0, 0.02);
  for (let z = -140; z > -420; z -= 9) deco.add('plane', 0, 0.035, z, 0.3, 1, 4, 0xd8c060, 0, 0, 0, 0.02);
  for (let x = -40; x <= 40; x += 5) deco.add('plane', x, 0.035, -40, 0.25, 1, 5, 0xe8e4d8, 0, 0, 0, 0.02);
  for (let i = 0; i < 18; i++) deco.add('disc', (rng() - 0.5) * 80, 0.03, -20 - rng() * 110, 1 + rng() * 2.5, 1, 1 + rng() * 2, 0x3a3734, 0, 0, 0, 0.02);
  // sidewalks
  deco.add('plane', -48, 0.06, -75, 4, 1, 126, 0x8a847a, 0, 0, 0, 0.02);
  deco.add('plane', 48, 0.06, -75, 4, 1, 126, 0x8a847a, 0, 0, 0, 0.02);
  const pal = [0xc9b79c, 0x9fb1a8, 0xb48a78, 0x8c9aa8, 0xc2a87a, 0xa89a8c, 0x9a7a6a];
  const roofs = [0x5a3a32, 0x3e4450, 0x6a4a3a, 0x4a4040];
  // left and right rows facing the plaza
  for (const side of [-1, 1]) {
    let z = -18;
    while (z > -150) {
      const d = 9 + rng() * 5, w = 9 + rng() * 4, h = 4.5 + Math.floor(rng() * 3) * 3;
      const x = side * (55 + w / 2 - 4);
      const flat = rng() < 0.5;
      house(gb, glow, x, z - d / 2, d, w, h, pal[Math.floor(rng() * pal.length)], roofs[Math.floor(rng() * roofs.length)], side * -Math.PI / 2, rng, { flat, boarded: true, lit: true });
      if (rng() < 0.5) {
        // shop awning and sign
        const ax = side * (55 - 5.5);
        gb.add('box', ax, 3.0, z - d / 2, 1.6, 0.12, d * 0.7, [0xa83a2a, 0x2a6a8a, 0x3a7a4a][Math.floor(rng() * 3)], 0, 0, side * 0.35);
        gb.boxB(side * (55 - 4.2), 3.6, z - d / 2, 0.2, 1.0, d * 0.6, 0x2a2a2a);
      }
      obstacles.push({ x, z: z - d / 2, r: Math.max(d, w) / 2 + 0.5 });
      z -= d + 1.5 + rng() * 3;
    }
  }
  // back row with the street opening
  for (let x = -70; x <= 70; x += 15) {
    if (Math.abs(x) < 10) continue;
    const h = 6 + Math.floor(rng() * 4) * 3;
    house(gb, glow, x, -160, 13, 10, h, pal[Math.floor(rng() * pal.length)], roofs[Math.floor(rng() * roofs.length)], 0, rng, { flat: rng() < 0.6, boarded: true, lit: true });
  }
  // distant skyline
  for (let i = 0; i < 40; i++) {
    const x = (rng() - 0.5) * 500, z = -200 - rng() * 200;
    if (Math.abs(x) < 12) continue;
    house(gb, glow, x, z, 10 + rng() * 10, 10 + rng() * 10, 8 + rng() * 26, pal[Math.floor(rng() * pal.length)], 0x3a3a3a, 0, rng, { flat: true, lit: true, door: false });
  }
  // water tower
  gb.add('cyl8', 80, 16, -190, 5, 6, 5, 0x9a8a7a);
  gb.add('cone7', 80, 20, -190, 5.4, 2.5, 5.4, 0x6a5a4a);
  for (const [dx, dz] of [[-3, -3], [3, -3], [-3, 3], [3, 3]]) gb.add('box', 80 + dx, 6.5, -190 + dz, 0.3, 13, 0.3, 0x5a4a3a);
  // gas station
  {
    const gx = -30, gz = -100;
    gb.boxB(gx, 4.2, gz, 12, 0.6, 8, 0xe8e0d0);
    gb.boxB(gx, 4.8, gz, 12.2, 0.4, 8.2, 0xb83a2a);
    for (const [dx, dz] of [[-5, -3], [5, -3], [-5, 3], [5, 3]]) gb.boxB(gx + dx, 0, gz + dz, 0.4, 4.2, 0.4, 0xd8d0c0);
    gb.boxB(gx - 2, 0, gz, 0.8, 1.6, 0.6, 0xc8c0b0);
    gb.boxB(gx + 2, 0, gz, 0.8, 1.6, 0.6, 0xc8c0b0);
    glow.boxB(gx, 4.15, gz, 10, 0.05, 6, 0xfff4d0);
    obstacles.push({ x: gx - 2, z: gz, r: 1 }, { x: gx + 2, z: gz, r: 1 });
  }
  // wrecked cars and a crashed bus
  const carCols = [0x9a3a32, 0x3a5a8a, 0xd0d0c8, 0x6a7a3a, 0x8a8a8a, 0xc8a040];
  for (const [x, z, ry, flip] of [[-12, -34, 0.4, false], [14, -48, -0.9, false], [-22, -66, 1.8, true], [8, -86, 0.2, false],
    [26, -100, 2.4, false], [-6, -118, -0.6, false], [30, -32, 1.2, false], [-34, -44, 0.1, false]]) {
    car(gb, x, z, ry, carCols[Math.floor(rng() * carCols.length)], flip);
    obstacles.push({ x, z, r: 2.6 });
  }
  {
    const bx = 18, bz = -70, ry = 0.7;
    gb.boxB(bx, 0.5, bz, 2.6, 2.6, 10, 0xd8a830, ry);
    gb.boxB(bx, 2.0, bz, 2.65, 0.8, 9.4, 0x2a3440, ry);
    gb.boxB(bx, 3.1, bz, 2.6, 0.1, 10, 0xc89a28, ry);
    obstacles.push({ x: bx - 2.6, z: bz - 2.9, r: 2.2 }, { x: bx, z: bz, r: 2.2 }, { x: bx + 2.6, z: bz + 2.9, r: 2.2 });
  }
  // street lamps, cones, barrels, bins
  for (let z = -24; z > -140; z -= 18) { lamp(gb, glow, -47, z, 6, 1); lamp(gb, glow, 47, z, 6, -1); }
  for (let i = 0; i < 14; i++) {
    const x = (rng() - 0.5) * 70, z = -20 - rng() * 100;
    if (rng() < 0.5) gb.add('cone6', x, 0.4, z, 0.25, 0.8, 0.25, 0xe8742a);
    else barrel(gb, x, z, rng() < 0.5 ? 0x2a5a8a : 0x8a3a2a);
  }
  // power lines
  const wires = [];
  for (let z = -20; z > -150; z -= 24) {
    for (const sx of [-44]) {
      gb.add('cyl6', sx, 5, z, 0.14, 10, 0.14, 0x4a3a2e);
      gb.add('box', sx, 9.4, z, 2.0, 0.12, 0.12, 0x4a3a2e);
      wires.push([sx - 0.9, 9.5, z], [sx + 0.9, 9.5, z]);
    }
  }
  addWires(ctx, wires, 0x1a1a1a);
  // dead trees
  for (let i = 0; i < 30; i++) {
    const x = (rng() < 0.5 ? -1 : 1) * (75 + rng() * 120), z = -10 - rng() * 220;
    deadTree(gb, x, z, 1 + rng() * 0.6, rng);
  }
}

function buildYard(ctx) {
  const { gb, deco, glow, obstacles, rng, extra, root } = ctx;
  // painted lanes
  for (const x of [-20, 20]) for (let z = -18; z > -140; z -= 6) deco.add('plane', x, 0.03, z, 0.3, 1, 3.5, 0xc8a832, 0, 0, 0, 0.02);
  for (let x = -40; x <= 40; x += 2.5) deco.add('plane', x, 0.03, -16.5, 1.2, 1, 0.3, 0xc8a832, 0, 0, 0, 0.02);
  for (let i = 0; i < 20; i++) deco.add('disc', (rng() - 0.5) * 80, 0.03, -20 - rng() * 110, 1 + rng() * 3, 1, 1 + rng() * 2, 0x3b4048, 0, 0, 0, 0.02);
  const cc = [0x8a3b2a, 0x2f5a8a, 0x3e6b45, 0xc4692b, 0x7a7f86, 0x9a8a3a, 0x5a3a6a];
  const container = (x, y, z, ry, c) => {
    gb.add('box', x, y + 1.3, z, 2.45, 2.6, 12.2, c, ry, 0, 0, 0.04);
    for (let k = -5; k <= 5; k += 1.25) {
      const cos = Math.cos(ry), sin = Math.sin(ry);
      gb.add('box', x + 1.25 * cos + k * sin, y + 1.3, z - 1.25 * sin + k * cos, 0.06, 2.5, 0.3, new THREE.Color(c).multiplyScalar(0.8).getHex(), ry, 0, 0, 0.02);
      gb.add('box', x - 1.25 * cos + k * sin, y + 1.3, z + 1.25 * sin + k * cos, 0.06, 2.5, 0.3, new THREE.Color(c).multiplyScalar(0.8).getHex(), ry, 0, 0, 0.02);
    }
  };
  // container stacks on both sides
  for (const side of [-1, 1]) {
    for (let z = -24; z > -150; z -= 14) {
      const stack = 1 + Math.floor(rng() * 4);
      const x = side * (50 + rng() * 4);
      for (let s = 0; s < stack; s++) container(x + (rng() - 0.5) * 0.4, s * 2.6, z, (rng() - 0.5) * 0.05, cc[Math.floor(rng() * cc.length)]);
      container(x + side * 3, 0, z, 0, cc[Math.floor(rng() * cc.length)]);
      obstacles.push({ x, z: z - 4, r: 3 }, { x, z, r: 3 }, { x, z: z + 4, r: 3 });
    }
  }
  // single containers in the yard as cover
  for (const [x, z, ry] of [[-16, -44, 0.3], [20, -62, -0.5], [-8, -92, 1.4], [26, -108, 0.2], [-30, -76, 0.9]]) {
    container(x, 0, z, ry, cc[Math.floor(rng() * cc.length)]);
    const cos = Math.cos(ry), sin = Math.sin(ry);
    for (const k of [-4.5, -1.5, 1.5, 4.5]) obstacles.push({ x: x + k * sin, z: z + k * cos, r: 1.9 });
  }
  // gantry cranes
  const blinkers = [];
  for (const cx of [-34, 34]) {
    const cz = -165;
    for (const dx of [-8, 8]) for (const dz of [-5, 5]) gb.add('box', cx + dx, 16, cz + dz, 0.9, 32, 0.9, 0xc84a2a);
    gb.boxB(cx, 30, cz, 18, 2.2, 12, 0xc84a2a);
    gb.boxB(cx, 30, cz - 26, 3, 2.0, 40, 0xb84228);
    gb.boxB(cx - 2, 32.2, cz + 2, 5, 3, 4, 0x5a5a5a);
    const b = new THREE.Mesh(BOX, new THREE.MeshBasicMaterial({ color: 0xff3a2a, fog: false }));
    b.scale.setScalar(0.7); b.position.set(cx, 35.5, cz);
    root.add(b); blinkers.push(b);
  }
  extra.push({ update: (dt, t) => { const on = (t % 1.6) < 0.5; for (const b of blinkers) b.visible = on; } });
  // warehouses far sides
  for (const [x, z, w, d] of [[-95, -60, 30, 60], [100, -90, 34, 70], [-90, -170, 40, 40]]) {
    gb.boxB(x, 0, z, w, 12, d, 0x6a7078);
    gb.add('prism', x, 13.5, z, w * 0.6, 3, d, 0x4a5058, 0);
    for (let k = -d / 2 + 6; k < d / 2 - 3; k += 10) glow.boxB(x + Math.sign(-x) * (w / 2 + 0.05), 8, z + k, 0.1, 1.2, 4, 0xffd27a);
  }
  // floodlight towers with light pools
  const pools = new GeoBuilder(false);
  for (const [x, z] of [[-26, -36], [26, -36], [-22, -88], [24, -84], [0, -126]]) {
    gb.add('cyl6', x, 7, z, 0.18, 14, 0.18, 0x5a5e64);
    gb.boxB(x, 13.6, z, 1.8, 0.8, 0.5, 0x3a3e42, Math.atan2(-x, -z));
    glow.boxB(x, 13.6, z + 0.3, 1.5, 0.6, 0.3, 0xfff6d8);
    pools.add('disc', x * 0.9, 0.05, z + 4, 11, 1, 11, 0xffe9b0, 0, 0, 0, 0);
  }
  const pm = pools.build(new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.13, blending: THREE.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }));
  pm.renderOrder = 2;
  root.add(pm);
  // barrels, crates, forklift
  for (let i = 0; i < 18; i++) {
    const x = (rng() - 0.5) * 80, z = -20 - rng() * 105;
    if (rng() < 0.5) barrel(gb, x, z, [0x2a5a8a, 0x8a2a2a, 0x3a6a3a][Math.floor(rng() * 3)]);
    else crate(gb, x, z, 0.9 + rng() * 0.4, 0x8a7048, rng() * 3);
  }
  {
    const x = 6, z = -40;
    gb.boxB(x, 0.3, z, 1.4, 1.2, 2.2, 0xe0a020, 0.4);
    gb.boxB(x, 1.5, z + 0.2, 1.3, 1.4, 1.2, 0x2a2e34, 0.4);
    gb.add('box', x - 0.5, 1.5, z - 1.5, 0.12, 3, 0.12, 0x3a3a3a, 0.4);
    obstacles.push({ x, z, r: 1.8 });
  }
  // sea and ships on the horizon
  const sea = new THREE.Mesh(new THREE.PlaneGeometry(1400, 600), new THREE.MeshBasicMaterial({ color: 0x0b1424 }));
  sea.rotation.x = -Math.PI / 2; sea.position.set(0, 0.5, -520);
  root.add(sea);
  for (const [x, z, l] of [[-120, -330, 90], [140, -420, 120]]) {
    gb.boxB(x, 0, z, l, 8, 14, 0x2a2e36);
    gb.boxB(x + l * 0.3, 8, z, l * 0.2, 10, 10, 0x3a3e46);
    for (let k = -l / 2 + 6; k < l / 2; k += 7) glow.boxB(x + k, 5, z + 7.1, 1.2, 0.6, 0.1, 0xffd88a);
  }
  // quay edge
  gb.boxB(0, 0, -200, 900, 0.8, 4, 0x5a5e64);
}

// ---------- entry ----------
export function buildWorld(M) {
  const root = new THREE.Group();
  const rng = mulberry32(M.id.length * 9973 + M.id.charCodeAt(0) * 31);
  const gb = new GeoBuilder(true);
  const deco = new GeoBuilder(false);
  const glow = new GeoBuilder(false);
  const tower = new GeoBuilder(true);
  const obstacles = [];
  const extra = [];
  const ctx = { root, gb, deco, glow, obstacles, rng, extra, M };
  flatSea = M.id === 'yard';

  root.add(makeSky(M));
  root.add(makeDisc(M));
  root.add(makeMountains(M, rng));
  root.add(makeClouds(M, rng));
  if (M.night) root.add(makeStars(rng));

  const hemi = new THREE.HemisphereLight(M.hemiSky, M.hemiGround, M.hemiInt);
  root.add(hemi);
  const sun = new THREE.DirectionalLight(M.sun, M.sunInt);
  sun.position.set(...M.sunDir).multiplyScalar(100);
  root.add(sun);

  const ground = makeGround(M, rng);
  root.add(ground);

  buildTower(tower);
  const barricade = new Barricade(root, gb, M);

  if (M.id === 'farm') buildFarm(ctx);
  else if (M.id === 'town') buildTown(ctx);
  else buildYard(ctx);

  const staticMesh = gb.build(new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
  staticMesh.userData.surface = M.id === 'yard' ? 'metal' : 'wood';
  root.add(staticMesh);
  const towerMesh = tower.build(new THREE.MeshLambertMaterial({ vertexColors: true }));
  root.add(towerMesh);
  if (!deco.empty) {
    const dm = deco.build(new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    root.add(dm);
  }
  if (!glow.empty) root.add(glow.build(new THREE.MeshBasicMaterial({ vertexColors: true })));

  return {
    root, obstacles, barricade,
    colliders: [ground, staticMesh, barricade.mesh],
    update(dt, t) { for (const e of extra) e.update(dt, t); },
    dispose() {
      root.traverse(o => {
        if (o.geometry && o.geometry !== BOX) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
    },
  };
}
