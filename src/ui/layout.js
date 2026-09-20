// Screen layout: where the pitch and every touch control lives for the
// current canvas size, orientation and number of humans. Shared by the
// renderer (drawing) and the input layer (hit testing).

import { PITCH } from '../game/constants.js';

const HUD_H = 44;
const MARGIN_M = 3; // metres of grass drawn around the lines


// Place the three action buttons on a triangle around (cx, cy) so they never
// overlap. `flip` mirrors the cluster for the second player's side.
function buttonCluster(cx, cy, br, flip, bounds) {
  // The cluster spans about 5.1 radii across and 4.4 down; shrink to fit.
  if (bounds) br = Math.min(br, bounds.w / 5.2, bounds.h / 4.5);
  const R = br * 1.95;
  const s = flip ? -1 : 1;
  const b = [
    { id: 'special', cx: cx - s * R * 0.86, cy: cy - R * 0.5, r: br * 0.82, label: 'SPECIAL' },
    { id: 'pass', cx: cx + s * R * 0.86, cy: cy - R * 0.5, r: br * 0.9, label: 'PASS' },
    { id: 'shoot', cx: cx, cy: cy + R * 0.78, r: br, label: 'SHOOT' },
  ];
  if (!bounds) return b;
  // Shift the whole cluster (never individual buttons) back inside the screen.
  let dx = 0;
  let dy = 0;
  for (const x of b) {
    dx = Math.min(dx, bounds.x + bounds.w - (x.cx + x.r));
    dy = Math.min(dy, bounds.y + bounds.h - (x.cy + x.r));
  }
  for (const x of b) {
    dx = Math.max(dx, bounds.x - (x.cx - x.r));
    dy = Math.max(dy, bounds.y - (x.cy - x.r));
  }
  return b.map((x) => ({ ...x, cx: x.cx + dx, cy: x.cy + dy }));
}

// `sameSide` is true when both humans play on the same team (co-op). They then
// both face the screen the same way up instead of sitting at opposite ends.
// Whole-team play needs no on-screen controls at all: the whole canvas is the
// control. Two humans split it so each has their own touch area.
export function computeAimLayout(w, h, humanCount, viewAttackDir) {
  const portrait = h > w;
  const hud = { x: 0, y: 0, w, h: HUD_H };
  const zones = humanCount < 2
    ? [{ x: 0, y: HUD_H, w, h: h - HUD_H }]
    : portrait
      ? [
          { x: 0, y: HUD_H + (h - HUD_H) / 2, w, h: (h - HUD_H) / 2 },
          { x: 0, y: HUD_H, w, h: (h - HUD_H) / 2 },
        ]
      : [
          { x: 0, y: HUD_H, w: w / 2, h: h - HUD_H },
          { x: w / 2, y: HUD_H, w: w / 2, h: h - HUD_H },
        ];
  return {
    w,
    h,
    portrait,
    humanCount,
    aim: true,
    viewAttackDir,
    zones,
    hud,
    controls: [],
    pauseBtn: { cx: w - 20, cy: hud.y + HUD_H / 2, r: 15 },
  };
}

export function computeLayout(w, h, humanCount, sameSide = false) {
  const portrait = h > w;
  const layout = { w, h, portrait, humanCount, sameSide, controls: [], hud: { x: 0, y: 0, w, h: HUD_H } };
  const pitchArea = { x: 0, y: HUD_H, w, h: h - HUD_H };

  if (!portrait) {
    const col = clampNum(w * 0.19, 110, 210);
    pitchArea.x = col;
    pitchArea.w = w - 2 * col;
    pitchArea.y = HUD_H;
    pitchArea.h = h - HUD_H - 6;
    const jr = clampNum(col * 0.36, 34, 62);
    const br = clampNum(col * 0.26, 24, 44);
    if (humanCount === 1) {
      layout.controls.push({
        joystick: { x: 0, y: HUD_H, w: col, h: h - HUD_H, cx: col / 2, cy: HUD_H + (h - HUD_H) * 0.6, r: jr },
        buttons: buttonCluster(w - col / 2, HUD_H + (h - HUD_H) * 0.58, br, false, { x: w - col, y: HUD_H, w: col, h: h - HUD_H }),
      });
    } else {
      const usable = h - HUD_H;
      const btnTop = HUD_H + usable * 0.06;
      const btnH = usable * 0.42;
      const joyTop = HUD_H + usable * 0.5;
      const mk = (left) => {
        const cx = left ? col / 2 : w - col / 2;
        const sx = left ? 1 : -1;
        return {
          joystick: { x: left ? 0 : w - col, y: joyTop, w: col, h: h - joyTop, cx, cy: joyTop + (h - joyTop) * 0.55, r: Math.min(jr, (h - joyTop) * 0.36) },
          buttons: buttonCluster(cx, btnTop + btnH * 0.5, Math.min(br, btnH * 0.26), !left, { x: left ? 0 : w - col, y: HUD_H, w: col, h: h - HUD_H }),
        };
      };
      layout.controls.push(mk(true), mk(false));
    }
  } else {
    // Portrait: pitch rotated (world x runs down the screen).
    const strip = clampNum(h * 0.24, 150, 250);
    const jr = clampNum(strip * 0.3, 34, 62);
    const br = clampNum(strip * 0.19, 24, 44);
    const mkStrip = (top, bottom, mirror) => {
      const cy = top + (bottom - top) / 2;
      const jx = mirror ? w * 0.76 : w * 0.24;
      const bx = mirror ? w * 0.27 : w * 0.73;
      const maxR = Math.min(br, (bottom - top) * 0.2, (w * 0.5) * 0.24);
      return {
        joystick: { x: mirror ? w / 2 : 0, y: top, w: w / 2, h: bottom - top, cx: jx, cy, r: Math.min(jr, (bottom - top) * 0.36) },
        buttons: buttonCluster(bx, cy, maxR, mirror, { x: mirror ? 0 : w / 2, y: top, w: w / 2, h: bottom - top }),
      };
    };
    if (humanCount === 1) {
      pitchArea.y = HUD_H;
      pitchArea.h = h - HUD_H - strip;
      layout.controls.push(mkStrip(h - strip, h, false));
    } else if (sameSide) {
      // Co-op: both players sit at the bottom, one strip above the other, so
      // neither of them is looking at the pitch upside down.
      const band = Math.min(strip * 0.86, (h - HUD_H) * 0.33);
      pitchArea.y = HUD_H;
      pitchArea.h = h - HUD_H - band * 2;
      layout.controls.push(mkStrip(h - band, h, false), mkStrip(h - band * 2, h - band, false));
    } else {
      // Versus: the two players face each other across the device.
      const topStrip = strip * 0.92;
      layout.hud = { x: 0, y: topStrip, w, h: HUD_H };
      pitchArea.y = topStrip + HUD_H;
      pitchArea.h = h - strip - topStrip - HUD_H;
      layout.controls.push(mkStrip(h - strip, h, false), mkStrip(0, topStrip, true));
    }
    pitchArea.x = 0;
    pitchArea.w = w;
  }

  // Fit the pitch (plus margin) inside pitchArea preserving aspect.
  const worldW = PITCH.length + 2 * MARGIN_M;
  const worldH = PITCH.width + 2 * MARGIN_M;
  const sw = portrait ? worldH : worldW; // extent along screen x
  const sh = portrait ? worldW : worldH;
  const scale = Math.min(pitchArea.w / sw, pitchArea.h / sh);
  const drawW = sw * scale;
  const drawH = sh * scale;
  const ox = pitchArea.x + (pitchArea.w - drawW) / 2;
  const oy = pitchArea.y + (pitchArea.h - drawH) / 2;
  layout.pitch = { x: ox, y: oy, w: drawW, h: drawH, scale, margin: MARGIN_M };
  layout.pauseBtn = { cx: w - 20, cy: layout.hud.y + HUD_H / 2, r: 15 };

  // Landscape draws the world directly. Portrait rotates it 90 degrees so the
  // pitch runs down the screen: (wx, wy) -> (wy, length - wx). That is a true
  // rotation rather than a reflection, so left/right is not mirrored, and it
  // puts the goal team 0 attacks at the top of the screen.
  layout.worldToScreen = (p) => {
    if (!portrait) return { x: ox + (p.x + MARGIN_M) * scale, y: oy + (p.y + MARGIN_M) * scale };
    return { x: ox + (p.y + MARGIN_M) * scale, y: oy + (PITCH.length - p.x + MARGIN_M) * scale };
  };
  // Inverse of the same rotation, for joystick direction vectors.
  layout.screenDirToWorld = (d) => (portrait ? { x: -d.y, y: d.x } : { x: d.x, y: d.y });
  return layout;
}

function clampNum(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

export function pointInCircle(px, py, c) {
  return (px - c.cx) ** 2 + (py - c.cy) ** 2 <= c.r * c.r;
}

export function pointInRect(px, py, r) {
  return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
}
