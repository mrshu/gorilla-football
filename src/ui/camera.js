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
    if (w !== this.viewport.w || h !== this.viewport.h) this.ballFrame = null;
    this.viewport = { w, h };
    this.recompute();
  }

  setView(eye, target, fovYDeg) {
    this.eye = { ...eye };
    this.target = { ...target };
    if (fovYDeg) this.fovY = (fovYDeg * Math.PI) / 180;
    this.recompute();
  }

  // A gesture uses the projection it started in, even if play or the view
  // changes before its final pointer event is processed.
  clone() {
    const camera = new Camera();
    camera.setViewport(this.viewport.w, this.viewport.h);
    camera.setView(this.eye, this.target, this.fovY * 180 / Math.PI);
    return camera;
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

// The action camera looks across nearby play from the ball's side. Follow
// its full position instead of fitting the entire pitch into a distant view;
// the player on the ball and nearby opponents must remain readable on phones.
export function frameSideline(camera, ballPos, attackDir, portrait) {
  return applyPose(camera, sidelinePose(ballPos, attackDir, portrait));
}

export function sidelinePose(ballPos, attackDir, portrait) {
  const v = portrait ? SIDE.portrait : SIDE.landscape;
  const eye = { x: ballPos.x, y: ballPos.y - v.distance, z: v.height };
  // Aim just above the ball so it sits a little below centre, clear of the
  // scoreboard and bottom-corner touch buttons in either orientation.
  const target = { x: ballPos.x, y: ballPos.y, z: 0.4 };
  return { eye, target, fov: v.fov };
}

// Close in behind the player on the ball, looking at the goal they are
// attacking. The game drops into this once they are in range, so a shot is
// lined up from roughly where the striker is looking.
export function shootingPose(carrier, goal, portrait) {
  const v = portrait ? SHOT.portrait : SHOT.landscape;
  const to = { x: goal.x - carrier.pos.x, y: goal.y - carrier.pos.y };
  const l = Math.hypot(to.x, to.y) || 1;
  const dir = { x: to.x / l, y: to.y / l };
  return {
    eye: {
      x: carrier.pos.x - dir.x * v.behind,
      y: carrier.pos.y - dir.y * v.behind,
      z: v.height,
    },
    target: { x: goal.x, y: goal.y, z: v.aimHeight },
    fov: v.fov,
  };
}

export function isInShootingRange(carrier, goal) {
  const d = Math.hypot(goal.x - carrier.pos.x, goal.y - carrier.pos.y);
  return d < SHOT.range;
}

const SHOT = {
  range: 32, // metres from goal at which the camera drops in behind
  landscape: { behind: 11, height: 4.6, aimHeight: 1.4, fov: 46 },
  portrait: { behind: 13, height: 5.4, aimHeight: 1.4, fov: 62 },
};

export function applyPose(camera, pose) {
  camera.setView(pose.eye, pose.target, pose.fov);
  return camera;
}

// A returning shot camera can still be looking at goal while its eye sweeps
// toward the side of a fast pass. Correct only an unsafe look direction;
// retain the smoothly moving eye and leave first-person framing to its caller.
export function keepBallInFrame(camera, pose, ball, layout, previousFrame = null, dt = 0) {
  if (dt >= 0.9) previousFrame = null;
  const point = { ...ball.pos, z: Math.max(0.22, (ball.z || 0) + 0.22) };
  const minY = Math.min(160, layout.h * 0.48);
  // First-person feet start low in frame. Leave the released ball there
  // until it rises, rather than snapping it upward at the kick itself.
  const maxY = layout.firstPerson ? Math.max(minY, layout.h - 100) : layout.h * 0.7;
  const screen = camera.project(point);
  // While returning from behind the shooter, keep following the ball's
  // existing composition and ease it to the action view's centre. Turning
  // straight toward the sideline target can sweep a released pass away.
  const amount = 1 - Math.exp(-6 * Math.max(0, Math.min(dt, 0.1)));
  const wanted = previousFrame?.visible ? {
    x: previousFrame.x + (layout.w / 2 - previousFrame.x) * amount,
    y: previousFrame.y + (layout.h * 0.52 - previousFrame.y) * amount,
  } : screen;
  const x = wanted.visible === false ? layout.w / 2 : clampNum(wanted.x, layout.w * 0.2, layout.w * 0.8);
  const y = wanted.visible === false ? layout.h / 2 : clampNum(wanted.y, minY, maxY);
  if (screen.visible && x === screen.x && y === screen.y) {
    camera.ballFrame = screen;
    return pose;
  }
  // Solve the smallest yaw/pitch correction that puts the ball exactly on
  // the safe boundary. Unlike iterative target nudges, this is continuous
  // when the ball crosses an edge and introduces no overshoot or target snap.
  const kx = (2 * x / layout.w - 1) * camera.aspect / camera.focal;
  const ky = (1 - 2 * y / layout.h) / camera.focal;
  const toBall = sub3(point, pose.eye);
  const distance = Math.hypot(toBall.x, toBall.y, toBall.z) || 1;
  const elevation = toBall.z / distance;
  const pitch = Math.asin(clampNum(elevation * Math.sqrt(1 + kx * kx + ky * ky)
    / Math.sqrt(1 + ky * ky), -1, 1)) - Math.atan(ky);
  const yaw = Math.atan2(toBall.y, toBall.x) + Math.atan2(kx, Math.cos(pitch) - ky * Math.sin(pitch));
  const reach = Math.hypot(pose.target.x - pose.eye.x, pose.target.y - pose.eye.y, pose.target.z - pose.eye.z) || 1;
  const adjusted = { ...pose, target: {
    x: pose.eye.x + Math.cos(pitch) * Math.cos(yaw) * reach,
    y: pose.eye.y + Math.cos(pitch) * Math.sin(yaw) * reach,
    z: pose.eye.z + Math.sin(pitch) * reach,
  } };
  applyPose(camera, adjusted);
  camera.ballFrame = camera.project(point);
  return adjusted;
}

// Ease between two camera poses, so switching views is a move rather than a cut.
export function blendPose(a, b, t) {
  // Exact at the ends, so a fully blended pose is the pose, not a value a
  // floating-point whisker away from it.
  if (t <= 0) return a;
  if (t >= 1) return b;
  const mix = (p, q) => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t, z: p.z + (q.z - p.z) * t });
  return { eye: mix(a.eye, b.eye), target: mix(a.target, b.target), fov: a.fov + (b.fov - a.fov) * t };
}

// Nearby play replaces the old whole-pitch fit. The ball stays near the
// centre even at pitch edges; screen-size tests check player readability.
const SIDE = {
  landscape: { distance: 20, height: 12, fov: 46 },
  portrait: { distance: 20, height: 12, fov: 64 },
};

// First person: you look out from the player you are playing through, at
// whatever matters right now, which is the ball when it is loose and the way
// you are running when you have it.
//
// The eye sits a little behind and above the head rather than exactly in it.
// From a real pair of eyes the ball at your own feet is about 65 degrees below
// the horizon, so keeping it in frame would mean staring at the grass. Set
// back by a stride you get your own shoulders at the bottom of the picture and
// the ball in front of them, which is what every sports game means by first
// person.
export function frameFirstPerson(camera, player, lookAt, portrait) {
  const rawSize = (player.character && player.character.look && player.character.look.size) || 1;
  // Keep the eye height in the same real-world scale as the rendered rig and
  // regulation goal, while preserving a modest height difference by species.
  const size = 1 + (rawSize - 1) * 0.45;
  const eyeHeight = FIRST_PERSON.eyeHeight * size;
  const f = unit(player.facing, { x: 1, y: 0 });
  const eye = {
    x: player.pos.x - f.x * FIRST_PERSON.behind,
    y: player.pos.y - f.y * FIRST_PERSON.behind,
    z: eyeHeight,
  };
  // Never look at a point so close that the view swings wildly; push the
  // target out to a sensible distance along the direction of interest.
  const to = { x: lookAt.x - eye.x, y: lookAt.y - eye.y };
  const d = Math.hypot(to.x, to.y);
  const dir = d > 0.5 ? { x: to.x / d, y: to.y / d } : f;
  const reach = Math.max(FIRST_PERSON.minLook, Math.min(d, FIRST_PERSON.maxLook));
  const target = {
    x: eye.x + dir.x * reach,
    y: eye.y + dir.y * reach,
    z: FIRST_PERSON.targetHeight,
  };
  camera.setView(eye, target, portrait ? FIRST_PERSON.fovPortrait : FIRST_PERSON.fovLandscape);
  return camera;
}

export const FIRST_PERSON = {
  eyeHeight: 2.05, // metres above the grass, scaled by the character's size
  behind: 3.2, // eye set back a stride so your own feet and the ball show
  minLook: 17, // never focus closer than this, or the view swings about
  maxLook: 34, // or further than this
  targetHeight: 0.6, // just above the grass, so the near ground is not all you see
  fovPortrait: 58,
  fovLandscape: 48,
};

function unit(v, fallback) {
  const l = v ? Math.hypot(v.x, v.y) : 0;
  return l > 1e-6 ? { x: v.x / l, y: v.y / l } : fallback;
}

function clampNum(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
