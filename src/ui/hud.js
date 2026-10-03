// Scoreboard, clock, cards and the one-line touch hint. Drawn straight onto
// the canvas over whichever renderer is running.

import { STATES, SET_PIECES } from '../game/constants.js';
import { getAbility } from '../game/abilities.js';

// Keep hit testing and the visible button state in agreement with the
// simulation's ability checks, including ball-only and defensive abilities.
export function getSpecialState(match, human) {
  const player = match.aimControl ? match.activePlayerFor(human) : match.humanPlayer(human);
  if (!player) return { enabled: false, label: 'SPECIAL', status: 'No player', uses: '0', cooldown: 0, playerId: null };
  const ability = getAbility(player.ability.id);
  const cooldown = player.ability.cooldown;
  let status = 'Ready';
  if (player.ability.usesLeft <= 0) status = 'Used up';
  else if (cooldown > 0) status = `${Math.ceil(cooldown)}s cooldown`;
  else if (player.stun > 0 || player.frozen > 0) status = 'Recovering';
  else if (ability.needsBall && match.ball.owner !== player.id) status = 'Needs ball';
  else if (!ability.canActivate(match, player)) status = match.setPiece ? 'After restart' : 'Unavailable';
  return {
    enabled: status === 'Ready' && !player.sentOff,
    label: ability.name,
    status,
    uses: Number.isFinite(player.ability.usesLeft) ? `${player.ability.usesLeft} left` : '∞ uses',
    cooldown,
    playerId: player.id,
  };
}

export function drawHud(ctx, match, layout, { hint = null, possessionNotices = [] } = {}) {
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

  // Whole-team control badges identify the player actually receiving input.
  if (layout.aim) drawAimControls(ctx, match, layout, possessionNotices);

  // Specials remaining in joystick play (whole-team buttons show their uses).
  ctx.font = '600 11px system-ui, sans-serif';
  for (let i = 0; !layout.aim && i < match.humanInputs.length; i++) {
    const p = match.aimControl ? match.activePlayerFor(i) : match.humanPlayer(i);
    if (!p) continue;
    const uses = Number.isFinite(p.ability.usesLeft) ? `${p.ability.usesLeft}` : '∞';
    const label = `P${i + 1} ${p.character.name} · ${uses}${p.mathsFocus ? ' · FOCUS' : ''}`;
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

function drawAimControls(ctx, match, layout, notices) {
  const owner = match.ball.owner === null ? null : match.getPlayer(match.ball.owner);
  const humans = match.humanInputs.length;
  const badgeW = Math.min(246, (layout.w - 16 - (humans - 1) * 8) / humans);
  const badgeY = layout.hud.y + layout.hud.h + (match.cards.length ? 24 : 6);
  for (let human = 0; human < humans; human++) {
    const player = match.activePlayerFor(human);
    if (!player) continue;
    const colour = human === 0 ? '#ffe600' : '#00e5ff';
    const x = human === 0 ? 8 : layout.w - badgeW - 8;
    const mode = owner?.id === player.id ? (player.mathsFocus ? 'FOCUSED KICK · DRAW OR TAP TICK'
      : match.state === STATES.PLAY && !player.isGK ? 'PLAY SLOWED · DRAW TO KICK' : 'ON BALL · DRAW TO KICK')
      : owner && owner.team !== player.team ? 'DEFENDING · TAP TO PRESS'
        : owner ? 'SUPPORT · TAP TO MOVE' : 'LOOSE BALL · TAP TO CHASE';
    ctx.fillStyle = 'rgba(9,11,24,0.88)';
    roundRect(ctx, x, badgeY, badgeW, 44, 8);
    ctx.fill();
    ctx.textAlign = 'left';
    ctx.fillStyle = colour;
    ctx.font = 'bold 12px system-ui, sans-serif';
    ctx.fillText(`P${human + 1} · #${player.number} ${player.character.name}`, x + 8, badgeY + 13, badgeW - 16);
    ctx.font = '600 10px system-ui, sans-serif';
    ctx.fillStyle = '#fff';
    ctx.fillText(mode, x + 8, badgeY + 32, badgeW - 16);
    const notice = notices.find((n) => n.human === human);
    if (notice) {
      ctx.fillStyle = 'rgba(9,11,24,0.9)';
      roundRect(ctx, x, badgeY + 49, badgeW, 26, 8);
      ctx.fill();
      ctx.fillStyle = colour;
      ctx.font = 'bold 12px system-ui, sans-serif';
      ctx.fillText(notice.text, x + 8, badgeY + 62, badgeW - 16);
    }
  }
  for (const button of layout.specialButtons || []) {
    const state = getSpecialState(match, button.human);
    const colour = button.human === 0 ? '#ffe600' : '#00e5ff';
    ctx.fillStyle = state.enabled ? 'rgba(9,11,24,0.94)' : 'rgba(9,11,24,0.74)';
    roundRect(ctx, button.x, button.y, button.w, button.h, 10);
    ctx.fill();
    ctx.strokeStyle = state.enabled ? colour : 'rgba(255,255,255,0.24)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.textAlign = 'left';
    ctx.font = 'bold 10px system-ui, sans-serif';
    ctx.fillStyle = state.enabled ? colour : '#bbb';
    ctx.fillText(`P${button.human + 1} SPECIAL [${button.human === 0 ? 'L' : '3'}]`, button.x + 9, button.y + 12, button.w - 18);
    ctx.font = 'bold 12px system-ui, sans-serif';
    ctx.fillText(state.label, button.x + 9, button.y + 28, button.w - 18);
    ctx.font = '600 10px system-ui, sans-serif';
    ctx.fillStyle = '#eee';
    ctx.fillText(`${state.status} · ${state.uses}`, button.x + 9, button.y + 44, button.w - 18);
  }
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
  const y = layout.h - (layout.aim ? 86 : 34);
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
