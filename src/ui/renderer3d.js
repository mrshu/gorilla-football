// Perspective renderer. Everything is drawn by projecting world points
// through the Camera and painting back-to-front, so the match reads as a
// stadium view rather than a diagram. Still plain canvas 2D and still
// generated geometry: no models, no textures, no dependencies.

import { PITCH, STATES } from '../game/constants.js';
import { clamp } from '../game/vec.js';
import { Camera, frameSideline, frameFirstPerson, sidelinePose, shootingPose, isInShootingRange, applyPose, blendPose } from './camera.js';

const SKY_TOP = '#101429';
const SKY_HORIZON = '#2b3158';
const GRASS_A = '#267254';
const GRASS_B = '#1e6049';
const LINE = 'rgba(245,244,233,0.9)';
const STAND = '#171d35';
const CROWD = ['#f5f4e9', '#8b85d9', '#ff6b5f', '#ffd35c', '#63e5ff', '#b6f36b', '#7463ff'];

// Deterministic 0..1 from two small integers: no allocation, no flicker.
function hash2(a, b) {
  const n = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

export class Renderer3D {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.camera = new Camera();
    this.floats = [];
    this.smoothBall = null;
    this.pose = null;
  }

  addFloat(text, world, color = '#fff') {
    this.floats.push({ text, world: { ...world }, life: 1.8, color });
  }

  // Smoothly follow the ball so the camera never snaps.
  updateCamera(match, layout, dt) {
    const target = match.ball.pos;
    if (!this.smoothBall) this.smoothBall = { ...target };
    const k = 1 - Math.exp(-6 * Math.max(0, Math.min(dt, 0.1)));
    this.smoothBall.x += (target.x - this.smoothBall.x) * k;
    this.smoothBall.y += (target.y - this.smoothBall.y) * k;
    this.camera.setViewport(layout.w, layout.h);
    if (layout.firstPerson && layout.eyePlayer) {
      frameFirstPerson(this.camera, layout.eyePlayer, this.smoothLook(layout, dt), layout.portrait);
      this.applySmoothedPose(cameraPose(this.camera), dt);
      this.shotBlend = 0;
      return;
    }
    // Drop in behind the player on the ball once they are in range of goal,
    // easing between the two so it reads as a camera move, not a cut.
    const shooter = layout.shooter;
    const want = shooter ? 1 : 0;
    const rate = 1 - Math.exp(-1.8 * Math.max(0, Math.min(dt, 0.2)));
    this.shotBlend = (this.shotBlend || 0) + (want - (this.shotBlend || 0)) * rate;
    const wide = sidelinePose(this.smoothBall, layout.viewAttackDir, layout.portrait);
    if (this.shotBlend < 0.01 || !layout.shotAnchor) {
      this.applySmoothedPose(wide, dt);
      return;
    }
    const close = shootingPose(layout.shotAnchor.carrier, layout.shotAnchor.goal, layout.portrait);
    this.applySmoothedPose(blendPose(wide, close, this.shotBlend), dt);
  }

  applySmoothedPose(target, dt) {
    if (!this.pose || dt >= 0.9) {
      this.pose = target;
    } else {
      const amount = 1 - Math.exp(-1.65 * Math.max(0, Math.min(dt, 0.2)));
      this.pose = blendPose(this.pose, target, amount);
    }
    applyPose(this.camera, this.pose);
  }

  // Prime the camera so input taken before the first frame is drawn still
  // maps correctly from the screen onto the grass.
  // Ease the point first person is looking at, so the view does not snap
  // every time possession changes.
  smoothLook(layout, dt) {
    const want = layout.lookAt;
    if (!this.smoothedLook) this.smoothedLook = { ...want };
    const k = 1 - Math.exp(-5 * Math.max(0, Math.min(dt, 0.1)));
    this.smoothedLook.x += (want.x - this.smoothedLook.x) * k;
    this.smoothedLook.y += (want.y - this.smoothedLook.y) * k;
    return this.smoothedLook;
  }

  resetCamera(match, layout) {
    this.smoothBall = { ...match.ball.pos };
    this.smoothedLook = layout && layout.lookAt ? { ...layout.lookAt } : null;
    this.pose = null;
    if (layout) this.updateCamera(match, layout, 1);
  }

  draw(match, layout, opts = {}) {
    const ctx = this.ctx;
    this.updateCamera(match, layout, opts.dt || 0);
    ctx.clearRect(0, 0, layout.w, layout.h);
    this.firstPersonView = Boolean(layout.firstPerson);
    this.drawSky(ctx, layout);
    this.drawStands(ctx, layout);
    this.drawPitch(ctx, layout);
    this.drawGoal(ctx, -1);
    this.drawGoal(ctx, 1);
    this.drawActors(ctx, match, layout, opts);
    this.drawAim(ctx, match, layout, opts);
    this.drawFloats(ctx, layout, opts.dt || 0);
  }

  // ------------------------------------------------------------- scenery

  drawSky(ctx, layout) {
    const horizon = this.horizonY();
    const g = ctx.createLinearGradient(0, 0, 0, Math.max(1, horizon));
    g.addColorStop(0, SKY_TOP);
    g.addColorStop(1, SKY_HORIZON);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, layout.w, Math.max(0, horizon));
    // Ground beyond the pitch: darker grass so the playing surface still reads
    // as the brightest thing on screen.
    ctx.fillStyle = '#142f2b';
    ctx.fillRect(0, Math.max(0, horizon), layout.w, layout.h - Math.max(0, horizon));
  }

  // Screen y where the ground plane meets infinity.
  horizonY() {
    const { basis, focal, viewport } = this.camera;
    // A ray parallel to the ground at the camera's forward heading.
    const f = basis.f;
    const flat = { x: f.x, y: f.y, z: 0 };
    const l = Math.hypot(flat.x, flat.y) || 1;
    const dir = { x: flat.x / l, y: flat.y / l, z: 0 };
    const camY = dir.x * basis.u.x + dir.y * basis.u.y + dir.z * basis.u.z;
    const camZ = dir.x * f.x + dir.y * f.y + dir.z * f.z;
    if (camZ <= 1e-6) return -1;
    const ndcY = (camY / camZ) * focal;
    return (1 - ndcY) * 0.5 * viewport.h;
  }

  // Four raked stands around the pitch, drawn before the grass so the playing
  // surface always paints over them. Each is a sloping terrace: a front edge
  // at the trackside and a back edge lifted well above it, which fills the
  // frame above the far touchline instead of leaving bare ground.
  drawStands(ctx, layout) {
    const L = PITCH.length;
    const W = PITCH.width;
    const gap = 5; // track between the touchline and the first row
    const depth = 26; // how far back the terrace runs
    const rise = 17; // height of the back row
    // The side stands overrun the goal lines so the four terraces meet at the
    // corners and the bowl closes up instead of leaving gaps of open ground.
    const over = gap + 26;
    const sides = [
      { inner: [{ x: -over, y: -gap }, { x: L + over, y: -gap }], out: { x: 0, y: -1 }, skipWhenWide: true },
      { inner: [{ x: -over, y: W + gap }, { x: L + over, y: W + gap }], out: { x: 0, y: 1 } },
      { inner: [{ x: -gap, y: -over }, { x: -gap, y: W + over }], out: { x: -1, y: 0 } },
      { inner: [{ x: L + gap, y: -over }, { x: L + gap, y: W + over }], out: { x: 1, y: 0 } },
    ];
    // Each terrace is drawn in segments. A quad is skipped whole if any corner
    // falls behind the camera, so a single long stand running past the lens
    // would vanish entirely; segmenting drops only the part actually behind.
    const SEGMENTS = 10;
    for (const whole of sides) {
      // The broadcast camera sits in the near touchline stand, so it is not
      // drawn there: you never see the stand you are filming from.
      if (whole.skipWhenWide && !this.firstPersonView) continue;
      for (let seg = 0; seg < SEGMENTS; seg++) {
        const t0 = seg / SEGMENTS;
        const t1 = (seg + 1) / SEGMENTS;
        const [wa, wb] = whole.inner;
        const side = {
          out: whole.out,
          inner: [
            { x: wa.x + (wb.x - wa.x) * t0, y: wa.y + (wb.y - wa.y) * t0 },
            { x: wa.x + (wb.x - wa.x) * t1, y: wa.y + (wb.y - wa.y) * t1 },
          ],
        };
        this.drawTerrace(ctx, side, depth, rise);
      }
    }
  }

  drawTerrace(ctx, side, depth, rise) {
    {
      const [a, b] = side.inner;
      const outA = { x: a.x + side.out.x * depth, y: a.y + side.out.y * depth };
      const outB = { x: b.x + side.out.x * depth, y: b.y + side.out.y * depth };
      // Terrace face, sloping up and away.
      this.fillQuad(ctx, [
        { ...a, z: 1.2 },
        { ...b, z: 1.2 },
        { ...outB, z: rise },
        { ...outA, z: rise },
      ], STAND);
      // A lighter band of crowd across the middle of the terrace.
      const midA = { x: a.x + side.out.x * depth * 0.45, y: a.y + side.out.y * depth * 0.45 };
      const midB = { x: b.x + side.out.x * depth * 0.45, y: b.y + side.out.y * depth * 0.45 };
      this.fillQuad(ctx, [
        { ...midA, z: 1.2 + (rise - 1.2) * 0.45 },
        { ...midB, z: 1.2 + (rise - 1.2) * 0.45 },
        { ...outB, z: rise },
        { ...outA, z: rise },
      ], '#2b4354');
      this.drawCrowd(ctx, a, b, side.out, depth, rise);
      // Roof lip so the stand has a hard top edge against the sky.
      this.fillQuad(ctx, [
        { ...outA, z: rise },
        { ...outB, z: rise },
        { ...outB, z: rise + 2.4 },
        { ...outA, z: rise + 2.4 },
      ], '#16212a');
      // Trackside wall.
      this.fillQuad(ctx, [
        { ...a, z: 0 },
        { ...b, z: 0 },
        { ...b, z: 1.2 },
        { ...a, z: 1.2 },
      ], '#101922');
    }
  }

  // Speckle the terrace so it reads as people rather than a painted wall.
  // The pattern is a fixed hash of the seat index, so it never shimmers.
  drawCrowd(ctx, a, b, out, depth, rise) {
    const rows = 7;
    const cols = 46;
    for (let r = 1; r <= rows; r++) {
      const fr = r / (rows + 1);
      const z = 1.4 + (rise - 1.4) * fr;
      const off = depth * fr;
      for (let c = 0; c < cols; c++) {
        const fc = (c + 0.5) / cols;
        const base = {
          x: a.x + (b.x - a.x) * fc + out.x * off,
          y: a.y + (b.y - a.y) * fc + out.y * off,
          z,
        };
        const p = this.camera.project(base);
        if (!p.visible || p.scale < 1.2) continue;
        const h = hash2(c, r);
        if (h > 0.82) continue; // empty seats
        ctx.fillStyle = CROWD[(h * CROWD.length) | 0];
        const s = Math.max(1, p.scale * 0.32);
        ctx.fillRect(p.x - s / 2, p.y - s / 2, s, s);
      }
    }
  }

  drawPitch(ctx, layout) {
    // Mown stripes across the length.
    const stripes = 14;
    for (let i = 0; i < stripes; i++) {
      const x0 = (i / stripes) * PITCH.length;
      const x1 = ((i + 1) / stripes) * PITCH.length;
      this.fillQuad(
        ctx,
        [
          { x: x0, y: -3, z: 0 },
          { x: x1, y: -3, z: 0 },
          { x: x1, y: PITCH.width + 3, z: 0 },
          { x: x0, y: PITCH.width + 3, z: 0 },
        ],
        i % 2 ? GRASS_A : GRASS_B,
      );
    }
    ctx.save();
    ctx.strokeStyle = LINE;
    ctx.lineJoin = 'round';
    const W = PITCH.width;
    const L = PITCH.length;
    const HW = W / 2;
    this.strokePath(ctx, [
      { x: 0, y: 0 }, { x: L, y: 0 }, { x: L, y: W }, { x: 0, y: W }, { x: 0, y: 0 },
    ]);
    this.strokePath(ctx, [{ x: L / 2, y: 0 }, { x: L / 2, y: W }]);
    this.strokeCircle(ctx, { x: L / 2, y: HW }, PITCH.centreCircleRadius);
    for (const side of [-1, 1]) {
      const gx = side < 0 ? 0 : L;
      const inward = side < 0 ? 1 : -1;
      const pa = PITCH.penaltyAreaDepth * inward;
      const ga = PITCH.goalAreaDepth * inward;
      this.strokePath(ctx, [
        { x: gx, y: HW - PITCH.penaltyAreaWidth / 2 },
        { x: gx + pa, y: HW - PITCH.penaltyAreaWidth / 2 },
        { x: gx + pa, y: HW + PITCH.penaltyAreaWidth / 2 },
        { x: gx, y: HW + PITCH.penaltyAreaWidth / 2 },
      ]);
      this.strokePath(ctx, [
        { x: gx, y: HW - PITCH.goalAreaWidth / 2 },
        { x: gx + ga, y: HW - PITCH.goalAreaWidth / 2 },
        { x: gx + ga, y: HW + PITCH.goalAreaWidth / 2 },
        { x: gx, y: HW + PITCH.goalAreaWidth / 2 },
      ]);
      const spot = { x: side < 0 ? PITCH.penaltySpot : L - PITCH.penaltySpot, y: HW };
      this.fillCircleOnGround(ctx, spot, 0.2, LINE);
    }
    this.fillCircleOnGround(ctx, { x: L / 2, y: HW }, 0.2, LINE);
    ctx.restore();
  }

  drawGoal(ctx, side) {
    const x = side < 0 ? 0 : PITCH.length;
    const back = x - side * -PITCH.goalDepth; // behind the line
    const hw = PITCH.goalWidth / 2;
    const hy = PITCH.width / 2;
    const h = PITCH.goalHeight;
    const posts = [
      [{ x, y: hy - hw, z: 0 }, { x, y: hy - hw, z: h }],
      [{ x, y: hy + hw, z: 0 }, { x, y: hy + hw, z: h }],
      [{ x, y: hy - hw, z: h }, { x, y: hy + hw, z: h }],
      [{ x: back, y: hy - hw, z: 0 }, { x: back, y: hy - hw, z: h }],
      [{ x: back, y: hy + hw, z: 0 }, { x: back, y: hy + hw, z: h }],
      [{ x: back, y: hy - hw, z: h }, { x: back, y: hy + hw, z: h }],
      [{ x, y: hy - hw, z: h }, { x: back, y: hy - hw, z: h }],
      [{ x, y: hy + hw, z: h }, { x: back, y: hy + hw, z: h }],
    ];
    // Net as a translucent panel.
    this.fillQuad(
      ctx,
      [
        { x, y: hy - hw, z: h },
        { x, y: hy + hw, z: h },
        { x: back, y: hy + hw, z: h },
        { x: back, y: hy - hw, z: h },
      ],
      'rgba(255,255,255,0.13)',
    );
    this.fillQuad(
      ctx,
      [
        { x: back, y: hy - hw, z: 0 },
        { x: back, y: hy + hw, z: 0 },
        { x: back, y: hy + hw, z: h },
        { x: back, y: hy - hw, z: h },
      ],
      'rgba(255,255,255,0.16)',
    );
    ctx.save();
    ctx.strokeStyle = '#ffffff';
    ctx.lineCap = 'round';
    for (const [a, b] of posts) {
      const pa = this.camera.project(a);
      const pb = this.camera.project(b);
      if (!pa.visible || !pb.visible) continue;
      ctx.lineWidth = Math.max(1.5, 0.12 * ((pa.scale + pb.scale) / 2));
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  // -------------------------------------------------------------- actors

  drawActors(ctx, match, layout, opts) {
    const items = [];
    for (const p of match.players) {
      if (p.sentOff) continue;
      const s = this.camera.project({ x: p.pos.x, y: p.pos.y, z: 0 });
      if (!s.visible) continue;
      items.push({ kind: 'player', depth: s.depth, p, s });
    }
    const b = match.ball;
    const bs = this.camera.project({ x: b.pos.x, y: b.pos.y, z: 0 });
    if (bs.visible) items.push({ kind: 'ball', depth: bs.depth, s: bs });
    items.sort((a, c) => c.depth - a.depth); // far to near
    for (const it of items) {
      if (it.kind === 'player') this.drawPlayer(ctx, it.p, it.s, match, opts);
      else this.drawBall(ctx, match, it.s);
    }
  }

  drawPlayer(ctx, p, s, match, opts) {
    const u = s.scale; // canvas px per world metre at the player's feet
    // Match the WebGL rig's regulation-scale proportions when the browser
    // falls back to the canvas renderer.
    const size = 1 + (p.character.look.size - 1) * 0.45;
    const height = 1.85 * size;
    const halfW = 0.42 * size;
    // Shadow
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.ellipse(s.x, s.y, halfW * 1.25 * u, halfW * 0.5 * u, 0, 0, Math.PI * 2);
    ctx.fill();

    const top = this.camera.project({ x: p.pos.x, y: p.pos.y, z: height });
    const px = s.x;
    const footY = s.y;
    const headY = top.visible ? top.y : s.y - height * u;
    const bodyH = footY - headY;
    const w = Math.max(2, halfW * 2 * u);

    const controlled = opts.controlledIds && opts.controlledIds.has(p.id);
    if (controlled) {
      ctx.strokeStyle = opts.controlColours?.[p.human ?? 0] || '#ffe600';
      ctx.lineWidth = Math.max(1.5, u * 0.09);
      ctx.beginPath();
      ctx.ellipse(px, footY, halfW * 1.7 * u, halfW * 0.7 * u, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (p.frozen > 0 || p.stun > 0) {
      ctx.strokeStyle = p.frozen > 0 ? '#8fe8ff' : 'rgba(255,255,255,0.6)';
      ctx.lineWidth = Math.max(1, u * 0.07);
      ctx.beginPath();
      ctx.ellipse(px, footY, halfW * 1.4 * u, halfW * 0.55 * u, 0, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Legs, torso, head as stacked shapes.
    const legH = bodyH * 0.42;
    const torsoH = bodyH * 0.38;
    const headR = Math.max(1.5, bodyH * 0.11);
    ctx.fillStyle = shade(p.jersey.primary, -0.45);
    ctx.fillRect(px - w * 0.42, footY - legH, w * 0.32, legH);
    ctx.fillRect(px + w * 0.1, footY - legH, w * 0.32, legH);
    ctx.fillStyle = p.jersey.primary;
    roundRect(ctx, px - w / 2, footY - legH - torsoH, w, torsoH, Math.min(w * 0.3, bodyH * 0.1));
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.lineWidth = Math.max(0.7, u * 0.035);
    ctx.stroke();
    ctx.fillStyle = p.character.look.skin;
    ctx.beginPath();
    ctx.arc(px, footY - legH - torsoH - headR * 0.9, headR, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
    ctx.stroke();
    const headX = px;
    const shape = p.character.look.shape;
    ctx.fillStyle = p.character.look.accent;
    if (shape === 'gorilla') {
      ctx.beginPath();
      ctx.arc(headX - headR * 1.15, headY - headR * 0.15, headR * 0.55, 0, Math.PI * 2);
      ctx.arc(headX + headR * 1.15, headY - headR * 0.15, headR * 0.55, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = p.jersey.primary;
      ctx.beginPath();
      ctx.ellipse(px - w * 0.56, footY - legH - torsoH * 0.55, w * 0.36, torsoH * 0.58, 0, 0, Math.PI * 2);
      ctx.ellipse(px + w * 0.56, footY - legH - torsoH * 0.55, w * 0.36, torsoH * 0.58, 0, 0, Math.PI * 2);
      ctx.fill();
    } else if (shape === 'tortoise') {
      ctx.fillStyle = shade(p.character.look.accent, -0.15);
      ctx.beginPath();
      ctx.ellipse(px, footY - legH - torsoH * 0.5, w * 0.7, torsoH * 0.65, 0, 0, Math.PI * 2);
      ctx.fill();
    } else if (shape === 'wizard') {
      ctx.beginPath();
      ctx.moveTo(headX - headR * 1.1, headY - headR * 0.6);
      ctx.lineTo(headX + headR * 1.1, headY - headR * 0.6);
      ctx.lineTo(headX, headY - headR * 2.6);
      ctx.closePath();
      ctx.fill();
    } else if (shape === 'rocket') {
      ctx.fillStyle = p.character.look.accent;
      ctx.beginPath();
      ctx.moveTo(px - w * 0.55, footY - legH - torsoH * 0.25);
      ctx.lineTo(px - w * 0.95, footY - legH - torsoH * 0.05);
      ctx.lineTo(px - w * 0.5, footY - legH - torsoH * 0.52);
      ctx.closePath();
      ctx.fill();
    } else if (shape === 'penguin') {
      ctx.fillStyle = '#f5f4e9';
      ctx.beginPath();
      ctx.ellipse(px, footY - legH - torsoH * 0.54, w * 0.32, torsoH * 0.42, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = p.character.look.accent;
      ctx.beginPath();
      ctx.moveTo(headX, headY + headR * 0.2);
      ctx.lineTo(headX + headR * 1.0, headY + headR * 0.45);
      ctx.lineTo(headX, headY + headR * 0.7);
      ctx.closePath();
      ctx.fill();
    } else if (shape === 'yeti') {
      ctx.fillStyle = '#f5f4e9';
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.arc(headX + side * headR * 0.8, headY - headR * 0.1, headR * 0.75, 0, Math.PI * 2);
        ctx.fill();
      }
    } else {
      ctx.fillStyle = p.character.look.accent;
      ctx.beginPath();
      ctx.ellipse(headX, headY - headR * 0.75, headR * 1.1, headR * 0.38, 0, Math.PI, Math.PI * 2);
      ctx.fill();
    }
    // Number on the shirt, only when big enough to read.
    if (torsoH > 11) {
      ctx.fillStyle = p.jersey.secondary;
      ctx.font = `bold ${Math.round(torsoH * 0.55)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(p.number), px, footY - legH - torsoH * 0.52);
    }
    if (p.yellowCards === 1 && torsoH > 8) {
      ctx.fillStyle = '#ffd600';
      ctx.fillRect(px + w * 0.55, footY - legH - torsoH, Math.max(2, w * 0.2), Math.max(3, torsoH * 0.35));
    }
  }

  drawBall(ctx, match, groundS) {
    const b = match.ball;
    const u = groundS.scale;
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    ctx.ellipse(groundS.x, groundS.y, 0.32 * u, 0.14 * u, 0, 0, Math.PI * 2);
    ctx.fill();
    const air = this.camera.project({ x: b.pos.x, y: b.pos.y, z: b.z + 0.22 });
    if (!air.visible) return;
    const r = Math.max(2, 0.22 * air.scale);
    ctx.fillStyle = b.unstoppable ? '#ffe14d' : '#ffffff';
    ctx.strokeStyle = b.unstoppable ? '#ff6d00' : 'rgba(0,0,0,0.6)';
    ctx.lineWidth = Math.max(0.8, r * 0.22);
    ctx.beginPath();
    ctx.arc(air.x, air.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  // ----------------------------------------------------------- aim guide

  drawAim(ctx, match, layout, opts) {
    const aim = opts.aim;
    if (!aim || !aim.active) return;
    const colour = aim.colour || '#ffe600';
    if (aim.path && aim.path.length >= 2) {
      this.drawDrawnPath(ctx, aim.path, colour);
      this.drawPowerRing(ctx, aim, colour);
      return;
    }
    const from = aim.from;
    const dir = aim.dir;
    const power = clamp(aim.power, 0, 1);
    const reach = 6 + power * 34;
    ctx.save();
    // A tapering guide along the grass.
    const steps = 14;
    for (let i = 0; i < steps; i++) {
      const t0 = i / steps;
      const t1 = (i + 0.62) / steps;
      const a = this.camera.project({ x: from.x + dir.x * reach * t0, y: from.y + dir.y * reach * t0, z: 0.05 });
      const c = this.camera.project({ x: from.x + dir.x * reach * t1, y: from.y + dir.y * reach * t1, z: 0.05 });
      if (!a.visible || !c.visible) continue;
      ctx.strokeStyle = colour;
      ctx.globalAlpha = 0.25 + 0.6 * (1 - t0);
      ctx.lineWidth = Math.max(1.5, a.scale * 0.22 * (1 - t0 * 0.5));
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(c.x, c.y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    const tip = this.camera.project({ x: from.x + dir.x * reach, y: from.y + dir.y * reach, z: 0.05 });
    if (tip.visible) {
      ctx.fillStyle = colour;
      ctx.beginPath();
      ctx.arc(tip.x, tip.y, Math.max(3, tip.scale * 0.35), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    this.drawPowerRing(ctx, aim, colour);
  }

  // The line the finger has traced, laid on the grass. This is literally the
  // route the ball will take, so it is drawn solid and bright with a moving
  // head rather than as a hint.
  drawDrawnPath(ctx, path, colour) {
    const pts = [];
    for (const p of path) {
      const s = this.camera.project({ x: p.x, y: p.y, z: 0.06 });
      if (!s.visible) break;
      pts.push(s);
    }
    if (pts.length < 2) return;
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    // A dark backing stroke so the line reads against any shade of grass.
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.lineWidth = Math.max(5, pts[0].scale * 0.4);
    strokePolyline(ctx, pts);
    ctx.strokeStyle = colour;
    ctx.lineWidth = Math.max(3, pts[0].scale * 0.26);
    strokePolyline(ctx, pts);
    // Head of the line, where the ball will end up.
    const tip = pts[pts.length - 1];
    ctx.fillStyle = colour;
    ctx.beginPath();
    ctx.arc(tip.x, tip.y, Math.max(4, tip.scale * 0.4), 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }

  drawPowerRing(ctx, aim, colour) {
    const power = clamp(aim.power, 0, 1);
    if (aim.screen) {
      const { x, y } = aim.screen;
      const r = 26;
      ctx.save();
      ctx.lineWidth = 5;
      ctx.strokeStyle = 'rgba(255,255,255,0.22)';
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = colour;
      ctx.beginPath();
      ctx.arc(x, y, r, -Math.PI / 2, -Math.PI / 2 + power * Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  // The yellow tick: where the game reckons the ball should go next. Drawn on
  // the overlay so it looks the same under either pitch renderer.
  drawSuggestion(ctx, suggestion, dt) {
    if (!suggestion) return;
    const s = this.camera.project({ x: suggestion.point.x, y: suggestion.point.y, z: 1.4 });
    if (!s.visible) return;
    this.suggestPulse = (this.suggestPulse || 0) + (dt || 0);
    const pulse = 1 + Math.sin(this.suggestPulse * 4) * 0.08;
    const r = Math.max(9, Math.min(26, s.scale * 0.55)) * pulse;
    ctx.save();
    // Soft glow, then the disc.
    const glow = ctx.createRadialGradient(s.x, s.y, r * 0.2, s.x, s.y, r * 1.9);
    glow.addColorStop(0, 'rgba(255,230,60,0.55)');
    glow.addColorStop(1, 'rgba(255,230,60,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(s.x, s.y, r * 1.9, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = suggestion.kind === 'shot' ? '#ff8a3d' : '#ffe33d';
    ctx.beginPath();
    ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.lineWidth = Math.max(1.5, r * 0.1);
    ctx.stroke();
    // A tick inside it.
    ctx.strokeStyle = '#1b1b1b';
    ctx.lineWidth = Math.max(2, r * 0.22);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(s.x - r * 0.42, s.y + r * 0.02);
    ctx.lineTo(s.x - r * 0.1, s.y + r * 0.34);
    ctx.lineTo(s.x + r * 0.45, s.y - r * 0.36);
    ctx.stroke();
    ctx.restore();
  }

  drawFloats(ctx, layout, dt) {
    for (let i = this.floats.length - 1; i >= 0; i--) {
      const f = this.floats[i];
      f.life -= dt;
      if (f.life <= 0) {
        this.floats.splice(i, 1);
        continue;
      }
      const s = this.camera.project({ x: f.world.x, y: f.world.y, z: 2.4 + (1.8 - f.life) * 1.5 });
      if (!s.visible) continue;
      ctx.save();
      ctx.globalAlpha = clamp(f.life, 0, 1);
      ctx.fillStyle = f.color;
      ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      ctx.lineWidth = 3;
      ctx.font = 'bold 18px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.strokeText(f.text, s.x, s.y);
      ctx.fillText(f.text, s.x, s.y);
      ctx.restore();
    }
  }

  // ------------------------------------------------------------- helpers

  fillQuad(ctx, pts, colour) {
    const ps = pts.map((p) => this.camera.project(p));
    if (ps.some((p) => !p.visible)) return;
    ctx.fillStyle = colour;
    ctx.beginPath();
    ctx.moveTo(ps[0].x, ps[0].y);
    for (let i = 1; i < ps.length; i++) ctx.lineTo(ps[i].x, ps[i].y);
    ctx.closePath();
    ctx.fill();
  }

  // Straight pitch lines are drawn in short segments so perspective bends
  // them correctly instead of cutting across the grass.
  strokePath(ctx, pts) {
    for (let i = 0; i + 1 < pts.length; i++) this.strokeSegment(ctx, pts[i], pts[i + 1]);
  }

  strokeSegment(ctx, a, b) {
    const steps = 12;
    let prev = null;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const p = this.camera.project({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: 0 });
      if (!p.visible) {
        prev = null;
        continue;
      }
      if (prev) {
        ctx.lineWidth = Math.max(1, 0.12 * ((prev.scale + p.scale) / 2));
        ctx.beginPath();
        ctx.moveTo(prev.x, prev.y);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
      }
      prev = p;
    }
  }

  strokeCircle(ctx, centre, radius) {
    const steps = 36;
    let prev = null;
    for (let i = 0; i <= steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      const p = this.camera.project({ x: centre.x + Math.cos(a) * radius, y: centre.y + Math.sin(a) * radius, z: 0 });
      if (!p.visible) {
        prev = null;
        continue;
      }
      if (prev) {
        ctx.lineWidth = Math.max(1, 0.12 * ((prev.scale + p.scale) / 2));
        ctx.beginPath();
        ctx.moveTo(prev.x, prev.y);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
      }
      prev = p;
    }
  }

  fillCircleOnGround(ctx, centre, radius, colour) {
    const p = this.camera.project({ ...centre, z: 0 });
    if (!p.visible) return;
    ctx.fillStyle = colour;
    ctx.beginPath();
    ctx.ellipse(p.x, p.y, radius * p.scale, radius * p.scale * 0.4, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function shade(hex, amount) {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) =>
    Math.round(clamp(amount < 0 ? c * (1 + amount) : c + (255 - c) * amount, 0, 255)),
  );
  return `rgb(${ch[0]},${ch[1]},${ch[2]})`;
}

function cameraPose(camera) {
  return {
    eye: { ...camera.eye },
    target: { ...camera.target },
    fov: (camera.fovY * 180) / Math.PI,
  };
}

function strokePolyline(ctx, pts) {
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.stroke();
}
