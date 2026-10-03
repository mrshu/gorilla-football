// Generated textures. Everything the WebGL renderer puts on a surface is
// painted here into an offscreen canvas first, keeping stadium surfaces
// lightweight and independent of the character artwork.

import { PITCH } from '../game/constants.js';

const LINE = '#f5f4e9';

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

// The whole playing surface: mown stripes plus every marking, drawn once at
// high resolution and mapped onto a single plane.
export function pitchTexture(THREE, { margin = 6, pxPerMetre = 18 } = {}) {
  const W = PITCH.length + margin * 2;
  const H = PITCH.width + margin * 2;
  const c = makeCanvas(Math.round(W * pxPerMetre), Math.round(H * pxPerMetre));
  const ctx = c.getContext('2d');
  const X = (x) => (x + margin) * pxPerMetre;
  const Y = (y) => (y + margin) * pxPerMetre;

  ctx.fillStyle = '#206c50';
  ctx.fillRect(0, 0, c.width, c.height);
  const stripes = 16;
  for (let i = 0; i < stripes; i++) {
    ctx.fillStyle = i % 2 ? '#388466' : '#32785d';
    ctx.fillRect(X((i / stripes) * PITCH.length), 0, (PITCH.length / stripes) * pxPerMetre, c.height);
  }
  // A little wear towards the middle so the grass is not perfectly flat.
  const grad = ctx.createRadialGradient(c.width / 2, c.height / 2, 0, c.width / 2, c.height / 2, c.width * 0.55);
  grad.addColorStop(0, 'rgba(255,255,255,0.05)');
  grad.addColorStop(1, 'rgba(0,0,0,0.12)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, c.width, c.height);

  ctx.strokeStyle = LINE;
  ctx.lineWidth = 0.14 * pxPerMetre;
  ctx.lineJoin = 'miter';
  const rect = (x0, y0, x1, y1) => ctx.strokeRect(X(x0), Y(y0), (x1 - x0) * pxPerMetre, (y1 - y0) * pxPerMetre);
  const HW = PITCH.width / 2;

  rect(0, 0, PITCH.length, PITCH.width);
  ctx.beginPath();
  ctx.moveTo(X(PITCH.length / 2), Y(0));
  ctx.lineTo(X(PITCH.length / 2), Y(PITCH.width));
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(X(PITCH.length / 2), Y(HW), PITCH.centreCircleRadius * pxPerMetre, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = LINE;
  const spot = (x, y) => {
    ctx.beginPath();
    ctx.arc(X(x), Y(y), 0.2 * pxPerMetre, 0, Math.PI * 2);
    ctx.fill();
  };
  spot(PITCH.length / 2, HW);

  for (const side of [-1, 1]) {
    const gx = side < 0 ? 0 : PITCH.length;
    const inward = side < 0 ? 1 : -1;
    rect(
      Math.min(gx, gx + inward * PITCH.penaltyAreaDepth),
      HW - PITCH.penaltyAreaWidth / 2,
      Math.max(gx, gx + inward * PITCH.penaltyAreaDepth),
      HW + PITCH.penaltyAreaWidth / 2,
    );
    rect(
      Math.min(gx, gx + inward * PITCH.goalAreaDepth),
      HW - PITCH.goalAreaWidth / 2,
      Math.max(gx, gx + inward * PITCH.goalAreaDepth),
      HW + PITCH.goalAreaWidth / 2,
    );
    spot(side < 0 ? PITCH.penaltySpot : PITCH.length - PITCH.penaltySpot, HW);
    // Corner arcs
    for (const cy of [0, PITCH.width]) {
      ctx.beginPath();
      ctx.arc(X(gx), Y(cy), PITCH.cornerArcRadius * pxPerMetre, 0, Math.PI * 2);
      ctx.stroke();
    }
    // The D on the edge of the box
    const dx = side < 0 ? PITCH.penaltyAreaDepth : PITCH.length - PITCH.penaltyAreaDepth;
    ctx.beginPath();
    ctx.arc(X(side < 0 ? PITCH.penaltySpot : PITCH.length - PITCH.penaltySpot), Y(HW), PITCH.centreCircleRadius * pxPerMetre,
      side < 0 ? -Math.PI / 3 : Math.PI * 2 / 3, side < 0 ? Math.PI / 3 : Math.PI * 4 / 3);
    ctx.stroke();
    void dx;
  }

  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 8;
  if (THREE.sRGBEncoding) tex.encoding = THREE.sRGBEncoding;
  return { texture: tex, width: W, height: H, margin };
}

// A terrace of seats with people in them.
export function crowdTexture(THREE) {
  const c = makeCanvas(1024, 512);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#182735';
  ctx.fillRect(0, 0, c.width, c.height);
  // Muted shirts and clear aisles read as a terrace rather than a wall of
  // bright pixels. Keep the crowd quieter than the ball and player markers.
  const colours = ['#5c6d7c', '#3d5c69', '#59617c', '#80744f', '#677c79', '#875c58'];
  const rows = 20;
  const cols = 64;
  const cellW = c.width / cols;
  const cellH = c.height / rows;
  for (let r = 0; r < rows; r++) {
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.fillRect(0, r * cellH + cellH - 3, c.width, 3);
    for (let i = 0; i < cols; i++) {
      const h = hash2(i, r);
      if (h > 0.88 || i % 16 < 2) continue;
      ctx.fillStyle = colours[(h * colours.length) | 0];
      const x = i * cellW + cellW / 2 + (hash2(r, i) - 0.5) * 2;
      const y = r * cellH + 7;
      ctx.fillRect(x - 4, y + 5, 8, 11);
      ctx.fillStyle = '#a39483';
      ctx.beginPath();
      ctx.arc(x, y + 2, 2.8, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

// A plain football: white with dark panels.
export function ballTexture(THREE) {
  const c = makeCanvas(128, 128);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = '#1e1e1e';
  for (const [x, y, r] of [[28, 30, 13], [96, 44, 12], [60, 92, 14], [16, 96, 9], [116, 104, 8]]) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  return new THREE.CanvasTexture(c);
}

function hash2(a, b) {
  const n = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return n - Math.floor(n);
}
