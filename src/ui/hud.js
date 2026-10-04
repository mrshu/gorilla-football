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

const COLOUR = { navy: '#10182a', gold: '#ffd35c', teal: '#5fd4c7', ivory: '#f5f4e9', muted: '#adb8c7' };
const FONT = '"Avenir Next", "Trebuchet MS", sans-serif';
const PANEL = 'rgba(16,24,42,0.94)';
const BORDER = 'rgba(173,184,199,0.24)';

export function drawHud(ctx, match, layout, { hint = null, possessionNotices = [] } = {}) {
  const hud = layout.hud;
  const t0 = match.teams[0];
  const t1 = match.teams[1];
  ctx.save();
  ctx.fillStyle = COLOUR.navy;
  ctx.fillRect(hud.x, hud.y, hud.w, hud.h);
  ctx.fillStyle = BORDER;
  ctx.fillRect(hud.x, hud.y + hud.h - 1, hud.w, 1);
  const cy = hud.y + hud.h / 2;
  const scoreX = hud.x + (hud.w - 36) / 2;
  const scoreHalfW = 48;
  const leftNameX = hud.x + 22;
  const rightNameX = hud.x + hud.w - 48;
  ctx.textBaseline = 'middle';

  // Team colours bookend a compact broadcast score, leaving the pause
  // target clear even on a narrow phone.
  ctx.fillStyle = t0.jersey.primary;
  ctx.fillRect(hud.x + 10, cy - 10, 4, 20);
  ctx.fillStyle = t1.jersey.primary;
  ctx.fillRect(rightNameX + 8, cy - 10, 4, 20);
  ctx.font = `600 13px ${FONT}`;
  ctx.fillStyle = COLOUR.ivory;
  ctx.textAlign = 'left';
  fittedText(ctx, t0.name, leftNameX, cy, scoreX - scoreHalfW - leftNameX);
  ctx.textAlign = 'right';
  fittedText(ctx, t1.name, rightNameX, cy, rightNameX - scoreX - scoreHalfW);

  ctx.textAlign = 'center';
  ctx.fillStyle = COLOUR.ivory;
  ctx.font = `700 24px ${FONT}`;
  ctx.fillText(`${t0.score} – ${t1.score}`, scoreX, cy - 7);
  ctx.font = `600 11px ${FONT}`;
  ctx.fillStyle = COLOUR.muted;
  ctx.fillText(`${match.clockLabel()} · Half ${match.clock.half}`, scoreX, cy + 13);

  const pb = layout.pauseBtn;
  ctx.fillStyle = 'rgba(173,184,199,0.1)';
  ctx.beginPath();
  ctx.arc(pb.cx, pb.cy, pb.r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = BORDER;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = COLOUR.ivory;
  ctx.fillRect(pb.cx - 5, pb.cy - 6, 3.5, 12);
  ctx.fillRect(pb.cx + 1.5, pb.cy - 6, 3.5, 12);

  const chipY = hud.y + hud.h + 4;
  if (match.cards.length) {
    ctx.textAlign = 'center';
    ctx.font = `600 11px ${FONT}`;
    const txt = match.cards.slice(-3).map((c) => `${c.card === 'red' ? 'Red' : 'Yellow'} #${match.getPlayer(c.playerId).number}`).join('   ');
    const width = Math.min(layout.w - 24, ctx.measureText(txt).width + 20);
    panel(ctx, layout.w / 2 - width / 2, chipY, width, 18, 4);
    ctx.fillStyle = COLOUR.ivory;
    fittedText(ctx, txt, layout.w / 2, chipY + 9, width - 16);
  }

  if (layout.aim) drawAimControls(ctx, match, layout, possessionNotices);

  for (let i = 0; !layout.aim && i < match.humanInputs.length; i++) {
    const p = match.humanPlayer(i);
    if (!p) continue;
    const uses = Number.isFinite(p.ability.usesLeft) ? `${p.ability.usesLeft} left` : '∞ uses';
    const label = `P${i + 1} ${p.character.name} · ${uses}`;
    const status = mathsStatus(match, i);
    ctx.font = `600 12px ${FONT}`;
    const labelWidth = ctx.measureText(label).width;
    ctx.font = `500 10px ${FONT}`;
    const width = Math.min(Math.max(labelWidth, ctx.measureText(status).width) + 16, (layout.w - 24) / match.humanInputs.length);
    const x = i === 0 ? 8 : layout.w - width - 8;
    panel(ctx, x, chipY, width, 38, 5);
    ctx.fillStyle = i === 0 ? COLOUR.gold : COLOUR.teal;
    ctx.textAlign = 'left';
    ctx.font = `600 12px ${FONT}`;
    fittedText(ctx, label, x + 8, chipY + 11, width - 16);
    ctx.font = `500 10px ${FONT}`;
    ctx.fillStyle = match.hasMathsFocus?.(i) ? (i === 0 ? COLOUR.gold : COLOUR.teal) : COLOUR.muted;
    fittedText(ctx, status, x + 8, chipY + 28, width - 16);
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
    const colour = human === 0 ? COLOUR.gold : COLOUR.teal;
    const x = human === 0 ? 8 : layout.w - badgeW - 8;
    const mode = owner?.id === player.id ? (match.isCarryingRun?.(human) ? 'Running · draw to pass or shoot'
      : match.shootingGoal?.(human) ? (match.hasMathsFocus?.(human) ? 'Focused shot · tap the net' : 'Tap the net · drag to place a shot')
      : match.hasMathsFocus?.(human) ? 'Focused kick · draw or tap ✓'
      : match.state === STATES.PLAY && !player.isGK ? 'Slow play · draw or tap ✓' : 'Draw or tap ✓ to kick')
      : owner && owner.team !== player.team ? 'Defending · tap to press'
        : owner ? 'Support · tap to move' : 'Loose ball · tap to chase';
    panel(ctx, x, badgeY, badgeW, 60, 6);
    ctx.fillStyle = colour;
    ctx.fillRect(x + 1, badgeY + 10, 3, 24);
    ctx.textAlign = 'left';
    ctx.font = `600 13px ${FONT}`;
    fittedText(ctx, `P${human + 1} · #${player.number} ${player.character.name}`, x + 11, badgeY + 13, badgeW - 22);
    ctx.font = `500 12px ${FONT}`;
    ctx.fillStyle = COLOUR.ivory;
    fittedText(ctx, mode, x + 11, badgeY + 32, badgeW - 22);
    ctx.font = `500 10px ${FONT}`;
    ctx.fillStyle = match.hasMathsFocus?.(human) ? colour : COLOUR.muted;
    fittedText(ctx, mathsStatus(match, human), x + 11, badgeY + 49, badgeW - 22);
    const notice = notices.find((n) => n.human === human);
    if (notice) {
      ctx.font = `600 12px ${FONT}`;
      const text = sentenceCase(notice.text);
      const width = Math.min(badgeW, ctx.measureText(text).width + 22);
      panel(ctx, x, badgeY + 65, width, 24, 5);
      ctx.fillStyle = colour;
      fittedText(ctx, text, x + 11, badgeY + 77, width - 22);
    }
  }
  for (const button of layout.specialButtons || []) {
    const state = getSpecialState(match, button.human);
    const colour = button.human === 0 ? COLOUR.gold : COLOUR.teal;
    panel(ctx, button.x, button.y, button.w, button.h, 8, state.enabled ? colour : BORDER);
    ctx.textAlign = 'left';
    ctx.font = `500 11px ${FONT}`;
    ctx.fillStyle = state.enabled ? colour : COLOUR.muted;
    ctx.fillText(`P${button.human + 1} special`, button.x + 11, button.y + 11);
    // A separate, quiet keycap makes the keyboard shortcut discoverable
    // without shrinking the actual ability name or changing the hit area.
    const keyX = button.x + button.w - 24;
    ctx.fillStyle = 'rgba(173,184,199,0.12)';
    roundRect(ctx, keyX, button.y + 4, 14, 14, 3);
    ctx.fill();
    ctx.fillStyle = COLOUR.muted;
    ctx.textAlign = 'center';
    ctx.font = `600 10px ${FONT}`;
    ctx.fillText(button.human === 0 ? 'L' : '3', keyX + 7, button.y + 11);
    ctx.textAlign = 'left';
    ctx.font = `600 13px ${FONT}`;
    ctx.fillStyle = state.enabled ? COLOUR.ivory : COLOUR.muted;
    fittedText(ctx, state.label, button.x + 11, button.y + 28, button.w - 22);
    ctx.font = `500 11px ${FONT}`;
    ctx.fillStyle = COLOUR.muted;
    fittedText(ctx, `${state.status} · ${state.uses}`, button.x + 11, button.y + 45, button.w - 22);
  }
}

export function mathsStatus(match, human) {
  if (match.hasMathsFocus?.(human)) return 'Focused kick ready';
  return match.config.humans[human]?.mathsBand > 0 ? 'Maths on · questions in attack' : 'Maths off';
}

function drawBanner(ctx, match, layout, hint) {
  let title = null;
  let sub = hint;
  const goal = match.state === STATES.GOAL;
  if (goal) {
    const scored = match.goals[match.goals.length - 1];
    title = 'Goal!';
    sub = scored ? `${match.teams[scored.team].name}${scored.ownGoal ? ' · own goal' : ''}` : '';
  } else if (match.setPiece) {
    title = setPieceLabel(match.setPiece.kind);
    sub = `${match.teams[match.setPiece.team].name}${hint ? ` · ${hint}` : ''}`;
  }
  const cx = layout.w / 2;
  if (title) {
    const cy = layout.h * 0.3;
    const width = Math.min(layout.w - 32, goal ? 300 : 360);
    const height = sub ? (goal ? 62 : 52) : 40;
    panel(ctx, cx - width / 2, cy - height / 2, width, height, 8);
    ctx.textAlign = 'center';
    ctx.fillStyle = goal ? COLOUR.gold : COLOUR.ivory;
    ctx.font = `${goal ? '700 28' : '600 19'}px ${FONT}`;
    ctx.fillText(title, cx, cy - (sub ? 8 : 0));
    if (sub) {
      ctx.font = `500 12px ${FONT}`;
      ctx.fillStyle = COLOUR.muted;
      fittedText(ctx, sub, cx, cy + 14, width - 24);
    }
    return;
  }
  if (!sub) return;
  ctx.textAlign = 'center';
  ctx.font = `500 13px ${FONT}`;
  const width = Math.min(layout.w - 32, ctx.measureText(sub).width + 26);
  const y = layout.h - (layout.aim ? 86 : 34);
  panel(ctx, cx - width / 2, y - 15, width, 30, 7);
  ctx.fillStyle = COLOUR.ivory;
  fittedText(ctx, sub, cx, y, width - 26);
}

function setPieceLabel(kind) {
  return {
    [SET_PIECES.KICKOFF]: 'Kick-off',
    [SET_PIECES.THROW_IN]: 'Throw-in',
    [SET_PIECES.CORNER]: 'Corner',
    [SET_PIECES.GOAL_KICK]: 'Goal kick',
    [SET_PIECES.FREE_KICK]: 'Free kick',
    [SET_PIECES.PENALTY]: 'Penalty',
  }[kind] || 'Restart';
}

function sentenceCase(text) {
  return text && text === text.toUpperCase() ? text[0] + text.slice(1).toLowerCase() : text;
}

// Ellipsise long names rather than compressing their letters to fit. Text
// stays at the chosen readable size on phones and two-player badges.
function fittedText(ctx, text, x, y, width) {
  if (ctx.measureText(text).width > width) {
    const letters = Array.from(text);
    while (letters.length && ctx.measureText(`${letters.join('')}…`).width > width) letters.pop();
    text = `${letters.join('')}…`;
  }
  ctx.fillText(text, x, y);
}

function panel(ctx, x, y, w, h, r, border = BORDER) {
  ctx.fillStyle = PANEL;
  roundRect(ctx, x, y, w, h, r);
  ctx.fill();
  ctx.strokeStyle = border;
  ctx.lineWidth = 1;
  ctx.stroke();
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
