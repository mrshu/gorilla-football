// Touch input for whole-team play: press and hold to aim, release to play the
// ball. One pointer per human, so two people can share a device.
//
// The drag is read as a direction on the grass through the camera, so pulling
// the finger towards the top of the screen always sends the ball away from
// you, whichever way the camera happens to be facing.

import { AIM } from '../game/constants.js';

// Stroke sampling, in canvas pixels.
const STROKE_MIN_PX = 6;
const STROKE_MAX_POINTS = 240;

export class AimInput {
  constructor(canvas) {
    this.canvas = canvas;
    this.camera = null;
    this.zones = [{ x: 0, y: 0, w: 1, h: 1 }];
    this.drags = new Map(); // humanIndex -> drag state
    this.pointers = new Map(); // pointerId -> humanIndex
    this.pauseRequested = false;
    this.pauseButton = null;
    this.released = []; // drained by the app each frame
    this.bind();
  }

  // `zones` splits the canvas between humans; `pauseButton` is a circle.
  configure({ zones, pauseButton, camera }) {
    if (zones) this.zones = zones;
    if (pauseButton) this.pauseButton = pauseButton;
    if (camera) this.camera = camera;
  }

  bind() {
    const c = this.canvas;
    const opts = { passive: false };
    c.addEventListener('pointerdown', (e) => this.onDown(e), opts);
    c.addEventListener('pointermove', (e) => this.onMove(e), opts);
    c.addEventListener('pointerup', (e) => this.onUp(e), opts);
    c.addEventListener('pointercancel', (e) => this.onUp(e), opts);
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    // Guarded so the module can be imported and unit-tested outside a browser.
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' || e.key.toLowerCase() === 'p') this.pauseRequested = true;
      });
    }
  }

  localPoint(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  zoneFor(p) {
    for (let i = 0; i < this.zones.length; i++) {
      const z = this.zones[i];
      if (p.x >= z.x && p.x <= z.x + z.w && p.y >= z.y && p.y <= z.y + z.h) return i;
    }
    return 0;
  }

  onDown(e) {
    e.preventDefault();
    // Capture keeps a finger that slides off the canvas attached to its drag.
    // It throws for a pointer the browser is not tracking, which is harmless.
    try {
      this.canvas.setPointerCapture?.(e.pointerId);
    } catch {
      /* not a live pointer */
    }
    const p = this.localPoint(e);
    if (this.pauseButton && Math.hypot(p.x - this.pauseButton.cx, p.y - this.pauseButton.cy) <= this.pauseButton.r) {
      this.pauseRequested = true;
      return;
    }
    const human = this.zoneFor(p);
    if (this.drags.has(human)) return; // one finger per player
    this.drags.set(human, { start: p, current: p, moved: 0, stroke: [p] });
    this.pointers.set(e.pointerId, human);
  }

  onMove(e) {
    const human = this.pointers.get(e.pointerId);
    if (human === undefined) return;
    e.preventDefault();
    const p = this.localPoint(e);
    const d = this.drags.get(human);
    if (!d) return;
    d.current = p;
    d.moved = Math.hypot(p.x - d.start.x, p.y - d.start.y);
    // Keep the whole stroke: the drawn shape is the pass, not just its ends.
    const last = d.stroke[d.stroke.length - 1];
    if (Math.hypot(p.x - last.x, p.y - last.y) >= STROKE_MIN_PX && d.stroke.length < STROKE_MAX_POINTS) {
      d.stroke.push(p);
    }
  }

  onUp(e) {
    const human = this.pointers.get(e.pointerId);
    if (human === undefined) return;
    this.pointers.delete(e.pointerId);
    const d = this.drags.get(human);
    this.drags.delete(human);
    if (!d) return;
    this.released.push({ human, ...this.readDrag(d) });
  }

  // Turn a drag into { tap, path, dir, power }. `path` is the stroke projected
  // onto the grass, which is what the ball actually follows; `dir` and `power`
  // are kept as a fallback for when the camera cannot resolve the stroke.
  readDrag(d) {
    const dx = d.current.x - d.start.x;
    const dy = d.current.y - d.start.y;
    const moved = Math.hypot(dx, dy);
    if (moved < AIM.tapPx) return { tap: true, path: null, dir: null, power: 0, screen: d.start };
    const dir = this.camera
      ? this.camera.dragToGround(d.start.x, d.start.y, d.current.x, d.current.y)
      : { x: dx, y: dy };
    const power = Math.min(1, (moved - AIM.tapPx) / (AIM.maxDragPx - AIM.tapPx));
    return { tap: false, path: this.strokeToGround(d), dir, power, screen: d.start };
  }

  // Project every point of the stroke onto the grass. Points above the horizon
  // cannot be resolved, so the path stops there rather than jumping.
  strokeToGround(d) {
    if (!this.camera) return null;
    const pts = (d.stroke || [d.start]).slice();
    const last = pts[pts.length - 1];
    if (!last || Math.hypot(d.current.x - last.x, d.current.y - last.y) > 1) pts.push(d.current);
    const world = [];
    for (const p of pts) {
      const g = this.camera.screenToGround(p.x, p.y);
      if (!g) break;
      world.push({ x: g.x, y: g.y });
    }
    return world.length >= 2 ? world : null;
  }

  // Live aim state for the renderer, per human.
  aimState(human) {
    const d = this.drags.get(human);
    if (!d) return null;
    const read = this.readDrag(d);
    if (read.tap) return { active: false, screen: d.start, power: 0, path: null };
    return { active: true, dir: read.dir, power: read.power, screen: d.start, path: read.path };
  }

  drainReleases() {
    const r = this.released;
    this.released = [];
    return r;
  }

  takePause() {
    const v = this.pauseRequested;
    this.pauseRequested = false;
    return v;
  }

  reset() {
    this.drags.clear();
    this.pointers.clear();
    this.released = [];
    this.pauseRequested = false;
  }
}
