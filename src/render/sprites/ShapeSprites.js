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

export function getResourceNodeSprite(resourceType, sizePx) {
  const color = resourceType === 'energy' ? '#4fb3e8' : '#d9b23a';
  const key = `r:${resourceType}:${Math.round(sizePx)}`;
  return cached(key, sizePx, (ctx, s) => {
    const cx = s / 2, cy = s / 2, r = s * 0.42;
    ctx.beginPath();
    ctx.moveTo(cx, cy - r);
    ctx.lineTo(cx + r, cy);
    ctx.lineTo(cx, cy + r);
    ctx.lineTo(cx - r, cy);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    outline(ctx);
  });
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
