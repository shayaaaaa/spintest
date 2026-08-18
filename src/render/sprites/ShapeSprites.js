// Procedural "programmer art": every unit/building is drawn as a simple
// canvas shape (no images), memoized to an offscreen bitmap per
// (role, color, size) combination so the render loop only ever does a
// cheap drawImage instead of re-running path/fill calls every frame.
const cache = new Map();

function cached(key, sizePx, draw) {
  if (cache.has(key)) return cache.get(key);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = Math.ceil(sizePx);
  const ctx = canvas.getContext('2d');
  draw(ctx, sizePx);
  cache.set(key, canvas);
  return canvas;
}

function outline(ctx) {
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.lineWidth = Math.max(1, ctx.canvas.width * 0.06);
  ctx.stroke();
}

// role -> shape drawing fn(ctx, size, color)
const ROLE_SHAPES = {
  worker(ctx, s, color) {
    ctx.beginPath();
    ctx.arc(s / 2, s / 2, s * 0.36, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    outline(ctx);
  },
  infantry(ctx, s, color) {
    const p = s * 0.14;
    ctx.beginPath();
    ctx.rect(p, p, s - p * 2, s - p * 2);
    ctx.fillStyle = color;
    ctx.fill();
    outline(ctx);
  },
  raider(ctx, s, color) { ROLE_SHAPES.infantry(ctx, s, color); },
  fastStriker(ctx, s, color) { ROLE_SHAPES.infantry(ctx, s, color); },
  ranged(ctx, s, color) {
    ctx.beginPath();
    ctx.moveTo(s / 2, s * 0.1);
    ctx.lineTo(s * 0.9, s * 0.9);
    ctx.lineTo(s * 0.1, s * 0.9);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    outline(ctx);
  },
  lightVehicle(ctx, s, color) { hexagon(ctx, s, color); },
  heavyVehicle(ctx, s, color) { hexagon(ctx, s, color, 1.0); },
  heavyBeast(ctx, s, color) { hexagon(ctx, s, color); },
  heavySiege(ctx, s, color) { hexagon(ctx, s, color, 1.0); },
  summon(ctx, s, color) {
    ctx.beginPath();
    ctx.rect(s * 0.2, s * 0.2, s * 0.6, s * 0.6);
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.85;
    ctx.fill();
    ctx.globalAlpha = 1;
    outline(ctx);
  },
  hero(ctx, s, color) { star(ctx, s, color); },
};

function hexagon(ctx, s, color) {
  const cx = s / 2, cy = s / 2, r = s * 0.46;
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i - Math.PI / 6;
    const x = cx + r * Math.cos(a), y = cy + r * Math.sin(a);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  outline(ctx);
}

function star(ctx, s, color) {
  const cx = s / 2, cy = s / 2, rOuter = s * 0.48, rInner = s * 0.2;
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? rOuter : rInner;
    const a = (Math.PI / 5) * i - Math.PI / 2;
    const x = cx + r * Math.cos(a), y = cy + r * Math.sin(a);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.7)';
  ctx.lineWidth = Math.max(1, s * 0.05);
  ctx.stroke();
}

export function getUnitSprite(role, color, sizePx) {
  const key = `u:${role}:${color}:${Math.round(sizePx)}`;
  return cached(key, sizePx, (ctx, s) => (ROLE_SHAPES[role] || ROLE_SHAPES.infantry)(ctx, s, color));
}

export function getBuildingSprite(isTownHall, color, wPx, hPx) {
  const key = `b:${isTownHall}:${color}:${Math.round(wPx)}:${Math.round(hPx)}`;
  if (cache.has(key)) return cache.get(key);
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(wPx);
  canvas.height = Math.ceil(hPx);
  const ctx = canvas.getContext('2d');
  const r = Math.min(wPx, hPx) * 0.12;
  roundRect(ctx, wPx * 0.05, hPx * 0.05, wPx * 0.9, hPx * 0.9, r);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.6)';
  ctx.lineWidth = Math.max(1, Math.min(wPx, hPx) * 0.05);
  ctx.stroke();
  if (isTownHall) {
    ctx.beginPath();
    ctx.moveTo(wPx / 2, hPx * 0.14);
    ctx.lineTo(wPx * 0.7, hPx * 0.4);
    ctx.lineTo(wPx * 0.3, hPx * 0.4);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.fill();
  }
  cache.set(key, canvas);
  return canvas;
}

// Gold mines and energy nodes render as a big glowing circle rather than a
// flat diamond — a radial gradient plus a few darker flecks sells a
// "shiny ore deposit" read without needing an actual image asset.
const RESOURCE_PALETTES = {
  materials: { inner: '#fff2b8', mid: '#e8b93a', outer: '#a9761c', fleck: 'rgba(90,55,10,0.5)' },
  energy: { inner: '#d6f3ff', mid: '#4fb3e8', outer: '#1f5e82', fleck: 'rgba(10,45,65,0.5)' },
};

export function getResourceNodeSprite(resourceType, sizePx) {
  const palette = RESOURCE_PALETTES[resourceType] || RESOURCE_PALETTES.materials;
  const key = `r:${resourceType}:${Math.round(sizePx)}`;
  return cached(key, sizePx, (ctx, s) => {
    const cx = s / 2, cy = s / 2, r = s * 0.46;
    const grad = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.3, r * 0.1, cx, cy, r);
    grad.addColorStop(0, palette.inner);
    grad.addColorStop(0.55, palette.mid);
    grad.addColorStop(1, palette.outer);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();
    outline(ctx);

    // A handful of deterministic flecks to break up the flat gradient.
    const flecks = [[-0.28, -0.05, 0.09], [0.15, 0.25, 0.07], [0.3, -0.22, 0.06], [-0.1, 0.32, 0.05]];
    ctx.fillStyle = palette.fleck;
    for (const [fx, fy, fr] of flecks) {
      ctx.beginPath();
      ctx.arc(cx + fx * r * 1.6, cy + fy * r * 1.6, fr * r, 0, Math.PI * 2);
      ctx.fill();
    }
  });
}

// Naturalistic-ish tree: a tapered trunk plus a canopy built from several
// overlapping, individually-shaded blobs. The blobs are drawn over a
// slightly-larger solid "underdraw" silhouette instead of being stroked
// individually — stroking each one draws visible seams where they overlap,
// making a cluster of circles read as bubbles rather than one canopy.
// `variant` picks a deterministic layout so the small set of cached
// sprites still gives visual variety across the map.
const TREE_CANOPY_LAYOUTS = [
  [[0, -0.34, 0.36], [-0.24, -0.14, 0.29], [0.26, -0.16, 0.28], [0, 0.08, 0.32]],
  [[0.05, -0.36, 0.32], [-0.28, -0.1, 0.31], [0.24, -0.04, 0.27], [-0.04, 0.14, 0.33]],
];
const TREE_GREENS = ['#2f6b32', '#3d8240', '#4c9a4f'];

export function getTreeSprite(sizePx, variant = 0) {
  const key = `t:${variant}:${Math.round(sizePx)}`;
  return cached(key, sizePx, (ctx, s) => {
    const layout = TREE_CANOPY_LAYOUTS[variant % TREE_CANOPY_LAYOUTS.length];
    // Canopy sits in the upper portion of the sprite, leaving clear room
    // below it for the trunk to be visible rather than painted over.
    const cx0 = s / 2, cy0 = s * 0.38;
    const trunkW = s * 0.14, trunkH = s * 0.32;
    const trunkX = cx0 - trunkW / 2, trunkY = s * 0.62;

    // Ground shadow for grounding.
    ctx.fillStyle = 'rgba(10,20,8,0.3)';
    ctx.beginPath();
    ctx.ellipse(cx0, s * 0.94, s * 0.22, s * 0.06, 0, 0, Math.PI * 2);
    ctx.fill();

    // Canopy underdraw: one solid dark-green silhouette, slightly larger
    // than the final blobs, acts as a clean outline with no internal seams.
    ctx.fillStyle = '#1f4a22';
    ctx.beginPath();
    for (const [ox, oy, orNorm] of layout) {
      ctx.moveTo(cx0 + ox * s + orNorm * s * 1.1, cy0 + oy * s);
      ctx.arc(cx0 + ox * s, cy0 + oy * s, orNorm * s * 1.1, 0, Math.PI * 2);
    }
    ctx.fill();

    // Canopy: individually-gradient-shaded blobs, drawn on top with no
    // stroke — their filled edges blend into the underdraw silhouette.
    layout.forEach(([ox, oy, orNorm], i) => {
      const cx = cx0 + ox * s, cy = cy0 + oy * s, r = orNorm * s;
      const grad = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.35, r * 0.1, cx, cy, r);
      const base = TREE_GREENS[i % TREE_GREENS.length];
      grad.addColorStop(0, lighten(base));
      grad.addColorStop(1, base);
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = grad;
      ctx.fill();
    });

    // Trunk: tapered, drawn on top so it visibly emerges beneath the
    // canopy, with a subtle bark line down the middle.
    ctx.fillStyle = '#5a3d23';
    ctx.beginPath();
    ctx.moveTo(trunkX + trunkW * 0.2, trunkY);
    ctx.lineTo(trunkX + trunkW * 0.8, trunkY);
    ctx.lineTo(trunkX + trunkW, trunkY + trunkH);
    ctx.lineTo(trunkX, trunkY + trunkH);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(35,22,12,0.6)';
    ctx.lineWidth = Math.max(1, s * 0.015);
    ctx.beginPath();
    ctx.moveTo(cx0, trunkY + trunkH * 0.15);
    ctx.lineTo(cx0, trunkY + trunkH * 0.9);
    ctx.stroke();
  });
}

function lighten(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, ((n >> 16) & 255) + 45);
  const g = Math.min(255, ((n >> 8) & 255) + 45);
  const b = Math.min(255, (n & 255) + 30);
  return `rgb(${r},${g},${b})`;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
