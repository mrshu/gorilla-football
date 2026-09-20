// Touch / mouse / keyboard input. Each human owns one control cluster from
// the layout: a floating joystick zone and three buttons. Multi-touch is
// tracked per pointer id so two people can play at once.

import { pointInCircle, pointInRect } from './layout.js';

export class InputManager {
  constructor(canvas) {
    this.canvas = canvas;
    this.layout = null;
    this.humanCount = 1;
    this.sticks = [];
    this.pressed = {}; // `${human}:${id}` -> true while held
    this.justPressed = {}; // consumed each frame
    this.pauseRequested = false;
    this.keys = new Set();
    this.pointers = new Map(); // pointerId -> {kind:'stick'|'button', human, id}
    this.bind();
  }

  setLayout(layout) {
    this.layout = layout;
    if (this.sticks.length !== layout.controls.length) {
      this.sticks = layout.controls.map(() => ({ active: false, dx: 0, dy: 0, originX: 0, originY: 0 }));
    }
    // Re-anchor every stick into its (possibly resized) zone. A stick held
    // across an orientation change would otherwise keep an origin that is no
    // longer inside its control area.
    this.sticks.forEach((s, i) => {
      const j = layout.controls[i].joystick;
      if (!s.active) {
        s.originX = j.cx;
        s.originY = j.cy;
        return;
      }
      s.originX = Math.min(Math.max(s.originX, j.x + j.r), j.x + j.w - j.r);
      s.originY = Math.min(Math.max(s.originY, j.y + j.r), j.y + j.h - j.r);
    });
  }

  bind() {
    const c = this.canvas;
    const opts = { passive: false };
    c.addEventListener('pointerdown', (e) => this.onDown(e), opts);
    c.addEventListener('pointermove', (e) => this.onMove(e), opts);
    c.addEventListener('pointerup', (e) => this.onUp(e), opts);
    c.addEventListener('pointercancel', (e) => this.onUp(e), opts);
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => this.onKey(e, true));
    window.addEventListener('keyup', (e) => this.onKey(e, false));
  }

  localPoint(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) * (this.canvas.width / r.width / (window.devicePixelRatio || 1)), y: (e.clientY - r.top) * (this.canvas.height / r.height / (window.devicePixelRatio || 1)) };
  }

  onDown(e) {
    if (!this.layout) return;
    e.preventDefault();
    this.canvas.setPointerCapture?.(e.pointerId);
    const p = this.localPoint(e);
    if (pointInCircle(p.x, p.y, this.layout.pauseBtn)) {
      this.pauseRequested = true;
      return;
    }
    for (let i = 0; i < this.layout.controls.length; i++) {
      const c = this.layout.controls[i];
      for (const b of c.buttons) {
        if (pointInCircle(p.x, p.y, b)) {
          const key = `${i}:${b.id}`;
          this.pressed[key] = true;
          this.justPressed[key] = true;
          this.pointers.set(e.pointerId, { kind: 'button', human: i, id: b.id });
          return;
        }
      }
    }
    for (let i = 0; i < this.layout.controls.length; i++) {
      const j = this.layout.controls[i].joystick;
      if (pointInRect(p.x, p.y, j)) {
        const s = this.sticks[i];
        s.active = true;
        s.originX = p.x;
        s.originY = p.y;
        s.dx = 0;
        s.dy = 0;
        this.pointers.set(e.pointerId, { kind: 'stick', human: i });
        return;
      }
    }
  }

  onMove(e) {
    const rec = this.pointers.get(e.pointerId);
    if (!rec || rec.kind !== 'stick') return;
    e.preventDefault();
    const p = this.localPoint(e);
    const s = this.sticks[rec.human];
    const j = this.layout.controls[rec.human].joystick;
    let dx = (p.x - s.originX) / j.r;
    let dy = (p.y - s.originY) / j.r;
    const l = Math.hypot(dx, dy);
    if (l > 1) {
      dx /= l;
      dy /= l;
    }
    s.dx = dx;
    s.dy = dy;
  }

  onUp(e) {
    const rec = this.pointers.get(e.pointerId);
    if (!rec) return;
    this.pointers.delete(e.pointerId);
    if (rec.kind === 'stick') {
      const s = this.sticks[rec.human];
      s.active = false;
      s.dx = 0;
      s.dy = 0;
      const j = this.layout.controls[rec.human].joystick;
      s.originX = j.cx;
      s.originY = j.cy;
    } else {
      delete this.pressed[`${rec.human}:${rec.id}`];
    }
  }

  // Keyboard fallback for desktop testing.
  // P1: WASD + J/K/L, P2: arrows + numpad 1/2/3, Esc pauses.
  onKey(e, down) {
    const k = e.key.toLowerCase();
    if (down) this.keys.add(k);
    else this.keys.delete(k);
    if (down && (k === 'escape' || k === 'p')) this.pauseRequested = true;
    const map = {
      j: '0:pass', k: '0:shoot', l: '0:special',
      '1': '1:pass', '2': '1:shoot', '3': '1:special',
    };
    if (map[k]) {
      if (down && !this.pressed[map[k]]) this.justPressed[map[k]] = true;
      if (down) this.pressed[map[k]] = true;
      else delete this.pressed[map[k]];
    }
    if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(k)) e.preventDefault();
  }

  keyboardVector(human) {
    const k = this.keys;
    let x = 0;
    let y = 0;
    if (human === 0) {
      if (k.has('a')) x -= 1;
      if (k.has('d')) x += 1;
      if (k.has('w')) y -= 1;
      if (k.has('s')) y += 1;
    } else {
      if (k.has('arrowleft')) x -= 1;
      if (k.has('arrowright')) x += 1;
      if (k.has('arrowup')) y -= 1;
      if (k.has('arrowdown')) y += 1;
    }
    return { x, y };
  }

  // Returns {move:{x,y} in world space, pass, shoot, special} for a human.
  readHuman(i) {
    const s = this.sticks[i] || { dx: 0, dy: 0 };
    const kb = this.keyboardVector(i);
    let sx = s.dx + kb.x;
    let sy = s.dy + kb.y;
    const l = Math.hypot(sx, sy);
    if (l > 1) {
      sx /= l;
      sy /= l;
    }
    const move = this.layout ? this.layout.screenDirToWorld({ x: sx, y: sy }) : { x: sx, y: sy };
    const take = (id) => {
      const key = `${i}:${id}`;
      const v = Boolean(this.justPressed[key]);
      return v;
    };
    return { move, pass: take('pass'), shoot: take('shoot'), special: take('special') };
  }

  endFrame() {
    this.justPressed = {};
  }

  takePause() {
    const v = this.pauseRequested;
    this.pauseRequested = false;
    return v;
  }

  reset() {
    this.pressed = {};
    this.justPressed = {};
    this.pointers.clear();
    this.pauseRequested = false;
    this.sticks.forEach((s) => {
      s.active = false;
      s.dx = 0;
      s.dy = 0;
    });
  }
}
