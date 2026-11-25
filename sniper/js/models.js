// Low-poly character and weapon models built from boxes and cylinders.
import * as THREE from './three.module.min.js';

export const BOX = new THREE.BoxGeometry(1, 1, 1);
export const CYL = new THREE.CylinderGeometry(1, 1, 1, 10);
export const CIRCLE = new THREE.CircleGeometry(1, 14);
const CONE4 = new THREE.ConeGeometry(1, 1, 4);

const lambertCache = new Map();
const basicCache = new Map();
export function lam(hex) {
  let m = lambertCache.get(hex);
  if (!m) { m = new THREE.MeshLambertMaterial({ color: hex }); lambertCache.set(hex, m); }
  return m;
}
export function bas(hex, opts) {
  const key = hex + (opts ? JSON.stringify(opts) : '');
  let m = basicCache.get(key);
  if (!m) { m = new THREE.MeshBasicMaterial({ color: hex, ...(opts || {}) }); basicCache.set(key, m); }
  return m;
}

export const SHADOW_MAT = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.32, depthWrite: false });

function box(parent, w, h, d, x, y, z, material) {
  const m = new THREE.Mesh(BOX, material);
  m.scale.set(w, h, d);
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}

function shade(hex, f) {
  const c = new THREE.Color(hex);
  c.r = Math.min(1, c.r * f); c.g = Math.min(1, c.g * f); c.b = Math.min(1, c.b * f);
  return c.getHex();
}

const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];

const ZSKIN = [0x8fb36a, 0x9cbf73, 0x7fa65c, 0xa3b87a, 0x86a87d, 0x98ad86];
const ZSHIRT = [0x7a4b3a, 0x3e5c7a, 0x6d6d6d, 0x8a7a4a, 0x5a3e6a, 0x9a3b3b, 0xb59a6a, 0x4c6b5a, 0xa8a49a];
const ZPANTS = [0x2f3a4a, 0x4a3b2a, 0x3a3a3a, 0x55613d, 0x3b4a5c];
const ZHAIR = [0x2a221c, 0x4a3a2a, 0x6a6a6a, 0x1c1c1c, 0x7a5a3a];
const HSKIN = [0xf1c27d, 0xe0ac69, 0xc68642, 0x8d5524, 0xf5d0a9];
const HSHIRT = [0xe8742a, 0x2f7fd6, 0xe0d24a, 0xf0f0f0, 0xd04a8a, 0x3fbf9f];
const HHAIR = [0x2a1d12, 0x5a3a1a, 0xc9a24a, 0x111111, 0x8a3a1a];

// Characters are built from boxes, merged into one vertex-coloured mesh per animated part
// (legs, torso, arms, head), which keeps each character to about eight draw calls.
const BOX_NI = BOX.toNonIndexed();
const CONE4_NI = CONE4.toNonIndexed();
const ZMAT = new THREE.MeshLambertMaterial({ vertexColors: true });
const GLOWMAT = new THREE.MeshBasicMaterial({ vertexColors: true });
const _col = new THREE.Color();

class Parts {
  constructor() { this.pos = []; this.nor = []; this.col = []; }
  box(w, h, d, x, y, z, color, tpl = BOX_NI) {
    const p = tpl.attributes.position.array, n = tpl.attributes.normal.array;
    _col.setHex(color);
    for (let i = 0; i < p.length; i += 3) {
      this.pos.push(p[i] * w + x, p[i + 1] * h + y, p[i + 2] * d + z);
      this.nor.push(n[i], n[i + 1], n[i + 2]);
      this.col.push(_col.r, _col.g, _col.b);
    }
    return this;
  }
  mesh(mat = ZMAT) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeBoundingSphere();
    g.userData.own = true;
    return new THREE.Mesh(g, mat);
  }
}

export function disposeOwned(obj) {
  obj.traverse(o => { if (o.geometry && o.geometry.userData.own) o.geometry.dispose(); });
}

/**
 * Builds a chunky humanoid facing +z. Returns pivots for animation and the meshes used for hit tests.
 */
export function buildHumanoid(o, rng = Math.random) {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const W = o.wide ? 1.45 : o.thin ? 0.82 : 1;
  const shoe = o.shoe ?? 0x2a2420;

  const hipL = new THREE.Group(); hipL.position.set(-0.12 * W, 0.6, 0); body.add(hipL);
  const hipR = new THREE.Group(); hipR.position.set(0.12 * W, 0.6, 0); body.add(hipR);
  const leg = () => new Parts().box(0.2 * W, 0.56, 0.22, 0, -0.27, 0, o.pants).box(0.21 * W, 0.09, 0.3, 0, -0.56, 0.04, shoe).mesh();
  const legL = leg(), legR = leg();
  hipL.add(legL); hipR.add(legR);

  const depth = o.belly ? 0.46 : 0.32, bz = o.belly ? 0.05 : 0;
  const tp = new Parts()
    .box(0.52 * W, 0.58, depth, 0, 0.89, bz, o.shirt)
    .box(0.53 * W, 0.07, depth + 0.01, 0, 0.62, bz, shade(o.pants, 0.7));
  if (o.stain) tp.box(0.18 * W, 0.16, 0.02, (rng() - 0.5) * 0.2 * W, 0.86 + (rng() - 0.5) * 0.2, depth / 2 + 0.01 + bz, 0x5a1010);
  if (o.vest) {
    tp.box(0.56 * W, 0.44, depth + 0.06, 0, 0.92, 0, o.vest);
    tp.box(0.12, 0.12, 0.04, 0.12, 0.98, depth / 2 + 0.04, shade(o.vest, 0.75));
    tp.box(0.12, 0.12, 0.04, -0.12, 0.98, depth / 2 + 0.04, shade(o.vest, 0.75));
  }
  if (o.apron) tp.box(0.48 * W, 0.62, 0.03, 0, 0.78, depth / 2 + 0.06, o.apron);
  const torso = tp.mesh();
  body.add(torso);
  if (o.glow) {
    const gp = new Parts();
    for (let i = 0; i < 6; i++) {
      const sz = 0.07 + rng() * 0.08;
      gp.box(sz, sz, sz, (rng() - 0.5) * 0.45 * W, 0.7 + rng() * 0.35, depth / 2 + 0.06, o.glow);
    }
    gp.box(0.1, 0.1, 0.1, 0.24 * W, 0.98, 0.1, o.glow);
    body.add(gp.mesh(GLOWMAT));
  }
  const torsoC = new THREE.Object3D(); torsoC.position.set(0, 0.89, 0); body.add(torsoC);

  const shL = new THREE.Group(); shL.position.set(-(0.26 * W + 0.08), 1.1, 0); body.add(shL);
  const shR = new THREE.Group(); shR.position.set(0.26 * W + 0.08, 1.1, 0); body.add(shR);
  const armW = o.wide ? 0.21 : 0.15;
  const sleeve = o.sleeve === 'skin' ? o.skin : o.shirt;
  const arm = () => {
    const a = new Parts().box(armW, 0.36, armW, 0, -0.16, 0, sleeve).box(armW * 0.92, 0.2, armW * 0.92, 0, -0.42, 0, o.skin);
    if (o.spikes) a.box(0.28, 0.1, 0.28, 0, 0.04, 0, 0x4a3a30).box(0.06, 0.22, 0.06, 0, 0.18, 0, 0xe6dcc0, CONE4_NI);
    return a.mesh();
  };
  const armL = arm(), armR = arm();
  shL.add(armL); shR.add(armR);

  // head group origin sits at the head's centre so a severed head tumbles naturally
  const neck = new THREE.Group(); neck.position.set(0, 1.17, 0); body.add(neck);
  const headG = new THREE.Group(); headG.position.y = 0.3; neck.add(headG);
  const hp = new Parts().box(0.62, 0.58, 0.58, 0, 0, 0, o.skin)
    .box(o.human ? 0.16 : 0.26, 0.05, 0.02, 0, -0.13, 0.295, o.human ? 0x7a3a2a : 0x3a1414);
  if (!o.human) hp.box(0.08, 0.06, 0.02, 0.08, -0.17, 0.296, 0xe8e0c8);
  if (o.hair !== undefined && o.hair !== null) {
    hp.box(0.64, 0.12, 0.6, 0, 0.32, -0.01, o.hair);
    hp.box(0.64, 0.3, 0.12, 0, 0.15, -0.25, o.hair);
  }
  const head = hp.mesh();
  headG.add(head);
  const eh = o.human ? 0.1 : 0.07;
  const eyes = new Parts().box(0.11, eh, 0.02, -0.14, 0.04, 0.297, o.eyes ?? 0x1a1a1a).box(0.11, eh, 0.02, 0.14, 0.04, 0.297, o.eyes ?? 0x1a1a1a)
    .mesh(o.eyes ? GLOWMAT : ZMAT);
  headG.add(eyes);
  let helmet = null;
  if (o.helmet) {
    helmet = new THREE.Group();
    helmet.position.set(0, 0.26, 0);
    headG.add(helmet);
    const hm = new Parts().box(0.72, 0.3, 0.7, 0, 0.02, 0, 0x4e5a39).box(0.78, 0.05, 0.76, 0, -0.12, 0.02, 0x434d31)
      .box(0.5, 0.04, 0.02, 0, 0.06, 0.352, 0x2e3522).mesh();
    helmet.add(hm);
    helmet.userData.hitMesh = hm;
  }

  const shadow = new THREE.Mesh(CIRCLE, SHADOW_MAT);
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.03;
  shadow.scale.setScalar(0.45 * W);
  shadow.renderOrder = 1;
  root.add(shadow);

  let marker = null;
  if (o.marker) {
    marker = new THREE.Mesh(CONE4, bas(0x5dff7a, { fog: false }));
    marker.scale.set(0.22, -0.34, 0.22);
    marker.position.set(0, 2.3, 0);
    root.add(marker);
  }

  root.scale.setScalar(o.scale || 1);

  const tag = (m, part) => { m.userData.part = part; return m; };
  const hit = [tag(head, 'head'), tag(torso, 'body'), tag(legL, 'limb'), tag(legR, 'limb'), tag(armL, 'limb'), tag(armR, 'limb')];
  if (helmet) hit.unshift(tag(helmet.userData.hitMesh, 'helmet'));

  return { root, body, hipL, hipR, shL, shR, neck, headG, head, torso: torsoC, torsoMesh: torso, helmet, marker, shadow, hit, W };
}

export function zombieLook(type, rng = Math.random) {
  const o = { skin: pick(rng, ZSKIN), shirt: pick(rng, ZSHIRT), pants: pick(rng, ZPANTS),
    hair: rng() < 0.6 ? pick(rng, ZHAIR) : null, eyes: 0xffe14a, stain: rng() < 0.7, sleeve: rng() < 0.5 ? 'skin' : null };
  if (type === 'runner') { o.thin = true; o.shirt = pick(rng, [0xa33a32, 0x2c6ea8, 0xd0c04a]); o.eyes = 0xff5a3a; o.hair = null; }
  if (type === 'brute') { o.wide = true; o.belly = true; o.shirt = pick(rng, [0x8a8a7a, 0x5a6a7a, 0x7a5a4a]); o.sleeve = 'skin'; o.skin = 0x7d9a5e; }
  if (type === 'soldier') { o.shirt = 0x5d6b3e; o.pants = 0x4a5232; o.vest = 0x3b4229; o.helmet = true; o.hair = null; o.sleeve = null; }
  if (type === 'bloater') { o.belly = true; o.skin = 0xa9b860; o.shirt = 0x7a7a50; o.glow = 0xd8ff3a; o.eyes = 0xd8ff3a; o.sleeve = 'skin'; }
  if (type === 'boss') { o.wide = true; o.belly = true; o.skin = 0x9a8a72; o.shirt = 0x5a4a44; o.apron = 0xcfc6b0; o.spikes = true; o.eyes = 0xff2a1a; o.hair = null; o.stain = true; o.sleeve = 'skin'; }
  return o;
}

export function survivorLook(rng = Math.random) {
  return { human: true, skin: pick(rng, HSKIN), shirt: pick(rng, HSHIRT), pants: pick(rng, [0x2d3e66, 0x3a3a3a, 0x6b5a40]),
    hair: pick(rng, HHAIR), marker: true, shoe: 0xf0f0f0 };
}

/**
 * Rifle viewmodel. Barrel points toward -z.
 */
export function buildRifle(def) {
  const L = def.look;
  const g = new THREE.Group();
  const stockM = lam(L.stock), bodyM = lam(L.body), metalM = lam(0x3a3e42), glassM = bas(0x17222a);
  const len = L.len, sc = L.scope;
  // stock
  box(g, 0.07, 0.11, 0.3, 0, -0.035, 0.32, stockM);
  box(g, 0.075, 0.06, 0.12, 0, 0.02, 0.4, stockM);         // cheek rest
  box(g, 0.08, 0.13, 0.03, 0, -0.04, 0.48, lam(0x1a1a1a));  // butt pad
  box(g, 0.06, 0.12, 0.06, 0, -0.1, 0.14, stockM);          // grip
  // receiver
  box(g, 0.075, 0.085, 0.36, 0, 0, -0.02, bodyM);
  // handguard
  box(g, 0.08, 0.08, 0.34 * len, 0, -0.01, -0.36 * len, L.mag ? bodyM : stockM);
  // trigger guard
  box(g, 0.02, 0.05, 0.08, 0, -0.07, 0.06, metalM);
  // barrel
  const bl = 0.55 * len;
  const barrel = new THREE.Mesh(CYL, metalM);
  barrel.scale.set(0.017, bl, 0.017);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, 0.012, -0.36 * len - bl / 2 + 0.05);
  g.add(barrel);
  const tipZ = -0.36 * len - bl + 0.05;
  if (L.brake) box(g, 0.045, 0.045, 0.09, 0, 0.012, tipZ - 0.02, metalM);
  // scope
  const tube = new THREE.Mesh(CYL, bodyM);
  tube.scale.set(0.03, 0.32 * sc, 0.03); tube.rotation.x = Math.PI / 2; tube.position.set(0, 0.1, -0.04);
  g.add(tube);
  const bell = new THREE.Mesh(CYL, bodyM);
  bell.scale.set(0.043, 0.09, 0.043); bell.rotation.x = Math.PI / 2; bell.position.set(0, 0.1, -0.04 - 0.16 * sc - 0.03);
  g.add(bell);
  const eye = new THREE.Mesh(CYL, bodyM);
  eye.scale.set(0.038, 0.07, 0.038); eye.rotation.x = Math.PI / 2; eye.position.set(0, 0.1, -0.04 + 0.16 * sc + 0.02);
  g.add(eye);
  const lens = new THREE.Mesh(CIRCLE, glassM); lens.scale.setScalar(0.036); lens.position.set(0, 0.1, -0.04 + 0.16 * sc + 0.056);
  g.add(lens);
  box(g, 0.03, 0.05, 0.03, 0, 0.06, 0.04, metalM);
  box(g, 0.03, 0.05, 0.03, 0, 0.06, -0.12, metalM);
  box(g, 0.026, 0.03, 0.03, 0.035, 0.1, -0.04, metalM); // turret
  box(g, 0.03, 0.026, 0.03, 0, 0.135, -0.04, metalM);
  // bolt handle
  if (!def.semi) {
    const bolt = new THREE.Mesh(CYL, metalM);
    bolt.scale.set(0.009, 0.08, 0.009); bolt.rotation.z = Math.PI / 2; bolt.position.set(0.07, 0.02, 0.1);
    g.add(bolt);
    box(g, 0.025, 0.025, 0.025, 0.11, 0.02, 0.1, metalM);
    g.userData.bolt = bolt;
  }
  if (L.mag) box(g, 0.05, 0.13, 0.08, 0, -0.1, -0.05, lam(0x1a1c1e));
  if (L.bipod) {
    box(g, 0.012, 0.012, 0.22, 0.03, -0.05, -0.55 * len, metalM);
    box(g, 0.012, 0.012, 0.22, -0.03, -0.05, -0.55 * len, metalM);
  }
  // gloves
  const glove = lam(0x2b2a28), sleeve = lam(0x4a5236);
  const hands = handsOf(g);
  box(hands, 0.075, 0.08, 0.09, 0.015, -0.1, 0.13, glove);
  box(hands, 0.09, 0.09, 0.25, 0.04, -0.14, 0.3, sleeve);
  box(hands, 0.08, 0.06, 0.1, -0.02, -0.07, -0.32 * len, glove);
  box(hands, 0.1, 0.09, 0.3, -0.09, -0.1, -0.16 * len, sleeve);

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.012, tipZ - 0.06);
  g.add(muzzle);
  return { group: g, muzzle };
}

// ---------------------------------------------------------------- other weapon classes (barrels point toward -z)
function cyl(parent, r, len, x, y, z, material, axis = 'z') {
  const m = new THREE.Mesh(CYL, material);
  m.scale.set(r, len, r);
  if (axis === 'z') m.rotation.x = Math.PI / 2;
  else if (axis === 'x') m.rotation.z = Math.PI / 2;
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}
function handsOf(g) {
  if (!g.userData.hands) { const h = new THREE.Group(); g.add(h); g.userData.hands = h; }
  return g.userData.hands;
}
function gloves(gun, rightZ, leftZ, leftX = -0.02, leftY = -0.065) {
  const glove = lam(0x2b2a28), sleeve = lam(0x4a5236);
  const g = handsOf(gun);
  box(g, 0.07, 0.08, 0.09, 0.012, -0.1, rightZ, glove);
  box(g, 0.09, 0.09, 0.25, 0.04, -0.14, rightZ + 0.17, sleeve);
  box(g, 0.08, 0.06, 0.1, leftX, leftY, leftZ, glove);
  const ls = box(g, 0.1, 0.09, 0.3, leftX - 0.07, leftY - 0.035, leftZ + 0.17, sleeve);
  ls.rotation.y = 0.25;
}

export function buildAuto(def) {
  const L = def.look, g = new THREE.Group(), len = L.len;
  const bodyM = lam(L.body), furnM = lam(L.furn), metalM = lam(0x3a3e42), dark = lam(0x18191b);
  box(g, 0.06, 0.1, 0.26, 0, -0.03, 0.34, furnM);                 // stock
  box(g, 0.07, 0.12, 0.03, 0, -0.04, 0.47, dark);                  // butt pad
  box(g, 0.05, 0.11, 0.06, 0, -0.1, 0.14, furnM).rotation.x = 0.25; // grip
  box(g, 0.075, 0.1, 0.4, 0, 0, 0, bodyM);                         // receiver
  box(g, 0.022, 0.012, 0.36, 0, 0.056, -0.02, metalM);             // top rail
  box(g, 0.085, 0.09, 0.3 * len, 0, -0.005, -0.2 - 0.15 * len, furnM); // handguard
  const bl = 0.32 * len;
  cyl(g, 0.014, bl, 0, 0.005, -0.2 - 0.3 * len - bl / 2 + 0.02, metalM);
  const tipZ = -0.2 - 0.3 * len - bl + 0.02;
  box(g, 0.034, 0.034, 0.07, 0, 0.005, tipZ - 0.02, dark);         // flash hider
  if (L.mag === 'curved') { const m = box(g, 0.05, 0.16, 0.07, 0, -0.12, -0.09, dark); m.rotation.x = 0.32; }
  else if (L.mag === 'box') box(g, 0.05, 0.13, 0.08, 0, -0.11, -0.08, dark);
  else if (L.mag === 'drum') { const d = cyl(g, 0.085, 0.07, 0, -0.13, -0.05, dark, 'x'); d.rotation.set(0, 0, Math.PI / 2); }
  // reflex sight
  box(g, 0.05, 0.014, 0.08, 0, 0.068, -0.02, dark);
  box(g, 0.012, 0.05, 0.07, -0.022, 0.1, -0.02, dark);
  box(g, 0.012, 0.05, 0.07, 0.022, 0.1, -0.02, dark);
  box(g, 0.056, 0.012, 0.07, 0, 0.126, -0.02, dark);
  const lensM = bas(0x5a2a22); const lens = box(g, 0.034, 0.036, 0.004, 0, 0.1, -0.05, lensM);
  lens.material = lensM;
  if (L.bipod) {
    box(g, 0.012, 0.012, 0.22, 0.03, -0.06, -0.48 * len, metalM);
    box(g, 0.012, 0.012, 0.22, -0.03, -0.06, -0.48 * len, metalM);
  }
  gloves(g, 0.13, -0.28 * len);
  const muzzle = new THREE.Object3D(); muzzle.position.set(0, 0.005, tipZ - 0.08); g.add(muzzle);
  return { group: g, muzzle };
}

export function buildPistol(def) {
  const L = def.look, g = new THREE.Group();
  const bodyM = lam(L.body), gripM = lam(L.grip), dark = lam(0x18191b);
  let tip;
  if (L.revolver) {
    box(g, 0.036, 0.04, 0.2, 0, 0.035, -0.15, bodyM);        // barrel
    box(g, 0.012, 0.014, 0.014, 0, 0.062, -0.24, bodyM);      // front sight
    cyl(g, 0.034, 0.075, 0, 0.025, -0.02, bodyM);             // cylinder
    box(g, 0.04, 0.06, 0.1, 0, 0.03, 0.04, bodyM);            // frame
    box(g, 0.012, 0.025, 0.02, 0, 0.065, 0.085, dark);        // hammer
    tip = -0.26;
  } else {
    box(g, 0.042, 0.042, 0.2, 0, 0.032, -0.06, bodyM);       // slide
    box(g, 0.04, 0.03, 0.17, 0, 0.0, -0.05, dark);           // frame
    box(g, 0.01, 0.012, 0.008, 0, 0.058, -0.15, dark);        // front sight
    box(g, 0.03, 0.012, 0.008, 0, 0.058, 0.03, dark);         // rear sight
    if (L.long) { box(g, 0.036, 0.036, 0.05, 0, 0.032, -0.18, dark); }
    tip = L.long ? -0.21 : -0.17;
  }
  box(g, 0.012, 0.035, 0.05, 0, -0.03, -0.01, dark);          // trigger guard
  box(g, 0.04, 0.11, 0.055, 0, -0.06, 0.04, gripM).rotation.x = 0.25;
  if (L.long) box(g, 0.034, 0.12, 0.045, 0, -0.16, 0.065, dark).rotation.x = 0.25;
  const glove = lam(0x2b2a28), sleeve = lam(0x4a5236);
  const hands = handsOf(g);
  box(hands, 0.058, 0.085, 0.08, 0.012, -0.065, 0.05, glove);
  box(hands, 0.05, 0.075, 0.075, -0.028, -0.07, 0.045, glove);
  box(hands, 0.08, 0.08, 0.24, 0.03, -0.11, 0.21, sleeve);
  box(hands, 0.08, 0.08, 0.24, -0.07, -0.11, 0.2, sleeve).rotation.y = 0.35;
  const muzzle = new THREE.Object3D(); muzzle.position.set(0, 0.032, tip - 0.03); g.add(muzzle);
  return { group: g, muzzle };
}

export function buildLauncher(def) {
  const L = def.look, g = new THREE.Group();
  const tubeM = lam(L.body), rim = lam(new THREE.Color(L.body).multiplyScalar(0.7).getHex()), dark = lam(0x1a1b1c);
  const headM = lam(0x6a7a40), tipM = lam(0x3a3a2a);
  const n = L.tubes, r = n === 1 ? 0.058 : 0.046;
  const spots = n === 1 ? [[0, 0]] : [[-0.048, -0.01], [0.048, -0.01], [0, 0.072]];
  const warheads = [];
  for (const [tx, ty] of spots) {
    cyl(g, r, 1.0, tx, ty, -0.1, tubeM);
    cyl(g, r * 1.18, 0.06, tx, ty, -0.6, rim);
    cyl(g, r * 1.3, 0.1, tx, ty, 0.42, rim);
    const w = new THREE.Group();
    const cone = new THREE.Mesh(CONE4, headM); cone.scale.set(r * 0.95, 0.2, r * 0.95); cone.rotation.x = -Math.PI / 2; cone.position.z = -0.1;
    const neck = new THREE.Mesh(CYL, tipM); neck.scale.set(r * 0.5, 0.08, r * 0.5); neck.rotation.x = Math.PI / 2;
    w.add(cone, neck);
    w.position.set(tx, ty, -0.63);
    g.add(w);
    warheads.push(w);
  }
  box(g, 0.045, 0.12, 0.055, 0, -0.12, 0.06, dark).rotation.x = 0.2;   // trigger grip
  box(g, 0.045, 0.1, 0.05, 0, -0.11, -0.25, dark);                       // fore grip
  box(g, 0.055, 0.065, 0.11, -0.1, 0.05, -0.05, dark);                   // optical sight
  box(g, 0.04, 0.04, 0.005, -0.1, 0.05, -0.108, bas(0x3a6a7a));
  const glove = lam(0x2b2a28), sleeve = lam(0x4a5236);
  const hands = handsOf(g);
  box(hands, 0.07, 0.09, 0.08, 0.012, -0.12, 0.07, glove);
  box(hands, 0.09, 0.09, 0.25, 0.04, -0.16, 0.24, sleeve);
  box(hands, 0.08, 0.07, 0.09, -0.015, -0.1, -0.25, glove);
  box(hands, 0.1, 0.09, 0.3, -0.08, -0.13, -0.08, sleeve).rotation.y = 0.25;
  const muzzle = new THREE.Object3D(); muzzle.position.set(0, 0, -0.72); g.add(muzzle);
  g.userData.warheads = warheads;
  return { group: g, muzzle };
}

export function buildWeapon(def) {
  if (def.cls === 'auto') return buildAuto(def);
  if (def.cls === 'pistol') return buildPistol(def);
  if (def.cls === 'rocket') return buildLauncher(def);
  return buildRifle(def);
}

// Rocket in flight; its nose points toward +z so it can be aimed with lookAt.
export function buildRocketProjectile() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(CYL, lam(0x5a6a3a)); body.scale.set(0.045, 0.5, 0.045); body.rotation.x = Math.PI / 2;
  const nose = new THREE.Mesh(CONE4, lam(0x6a7a40)); nose.scale.set(0.06, 0.2, 0.06); nose.rotation.x = Math.PI / 2; nose.position.z = 0.34;
  g.add(body, nose);
  for (let i = 0; i < 4; i++) {
    const f = new THREE.Mesh(BOX, lam(0x3a3a2a)); f.scale.set(0.006, 0.12, 0.1);
    f.position.z = -0.2; f.rotation.z = i * Math.PI / 2; f.translateY(0.06);
    g.add(f);
  }
  const flame = new THREE.Mesh(CONE4, new THREE.MeshBasicMaterial({ color: 0xffb040, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
  flame.scale.set(0.06, 0.4, 0.06); flame.rotation.x = -Math.PI / 2; flame.position.z = -0.45; flame.name = 'flame';
  g.add(flame);
  return g;
}
