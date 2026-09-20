// Scoreboard, clock, cards and the one-line touch hint. Drawn straight onto
// the canvas over whichever renderer is running.

import { STATES, SET_PIECES } from '../game/constants.js';

export function drawHud(ctx, match, layout, { hint = null } = {}) {
  const hud = layout.hud;
  const t0 = match.teams[0];
  const t1 = match.teams[1];
  ctx.save();
  ctx.fillStyle = 'rgba(9,11,24,0.88)';
  ctx.fillRect(hud.x, hud.y, hud.w, hud.h);
  const cy = hud.y + hud.h / 2;
  ctx.textBaseline = 'middle';

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

  const nameW = Math.max(40, hud.w / 2 - 92);
  ctx.font = '600 12px system-ui, sans-serif';
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'left';
  ctx.fillText(t0.name, 32, cy, nameW);
  ctx.textAlign = 'right';
  ctx.fillText(t1.name, hud.w - 50, cy, nameW);

  // Pause button
  const pb = layout.pauseBtn;
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  ctx.beginPath();
  ctx.arc(pb.cx, pb.cy, pb.r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.fillRect(pb.cx - 5, pb.cy - 6, 3.5, 12);
  ctx.fillRect(pb.cx + 1.5, pb.cy - 6, 3.5, 12);

  // Cards ticker
  const chipY = hud.y + hud.h + 4;
  if (match.cards.length) {
    ctx.textAlign = 'center';
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    const txt = match.cards.slice(-3).map((c) => `${c.card === 'red' ? 'RED' : 'YEL'} #${match.getPlayer(c.playerId).number}`).join('   ');
    ctx.fillText(txt, layout.w / 2, chipY + 9);
  }

  // Specials remaining, per human
  ctx.font = '600 11px system-ui, sans-serif';
  for (let i = 0; i < match.humanInputs.length; i++) {
    const p = match.aimControl ? match.activePlayerFor(i) : match.humanPlayer(i);
    if (!p) continue;
    const uses = Number.isFinite(p.ability.usesLeft) ? `${p.ability.usesLeft}` : '∞';
    const label = `P${i + 1} ${p.character.name} · ${uses}`;
    const w = ctx.measureText(label).width + 12;
    const x = i === 0 ? 8 : layout.w - w - 8;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    roundRect(ctx, x, chipY, w, 18, 6);
    ctx.fill();
    ctx.fillStyle = i === 0 ? '#ffe600' : '#00e5ff';
    ctx.textAlign = 'left';
    ctx.fillText(label, x + 6, chipY + 9);
  }

  drawBanner(ctx, match, layout, hint);
  ctx.restore();
}

function drawBanner(ctx, match, layout, hint) {
  let title = null;
  let sub = hint;
  if (match.state === STATES.GOAL) {
    const g = match.goals[match.goals.length - 1];
    title = 'GOAL!';
    sub = g ? `${match.teams[g.team].name}${g.ownGoal ? ' (own goal)' : ''}` : '';
  } else if (match.setPiece) {
    title = setPieceLabel(match.setPiece.kind);
    sub = `${match.teams[match.setPiece.team].name}${hint ? ` · ${hint}` : ''}`;
  }
  const cx = layout.w / 2;
  if (title) {
    const cy = layout.h * 0.3;
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    roundRect(ctx, cx - 150, cy - 34, 300, sub ? 62 : 44, 12);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 28px system-ui, sans-serif';
    ctx.fillText(title, cx, cy - 2);
    if (sub) {
      ctx.font = '600 13px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.88)';
      ctx.fillText(sub, cx, cy + 22);
    }
    return;
  }
  if (!sub) return;
  // Just the hint, low on the screen so it never covers the play.
  ctx.textAlign = 'center';
  ctx.font = '600 13px system-ui, sans-serif';
  const w = ctx.measureText(sub).width + 22;
  const y = layout.h - 34;
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  roundRect(ctx, cx - w / 2, y - 13, w, 26, 13);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.fillText(sub, cx, y);
}

function setPieceLabel(kind) {
  return {
    [SET_PIECES.KICKOFF]: 'KICK-OFF',
    [SET_PIECES.THROW_IN]: 'THROW-IN',
    [SET_PIECES.CORNER]: 'CORNER',
    [SET_PIECES.GOAL_KICK]: 'GOAL KICK',
    [SET_PIECES.FREE_KICK]: 'FREE KICK',
    [SET_PIECES.PENALTY]: 'PENALTY',
  }[kind] || 'RESTART';
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
