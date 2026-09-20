// Pure football-rule helpers. No mutation of match state happens here so
// everything is unit-testable in isolation.

import { PITCH, SET_PIECES } from './constants.js';
import { clamp } from './vec.js';

const HALF_W = PITCH.width / 2;
const HALF_GOAL = PITCH.goalWidth / 2;

export function isInsidePitch(p) {
  return p.x >= 0 && p.x <= PITCH.length && p.y >= 0 && p.y <= PITCH.width;
}

// Is `p` inside the penalty area in front of the goal at `goalSide`
// (-1 => goal at x=0, +1 => goal at x=PITCH.length)?
export function isInPenaltyArea(p, goalSide) {
  const depthOk = goalSide < 0 ? p.x <= PITCH.penaltyAreaDepth : p.x >= PITCH.length - PITCH.penaltyAreaDepth;
  return depthOk && Math.abs(p.y - HALF_W) <= PITCH.penaltyAreaWidth / 2 && p.x >= 0 && p.x <= PITCH.length;
}

export function isInGoalArea(p, goalSide) {
  const depthOk = goalSide < 0 ? p.x <= PITCH.goalAreaDepth : p.x >= PITCH.length - PITCH.goalAreaDepth;
  return depthOk && Math.abs(p.y - HALF_W) <= PITCH.goalAreaWidth / 2;
}

export function penaltySpot(goalSide) {
  return { x: goalSide < 0 ? PITCH.penaltySpot : PITCH.length - PITCH.penaltySpot, y: HALF_W };
}

// Did the ball cross a goal line between the goal posts, below the bar?
// Returns the side (-1 / +1) of the goal that was scored in, or 0.
export function goalCrossed(ballPos, ballZ) {
  if (Math.abs(ballPos.y - HALF_W) > HALF_GOAL || ballZ > PITCH.goalHeight) return 0;
  if (ballPos.x < 0) return -1;
  if (ballPos.x > PITCH.length) return 1;
  return 0;
}

// Classify a ball that has left the field of play.
// `teams` is [{index, attackDir}, {index, attackDir}], `lastTouchTeam` the
// index of the team that last touched the ball (may be null right after
// kickoff — then possession is awarded to team 0 arbitrarily).
// Returns null if the ball is still in play.
export function classifyOutOfPlay(ballPos, ballZ, lastTouchTeam, teams) {
  if (isInsidePitch(ballPos)) return null;
  const goalSide = goalCrossed(ballPos, ballZ);
  if (goalSide !== 0) {
    // Goal for the team attacking that side.
    const scorer = teams.find((t) => t.attackDir === goalSide);
    return { type: 'goal', team: scorer.index, side: goalSide };
  }
  const other = (t) => (t === 0 ? 1 : 0);
  const lt = lastTouchTeam ?? 0;
  if (ballPos.y < 0 || ballPos.y > PITCH.width) {
    const x = clamp(ballPos.x, 0.5, PITCH.length - 0.5);
    const y = ballPos.y < 0 ? 0 : PITCH.width;
    return { type: SET_PIECES.THROW_IN, team: other(lt), pos: { x, y } };
  }
  // Crossed a goal line outside the goal.
  const side = ballPos.x < 0 ? -1 : 1;
  const defending = teams.find((t) => t.attackDir === -side); // team defending the goal on `side`
  const attacking = teams.find((t) => t.attackDir === side);
  const lineX = side < 0 ? 0 : PITCH.length;
  if (lt === defending.index) {
    const y = ballPos.y < HALF_W ? 0 : PITCH.width;
    return { type: SET_PIECES.CORNER, team: attacking.index, pos: { x: lineX, y } };
  }
  const gx = side < 0 ? PITCH.goalAreaDepth : PITCH.length - PITCH.goalAreaDepth;
  const gy = ballPos.y < HALF_W ? HALF_W - PITCH.goalAreaWidth / 4 : HALF_W + PITCH.goalAreaWidth / 4;
  return { type: SET_PIECES.GOAL_KICK, team: defending.index, pos: { x: gx, y: gy } };
}

// Offside evaluation at the moment `kicker` plays the ball.
// Returns ids of teammates who are in an offside position:
//  - in the opponents' half,
//  - nearer to the opponents' goal line than the ball, and
//  - nearer to the goal line than the second-last opponent.
// `teammates` excludes the kicker. Players are {id, pos, sentOff}.
export function offsidePositions(kicker, teammates, opponents, ballPos, attackDir) {
  const fwd = (p) => (attackDir > 0 ? p.x : PITCH.length - p.x); // distance progressed toward opponents' goal
  const halfLine = PITCH.length / 2;
  const ballFwd = fwd(ballPos);
  const oppFwd = opponents.filter((o) => !o.sentOff).map((o) => fwd(o.pos)).sort((a, b) => b - a);
  const secondLast = oppFwd.length >= 2 ? oppFwd[1] : oppFwd[0] ?? PITCH.length;
  const result = [];
  for (const t of teammates) {
    if (t.sentOff || t.id === kicker.id) continue;
    const f = fwd(t.pos);
    if (f <= halfLine) continue;
    if (f <= ballFwd + 0.01) continue;
    if (f <= secondLast + 0.01) continue;
    result.push(t.id);
  }
  return result;
}

// Offside does not apply directly from these restarts.
export function offsideExemptSetPiece(kind) {
  return kind === SET_PIECES.THROW_IN || kind === SET_PIECES.GOAL_KICK || kind === SET_PIECES.CORNER;
}

// Outcome of a tackle attempt. Pure given the random draws.
//   tackling: 1..10 of the tackler; strength: 1..10 of the ball carrier.
//   slide: whether it was a sliding tackle (riskier, longer range).
//   fromBehind: whether the tackler approached from behind (more cards).
//   rolls: {win, foul, card} in [0,1).
export function resolveTackle({ tackling, strength, slide, fromBehind }, rolls) {
  let pWin = 0.3 + (tackling - strength) * 0.05 + (slide ? 0.1 : 0);
  pWin = clamp(pWin, 0.12, 0.9);
  if (rolls.win < pWin) return { won: true, foul: false, card: null };
  let pFoul = 0.13 + (slide ? 0.25 : 0) + (fromBehind ? 0.1 : 0) - tackling * 0.008;
  pFoul = clamp(pFoul, 0.1, 0.85);
  if (rolls.foul >= pFoul) return { won: false, foul: false, card: null };
  // Card severity
  const pYellow = 0.12 + (slide ? 0.2 : 0) + (fromBehind ? 0.18 : 0);
  const pRed = slide && fromBehind ? 0.07 : 0.015;
  let card = null;
  if (rolls.card < pRed) card = 'red';
  else if (rolls.card < pRed + pYellow) card = 'yellow';
  return { won: false, foul: true, card };
}

// Apply a card to a player's disciplinary record. Returns the resulting
// sanction: 'yellow' | 'red' (includes second yellow) .
export function applyCard(player, card) {
  if (card === 'red') {
    player.sentOff = true;
    return 'red';
  }
  player.yellowCards += 1;
  if (player.yellowCards >= 2) {
    player.sentOff = true;
    return 'red';
  }
  return 'yellow';
}

// Restart following a foul committed by `fouler` at `pos` against the
// team `victimTeam`. Penalty if inside the fouler's own penalty area.
export function foulRestart(pos, foulerTeamAttackDir, victimTeam) {
  const ownGoalSide = -foulerTeamAttackDir;
  if (isInPenaltyArea(pos, ownGoalSide)) {
    return { type: SET_PIECES.PENALTY, team: victimTeam, pos: penaltySpot(ownGoalSide) };
  }
  return { type: SET_PIECES.FREE_KICK, team: victimTeam, pos: { x: clamp(pos.x, 1, PITCH.length - 1), y: clamp(pos.y, 1, PITCH.width - 1) } };
}
