// Canvas renderer. Draws the pitch, players (generated vector shapes),
// ball, HUD and touch controls. Purely a function of match + layout
// state so it can be swapped for sprite art later.

import { PITCH, STATES } from '../game/constants.js';
import { clamp } from '../game/vec.js';

const GRASS_A = '#267254';
const GRASS_B = '#1e6049';
const LINE = 'rgba(245,244,233,0.86)';

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.floats = []; // floating texts {text, x, y, life, color}
  }

  addFloat(text, world, color = '#fff') {
    this.floats.push({ text, world: { ...world }, life: 1.6, color });
  }

  draw(match, layout, opts = {}) {
    const ctx = this.ctx;
    const { w, h } = layout;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#101429';
    ctx.fillRect(0, 0, w, h);
    this.drawPitch(ctx, layout);
    this.drawEntities(ctx, match, layout, opts);
    this.drawFloats(ctx, layout, opts.dt || 0);
    this.drawHud(ctx, match, layout, opts);
    this.drawControls(ctx, layout, opts);
    this.drawBanner(ctx, match, layout, opts);
  }

  // ------------------------------------------------------------ pitch

  drawPitch(ctx, layout) {
    const L = layout;
    const s = L.pitch.scale;
    const W = (p) => L.worldToScreen(p);
    // Grass with mowing stripes along the length.
    const stripes = 12;
    for (let i = 0; i < stripes; i++) {
      const x0 = (i / stripes) * PITCH.length;
      const x1 = ((i + 1) / stripes) * PITCH.length;
      const a = W({ x: x0, y: 0 });
      const b = W({ x: x1, y: PITCH.width });
      ctx.fillStyle = i % 2 ? GRASS_A : GRASS_B;
      ctx.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    }
    // Surrounding margin
    ctx.strokeStyle = 'rgba(255,211,92,0.2)';
    ctx.lineWidth = 1;
    ctx.strokeRect(L.pitch.x, L.pitch.y, L.pitch.w, L.pitch.h);

    ctx.strokeStyle = LINE;
    ctx.lineWidth = Math.max(1.4, s * 0.12);
    const rect = (x0, y0, x1, y1) => {
      const a = W({ x: x0, y: y0 });
      const b = W({ x: x1, y: y1 });
      ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    };
    rect(0, 0, PITCH.length, PITCH.width);
    // Halfway line
    const m1 = W({ x: PITCH.length / 2, y: 0 });
    const m2 = W({ x: PITCH.length / 2, y: PITCH.width });
    ctx.beginPath();
    ctx.moveTo(m1.x, m1.y);
    ctx.lineTo(m2.x, m2.y);
    ctx.stroke();
    // Centre circle + spot
    const c = W({ x: PITCH.length / 2, y: PITCH.width / 2 });
    ctx.beginPath();
    ctx.arc(c.x, c.y, PITCH.centreCircleRadius * s, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = LINE;
    ctx.beginPath();
    ctx.arc(c.x, c.y, Math.max(1.5, s * 0.18), 0, Math.PI * 2);
    ctx.fill();

    for (const side of [-1, 1]) {
      const gx = side < 0 ? 0 : PITCH.length;
      const inward = side < 0 ? 1 : -1;
      rect(gx, PITCH.width / 2 - PITCH.penaltyAreaWidth / 2, gx + inward * PITCH.penaltyAreaDepth, PITCH.width / 2 + PITCH.penaltyAreaWidth / 2);
      rect(gx, PITCH.width / 2 - PITCH.goalAreaWidth / 2, gx + inward * PITCH.goalAreaDepth, PITCH.width / 2 + PITCH.goalAreaWidth / 2);
      // Penalty spot
      const ps = W({ x: side < 0 ? PITCH.penaltySpot : PITCH.length - PITCH.penaltySpot, y: PITCH.width / 2 });
      ctx.beginPath();
      ctx.arc(ps.x, ps.y, Math.max(1.5, s * 0.16), 0, Math.PI * 2);
      ctx.fill();
      // Goal
      const g1 = W({ x: gx, y: PITCH.width / 2 - PITCH.goalWidth / 2 });
      const g2 = W({ x: gx - inward * PITCH.goalDepth, y: PITCH.width / 2 + PITCH.goalWidth / 2 });
      ctx.save();
      ctx.fillStyle = 'rgba(255,255,255,0.22)';
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = Math.max(2, s * 0.16);
      ctx.fillRect(Math.min(g1.x, g2.x), Math.min(g1.y, g2.y), Math.abs(g2.x - g1.x), Math.abs(g2.y - g1.y));
      ctx.strokeRect(Math.min(g1.x, g2.x), Math.min(g1.y, g2.y), Math.abs(g2.x - g1.x), Math.abs(g2.y - g1.y));
      ctx.restore();
      // Corner arcs
      for (const cy of [0, PITCH.width]) {
        const p = W({ x: gx, y: cy });
        ctx.beginPath();
        ctx.arc(p.x, p.y, PITCH.cornerArcRadius * s, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  // ---------------------------------------------------------- entities

  drawEntities(ctx, match, layout, opts) {
    const s = layout.pitch.scale;
    const W = layout.worldToScreen;
    // Shadows first
    for (const p of match.players) {
      if (p.sentOff) continue;
      const sp = W(p.pos);
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.beginPath();
      ctx.ellipse(sp.x, sp.y + s * 0.25, s * 0.55 * p.character.look.size, s * 0.3 * p.character.look.size, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    if (opts.decision) this.drawDecisionCues(ctx, match, layout, opts.decision);
    for (const p of match.players) {
      if (p.sentOff) continue;
      this.drawPlayer(ctx, p, layout, opts);
    }
    this.drawBall(ctx, match, layout);
  }


  // While the match is frozen for a decision, show where each pass would go
  // and where a shot would be aimed, so the choice is readable on the pitch.
  drawDecisionCues(ctx, match, layout, decision) {
    const s = layout.pitch.scale;
    const from = layout.worldToScreen(match.getPlayer(decision.playerId).pos);
    const colour = decision.humanIndex === 0 ? 'rgba(255,230,0,' : 'rgba(0,229,255,';
    ctx.save();
    ctx.lineWidth = Math.max(2, s * 0.14);
    for (const o of decision.options) {
      if (o.id === 'pass') {
        const to = layout.worldToScreen(match.getPlayer(o.targetId).pos);
        ctx.strokeStyle = colour + (o.quality === 'good' ? '0.85)' : o.quality === 'poor' ? '0.3)' : '0.6)');
        ctx.setLineDash([Math.max(5, s * 0.5), Math.max(4, s * 0.4)]);
        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(to.x, to.y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = colour + '0.9)';
        ctx.beginPath();
        ctx.arc(to.x, to.y, s * 0.9, 0, Math.PI * 2);
        ctx.stroke();
      } else if (o.id === 'shoot') {
        const goal = layout.worldToScreen(match.goalTargetFor(match.getPlayer(decision.playerId)));
        ctx.strokeStyle = 'rgba(255,120,60,0.7)';
        ctx.setLineDash([Math.max(7, s * 0.7), Math.max(4, s * 0.4)]);
        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(goal.x, goal.y);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    ctx.restore();
  }

  drawPlayer(ctx, p, layout, opts) {
    const s = layout.pitch.scale;
    const sp = layout.worldToScreen(p.pos);
    const size = s * 0.7 * p.character.look.size;
    const look = p.character.look;
    ctx.save();
    ctx.translate(sp.x, sp.y);

    // Human highlight ring
    if (p.human !== null && p.human !== undefined) {
      const col = p.human === 0 ? '#ffe600' : '#00e5ff';
      ctx.strokeStyle = col;
      ctx.lineWidth = Math.max(2, s * 0.14);
      ctx.beginPath();
      ctx.arc(0, 0, size * 1.45, 0, Math.PI * 2);
      ctx.stroke();
      // Small pointer above
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.moveTo(0, -size * 2.5);
      ctx.lineTo(-size * 0.5, -size * 1.8);
      ctx.lineTo(size * 0.5, -size * 1.8);
      ctx.closePath();
      ctx.fill();
    }
    if (p.frozen > 0) {
      ctx.strokeStyle = '#8fe8ff';
      ctx.lineWidth = Math.max(2, s * 0.12);
      ctx.beginPath();
      ctx.arc(0, 0, size * 1.3, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (p.untackleable > 0 || p.speedBoost > 0) {
      ctx.strokeStyle = 'rgba(255,220,80,0.85)';
      ctx.lineWidth = Math.max(1.5, s * 0.1);
      ctx.beginPath();
      ctx.arc(0, 0, size * 1.25, 0, Math.PI * 2);
      ctx.stroke();
    }

    const ang = Math.atan2(p.facing.y, p.facing.x);
    const dir = layout.portrait ? ang - Math.PI / 2 : ang;

    // Body
    ctx.fillStyle = p.jersey.primary;
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.lineWidth = Math.max(1.6, s * 0.12);
    if (p.sliding > 0) {
      ctx.save();
      ctx.rotate(dir);
      ctx.beginPath();
      ctx.ellipse(0, 0, size * 1.5, size * 0.7, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    } else {
      ctx.beginPath();
      ctx.arc(0, 0, size, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    // Head / character-specific silhouette
    ctx.fillStyle = look.skin;
    const hx = Math.cos(dir) * size * 0.45;
    const hy = Math.sin(dir) * size * 0.45;
    switch (look.shape) {
      case 'gorilla':
        ctx.beginPath();
        ctx.arc(hx, hy, size * 0.62, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = look.accent;
        ctx.beginPath();
        ctx.arc(hx - size * 0.55, hy - size * 0.5, size * 0.25, 0, Math.PI * 2);
        ctx.arc(hx + size * 0.55, hy - size * 0.5, size * 0.25, 0, Math.PI * 2);
        ctx.fill();
        break;
      case 'tortoise':
        ctx.beginPath();
        ctx.arc(hx, hy, size * 0.45, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = look.accent;
        ctx.lineWidth = Math.max(1, s * 0.09);
        ctx.beginPath();
        ctx.arc(0, 0, size * 0.62, 0, Math.PI * 2);
        ctx.stroke();
        break;
      case 'wizard':
        ctx.beginPath();
        ctx.arc(hx, hy, size * 0.42, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = look.accent;
        ctx.beginPath();
        ctx.moveTo(hx - size * 0.5, hy - size * 0.1);
        ctx.lineTo(hx + size * 0.5, hy - size * 0.1);
        ctx.lineTo(hx, hy - size * 1.3);
        ctx.closePath();
        ctx.fill();
        break;
      case 'rocket':
        ctx.beginPath();
        ctx.moveTo(hx + Math.cos(dir) * size * 0.8, hy + Math.sin(dir) * size * 0.8);
        ctx.lineTo(hx + Math.cos(dir + 2.4) * size * 0.6, hy + Math.sin(dir + 2.4) * size * 0.6);
        ctx.lineTo(hx + Math.cos(dir - 2.4) * size * 0.6, hy + Math.sin(dir - 2.4) * size * 0.6);
        ctx.closePath();
        ctx.fill();
        break;
      case 'penguin':
        ctx.beginPath();
        ctx.arc(hx, hy, size * 0.45, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = look.accent;
        ctx.beginPath();
        ctx.moveTo(hx + Math.cos(dir) * size * 0.75, hy + Math.sin(dir) * size * 0.75);
        ctx.lineTo(hx + Math.cos(dir + 0.5) * size * 0.4, hy + Math.sin(dir + 0.5) * size * 0.4);
        ctx.lineTo(hx + Math.cos(dir - 0.5) * size * 0.4, hy + Math.sin(dir - 0.5) * size * 0.4);
        ctx.closePath();
        ctx.fill();
        break;
      case 'yeti':
        ctx.beginPath();
        ctx.arc(hx, hy, size * 0.6, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = look.accent;
        ctx.fillRect(hx - size * 0.5, hy - size * 0.12, size, size * 0.2);
        break;
      default:
        ctx.beginPath();
        ctx.arc(hx, hy, size * 0.48, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = look.accent;
        ctx.beginPath();
        ctx.arc(hx, hy - size * 0.35, size * 0.42, Math.PI, 0);
        ctx.fill();
        break;
    }
    // Number
    ctx.fillStyle = p.jersey.secondary;
    ctx.font = `bold ${Math.max(7, size * 0.95)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(p.number), -Math.cos(dir) * size * 0.3, -Math.sin(dir) * size * 0.3);

    if (p.yellowCards === 1) {
      ctx.fillStyle = '#ffd600';
      ctx.fillRect(size * 0.8, -size * 1.4, size * 0.4, size * 0.6);
    }
    ctx.restore();
  }

  drawBall(ctx, match, layout) {
    const s = layout.pitch.scale;
    const b = match.ball;
    const sp = layout.worldToScreen(b.pos);
    const lift = b.z * s * 0.8;
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.ellipse(sp.x, sp.y, s * 0.3, s * 0.18, 0, 0, Math.PI * 2);
    ctx.fill();
    const r = Math.max(2.5, s * (0.28 + b.z * 0.02));
    ctx.save();
    ctx.translate(sp.x, sp.y - lift);
    ctx.fillStyle = b.unstoppable ? '#ffe14d' : '#ffffff';
    ctx.strokeStyle = b.unstoppable ? '#ff6d00' : '#222';
    ctx.lineWidth = Math.max(1, s * 0.06);
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    if (b.unstoppable) {
      ctx.strokeStyle = 'rgba(255,120,0,0.8)';
      ctx.lineWidth = Math.max(1.5, s * 0.1);
      ctx.beginPath();
      ctx.arc(0, 0, r * 2.1, 0, Math.PI * 2);
      ctx.stroke();
    }
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
      const p = layout.worldToScreen(f.world);
      ctx.save();
      ctx.globalAlpha = clamp(f.life, 0, 1);
      ctx.fillStyle = f.color;
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.lineWidth = 3;
      ctx.font = 'bold 17px system-ui, sans-serif';
      ctx.textAlign = 'center';
      // Keep floating text inside the pitch area so it never sits over the HUD.
      const rise = 26 + (1.6 - f.life) * 16;
      const y = Math.max(layout.pitch.y + 18, p.y - rise);
      ctx.strokeText(f.text, p.x, y);
      ctx.fillText(f.text, p.x, y);
      ctx.restore();
    }
  }

  // --------------------------------------------------------------- HUD

  drawHud(ctx, match, layout, opts) {
    const hud = layout.hud;
    ctx.save();
    ctx.fillStyle = 'rgba(9,11,24,0.88)';
    ctx.fillRect(hud.x, hud.y, hud.w, hud.h);
    const cy = hud.y + hud.h / 2;
    const t0 = match.teams[0];
    const t1 = match.teams[1];
    ctx.textBaseline = 'middle';
    // Team 0 badge
    ctx.fillStyle = t0.jersey.primary;
    ctx.fillRect(10, cy - 11, 16, 22);
    ctx.fillStyle = t1.jersey.primary;
    ctx.fillRect(hud.w - 46, cy - 11, 16, 22);
    ctx.fillStyle = '#f5f4e9';
    ctx.font = 'bold 21px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffd35c';
    ctx.fillText(`${t0.score} - ${t1.score}`, hud.w / 2, cy - 4);
    ctx.font = '600 12px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(245,244,233,0.72)';
    ctx.fillText(`${match.clockLabel()}  ·  H${match.clock.half}`, hud.w / 2, cy + 13);
    // Team names, clipped so they never reach the score or the pause button.
    const nameW = Math.max(40, hud.w / 2 - 92);
    ctx.font = '600 12px system-ui, sans-serif';
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'left';
    ctx.fillText(t0.name, 32, cy, nameW);
    ctx.textAlign = 'right';
    ctx.fillText(t1.name, hud.w - 50, cy, nameW);

    // Human ability status chips
    ctx.textAlign = 'left';
    let cx = 10;
    const chipY = hud.y + hud.h + 4;
    for (let i = 0; i < match.humanInputs.length; i++) {
      const p = match.humanPlayer(i);
      if (!p) continue;
      const col = i === 0 ? '#ffe600' : '#00e5ff';
      const uses = Number.isFinite(p.ability.usesLeft) ? `${p.ability.usesLeft}` : '∞';
      const ready = p.ability.cooldown <= 0 && p.ability.usesLeft > 0;
      const label = `P${i + 1} ${p.character.name} · ${uses}${ready ? '' : ' …'}`;
      ctx.font = '600 11px system-ui, sans-serif';
      const w = ctx.measureText(label).width + 12;
      const x = i === 0 ? 8 : layout.w - w - 8;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      roundRect(ctx, x, chipY, w, 18, 6);
      ctx.fill();
      ctx.fillStyle = ready ? col : 'rgba(255,255,255,0.5)';
      ctx.fillText(label, x + 6, chipY + 9);
    }

    // Cards ticker
    if (match.cards.length) {
      const txt = match.cards.slice(-3).map((c) => `${c.card === 'red' ? '🟥' : '🟨'} #${match.getPlayer(c.playerId).number}`).join('  ');
      ctx.textAlign = 'center';
      ctx.font = '600 11px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      ctx.fillText(txt, layout.w / 2, chipY + 9);
    }

    // Pause button
    const pb = layout.pauseBtn;
    ctx.fillStyle = 'rgba(116,99,255,0.6)';
    ctx.beginPath();
    ctx.arc(pb.cx, pb.cy, pb.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.fillRect(pb.cx - 5, pb.cy - 6, 3.5, 12);
    ctx.fillRect(pb.cx + 1.5, pb.cy - 6, 3.5, 12);
    ctx.restore();
  }

  drawControls(ctx, layout, opts) {
    const sticks = opts.sticks || [];
    ctx.save();
    if (opts.decision) ctx.globalAlpha = 0.25;
    layout.controls.forEach((c, i) => {
      const col = i === 0 ? 'rgba(255,230,0,' : 'rgba(0,229,255,';
      const j = c.joystick;
      const st = sticks[i];
      const base = st && st.active ? { x: st.originX, y: st.originY } : { x: j.cx, y: j.cy };
      ctx.strokeStyle = col + '0.4)';
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(base.x, base.y, j.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      const knob = st && st.active ? { x: base.x + st.dx * j.r, y: base.y + st.dy * j.r } : base;
      ctx.fillStyle = col + '0.55)';
      ctx.beginPath();
      ctx.arc(knob.x, knob.y, j.r * 0.4, 0, Math.PI * 2);
      ctx.fill();

      for (const b of c.buttons) {
        const pressed = opts.pressed && opts.pressed[`${i}:${b.id}`];
        ctx.beginPath();
        ctx.arc(b.cx, b.cy, b.r, 0, Math.PI * 2);
        ctx.fillStyle = pressed ? col + '0.75)' : 'rgba(255,255,255,0.13)';
        ctx.fill();
        ctx.strokeStyle = col + '0.6)';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.fillStyle = pressed ? '#101010' : '#fff';
        ctx.font = `bold ${Math.max(8, b.r * 0.34)}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(b.label, b.cx, b.cy);
      }
    });
    ctx.restore();
  }

  drawBanner(ctx, match, layout, opts) {
    let text = null;
    let sub = null;
    if (match.state === STATES.GOAL) {
      const g = match.goals[match.goals.length - 1];
      text = 'GOAL!';
      sub = g ? `${match.teams[g.team].name}${g.ownGoal ? ' (own goal)' : ''}` : '';
    } else if (match.state === STATES.KICKOFF || match.state === STATES.SET_PIECE) {
      const sp = match.setPiece;
      if (sp) {
        text = setPieceLabel(sp.kind);
        const taker = match.getPlayer(sp.takerId);
        sub = `${match.teams[sp.team].name}${taker.human !== null ? ` — P${taker.human + 1}: aim + PASS/SHOOT` : ''}`;
      }
    }
    if (opts.decision) return;
    if (opts.bannerOverride) {
      text = opts.bannerOverride.text;
      sub = opts.bannerOverride.sub;
    }
    if (!text) return;
    const cx = layout.w / 2;
    const cy = layout.pitch.y + layout.pitch.h / 2;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    roundRect(ctx, cx - 150, cy - 40, 300, sub ? 68 : 48, 12);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 30px system-ui, sans-serif';
    ctx.fillText(text, cx, cy - 4);
    if (sub) {
      ctx.font = '600 14px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fillText(sub, cx, cy + 20);
    }
    ctx.restore();
  }
}

function setPieceLabel(kind) {
  return {
    kickoff: 'KICK-OFF',
    throw_in: 'THROW-IN',
    corner: 'CORNER',
    goal_kick: 'GOAL KICK',
    free_kick: 'FREE KICK',
    penalty: 'PENALTY',
  }[kind] || 'RESTART';
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
