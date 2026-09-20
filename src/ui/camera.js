// A small perspective camera. The simulation is a flat world in metres:
// x runs along the pitch length, y across its width, z is height above the
// grass. This projects that world onto the canvas so the match is seen from
// a raised stadium camera rather than straight down.
//
// No dependencies and no matrices: a look-at basis plus a divide by depth is
// all a single fixed camera needs.

import { PITCH } from '../game/constants.js';

const NEAR = 0.6;

const sub3 = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const add3 = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const mul3 = (a, s) => ({ x: a.x * s, y: a.y * s, z: a.z * s });
const dot3 = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross3 = (a, b) => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
const norm3 = (a) => {
  const l = Math.hypot(a.x, a.y, a.z) || 1;
  return { x: a.x / l, y: a.y / l, z: a.z / l };
};

export class Camera {
  constructor() {
    this.eye = { x: -30, y: PITCH.width / 2, z: 24 };
    this.target = { x: PITCH.length / 2, y: PITCH.width / 2, z: 0 };
    this.fovY = (48 * Math.PI) / 180;
    this.viewport = { w: 1, h: 1 };
    this.recompute();
  }

  setViewport(w, h) {
    this.viewport = { w, h };
    this.recompute();
  }

  setView(eye, target, fovYDeg) {
    this.eye = { ...eye };
    this.target = { ...target };
    if (fovYDeg) this.fovY = (fovYDeg * Math.PI) / 180;
    this.recompute();
  }

  recompute() {
    const f = norm3(sub3(this.target, this.eye));
    // World up is +z. Guard against a perfectly vertical camera.
    const worldUp = Math.abs(f.z) > 0.999 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 0, z: 1 };
    const r = norm3(cross3(f, worldUp));
    const u = cross3(r, f);
    this.basis = { f, r, u };
    this.focal = 1 / Math.tan(this.fovY / 2);
    this.aspect = this.viewport.w / Math.max(1, this.viewport.h);
  }

  // World point -> { x, y (canvas px), depth (m in front of the camera),
  // scale (canvas px per world metre at that depth), visible }.
  project(p) {
    const v = sub3(p, this.eye);
    const { f, r, u } = this.basis;
    const depth = dot3(v, f);
    const half = this.viewport.h / 2;
    if (depth <= NEAR) {
      return { x: 0, y: 0, depth, scale: 0, visible: false };
    }
    const camX = dot3(v, r);
    const camY = dot3(v, u);
    const ndcX = (camX / depth) * (this.focal / this.aspect);
    const ndcY = (camY / depth) * this.focal;
    return {
      x: (1 + ndcX) * 0.5 * this.viewport.w,
      y: (1 - ndcY) * 0.5 * this.viewport.h,
      depth,
      scale: (this.focal / depth) * half,
      visible: true,
    };
  }

  // Ray through a canvas pixel, in world space.
  ray(sx, sy) {
    const ndcX = (sx / this.viewport.w) * 2 - 1;
    const ndcY = 1 - (sy / this.viewport.h) * 2;
    const { f, r, u } = this.basis;
    const dir = norm3(
      add3(add3(mul3(r, (ndcX * this.aspect) / this.focal), mul3(u, ndcY / this.focal)), f),
    );
    return { origin: { ...this.eye }, dir };
  }

  // Where a canvas pixel lands on the grass (z = 0). Null when the ray points
  // at or above the horizon.
  screenToGround(sx, sy) {
    const { origin, dir } = this.ray(sx, sy);
    if (dir.z >= -1e-6) return null;
    const t = -origin.z / dir.z;
    if (t <= 0) return null;
    return { x: origin.x + dir.x * t, y: origin.y + dir.y * t, z: 0 };
  }

  // The ground direction a screen-space drag corresponds to. Both endpoints
  // are unprojected onto the grass, so dragging "up the screen" always means
  // "away from the camera" no matter where the camera is pointing.
  // Falls back to the camera's own forward/right basis near the horizon.
  dragToGround(fromX, fromY, toX, toY) {
    const a = this.screenToGround(fromX, fromY);
    const b = this.screenToGround(toX, toY);
    if (a && b) {
      const d = { x: b.x - a.x, y: b.y - a.y };
      const l = Math.hypot(d.x, d.y);
      if (l > 1e-6) return { x: d.x / l, y: d.y / l };
    }
    const { f, r } = this.basis;
    const fwd = { x: f.x, y: f.y };
    const right = { x: r.x, y: r.y };
    const fl = Math.hypot(fwd.x, fwd.y) || 1;
    const rl = Math.hypot(right.x, right.y) || 1;
    const dx = (toX - fromX) / rl;
    const dy = -(toY - fromY) / fl;
    const v = { x: right.x * dx + fwd.x * dy, y: right.y * dx + fwd.y * dy };
    const l = Math.hypot(v.x, v.y) || 1;
    return { x: v.x / l, y: v.y / l };
  }
}

// A broadcast camera that sits behind the play and looks towards the goal the
// viewing team is attacking, so "forward" on screen is always forward on the
// pitch. `attackDir` is +1 when that team attacks x = PITCH.length.
export function frameBall(camera, ballPos, attackDir, portrait) {
  const v = portrait ? FRAME.portrait : FRAME.landscape;
  const cy = PITCH.width / 2;
  const bx = ballPos.x;
  const by = ballPos.y;
  // The camera sits behind the ball and looks past it towards the goal being
  // attacked. It tracks the ball sideways less than fully, which keeps the
  // horizon steady without ever letting the ball slide out of frame.
  const eye = {
    x: bx - v.back * attackDir,
    y: cy + (by - cy) * v.eyeTrack,
    z: v.height,
  };
  const target = {
    x: bx + v.lookAhead * attackDir,
    y: cy + (by - cy) * v.targetTrack,
    z: 0,
  };
  camera.setView(eye, target, v.fov);
  return camera;
}

// Tuned so the ball stays comfortably on screen from any point on the pitch;
// `test/camera.test.js` checks that across a grid of ball positions.
// `eyeTrack` and `targetTrack` being close keeps the camera's axis nearly
// parallel to the pitch, so the touchlines stay square on screen instead of
// swinging about as the ball moves across. A small difference is left in for
// a bit of life.
const FRAME = {
  portrait: { back: 58, lookAhead: 32, height: 34, fov: 56, eyeTrack: 0.6, targetTrack: 0.7 },
  landscape: { back: 58, lookAhead: 32, height: 34, fov: 46, eyeTrack: 0.6, targetTrack: 0.7 },
};

function clampNum(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
