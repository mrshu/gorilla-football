// Goalkeeper AI: positioning on the ball-goal line, reacting to shots,
// collecting loose balls in the box and distributing after a catch.

import { PITCH, TIMING } from './constants.js';
import { add, sub, scale, norm, len, dist, clamp, dot } from './vec.js';
import { goalCenter } from './entities.js';
import { isInPenaltyArea } from './rules.js';

const HALF_W = PITCH.width / 2;

function moveTo(match, gk, target, speedFrac = 1) {
  const to = sub(target, gk.pos);
  const d = len(to);
  if (d < 0.2) {
    gk.desiredVel = { x: 0, y: 0 };
    return;
  }
  gk.desiredVel = scale(norm(to), match.effectiveMaxSpeed(gk) * speedFrac * Math.min(1, d / 1.2));
}

export function updateGoalkeeper(match, gk, dt) {
  const team = match.teams[gk.team];
  const ad = team.attackDir;
  const ball = match.ball;
  const ownGoal = goalCenter(-ad);

  if (gk.stun > 0 || gk.frozen > 0) {
    gk.desiredVel = { x: 0, y: 0 };
    return;
  }
  if (ball.owner === gk.id) {
    // Step toward the edge of the goal area, then distribute.
    const out = { x: ownGoal.x + ad * 4, y: clamp(ball.pos.y, HALF_W - 8, HALF_W + 8) };
    moveTo(match, gk, out, 0.6);
    if (gk.holdingBall >= TIMING.goalkeeperHold) goalkeeperDistribute(match, gk);
    return;
  }

  const towardGoal = dot(ball.vel, { x: -ad, y: 0 });
  const ballToLine = Math.abs(ball.pos.x - ownGoal.x);
  let target = null;
  let speed = 1;

  // Meet an attacker carrying into the box, rather than retreating along
  // the goal-ball line and allowing the dribble to pass through our hands.
  const carrier = ball.owner !== null ? match.getPlayer(ball.owner) : null;
  if (carrier && carrier.team !== gk.team && isInPenaltyArea(ball.pos, -ad)
      && ballToLine < 14 && Math.abs(ball.pos.y - HALF_W) < 12) {
    const intercept = add(ball.pos, scale(carrier.vel, 0.18));
    target = {
      x: ownGoal.x + ad * clamp((intercept.x - ownGoal.x) * ad, 0.8, 11),
      y: clamp(intercept.y, HALF_W - 13, HALF_W + 13),
    };
    speed = 1;
  }

  // Shot incoming: compute where it crosses our x and get there.
  const shotIncoming = ball.owner === null && towardGoal > 5 && ballToLine < 32 && !ball.unstoppable;
  if (!shotIncoming) gk.ai.sawShot = false;
  else if (!gk.ai.sawShot) {
    gk.ai.sawShot = true;
    gk.reactTimer = 0.35;
  }
  if (shotIncoming && gk.reactTimer > 0) {
    gk.desiredVel = { x: 0, y: 0 };
    return;
  }
  if (shotIncoming) {
    const vx = ball.vel.x;
    const lineX = ownGoal.x + ad * 1.0;
    const t = (lineX - ball.pos.x) / vx;
    if (t > 0 && t < 3.5) {
      const yCross = ball.pos.y + ball.vel.y * t;
      if (Math.abs(yCross - HALF_W) < 7.5) {
        // Intercept the closest point along the path reachable soon.
        const gkX = clamp(gk.pos.x, Math.min(lineX, ownGoal.x + ad * 6), Math.max(lineX, ownGoal.x + ad * 6));
        const tg = (gkX - ball.pos.x) / vx;
        const y = tg > 0 ? ball.pos.y + ball.vel.y * tg : yCross;
        target = { x: gkX, y: clamp(y, HALF_W - 4.5, HALF_W + 4.5) };
        speed = 0.95;
      }
    }
  }
  if (!target && ball.owner === null) {
    const dBall = dist(gk.pos, ball.pos);
    const inBox = isInPenaltyArea(ball.pos, -ad);
    let oppD = Infinity;
    for (const o of match.opponentsOf(gk)) oppD = Math.min(oppD, dist(o.pos, ball.pos));
    if (inBox && dBall < 16 && (oppD > dBall - 1.5 || dBall < 4) && len(ball.vel) < 14) {
      target = { ...ball.pos };
      speed = 1.1;
    }
  }
  if (!target) {
    // Default positioning: on the ball-goal line, coming out as the ball approaches.
    const dGoalBall = dist(ball.pos, ownGoal);
    const depth = clamp(1.2 + (38 - dGoalBall) * 0.12, 1.0, 6);
    const dir = norm(sub(ball.pos, ownGoal));
    const pt = add(ownGoal, scale(dir, depth));
    target = { x: ownGoal.x + ad * clamp((pt.x - ownGoal.x) * ad, 0.9, 6), y: clamp(pt.y, HALF_W - 3.4, HALF_W + 3.4) };
    speed = 0.9;
  }
  moveTo(match, gk, target, speed);
}

export function goalkeeperDistribute(match, gk) {
  const team = match.teams[gk.team];
  const ad = team.attackDir;
  const mates = match.teammatesOf(gk).filter((m) => !m.isGK);
  let best = null;
  let bestScore = -Infinity;
  for (const m of mates) {
    const d = dist(m.pos, gk.pos);
    if (d < 6 || d > 45) continue;
    let oppD = Infinity;
    for (const o of match.opponentsOf(gk)) oppD = Math.min(oppD, dist(o.pos, m.pos));
    const score = Math.min(oppD, 12) * 1.0 - Math.abs(d - 25) * 0.08 + (m.role === 'DF' ? 1 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = m;
    }
  }
  if (best && bestScore > 4) {
    match.passTo(gk, best, { loft: dist(best.pos, gk.pos) > 25 });
  } else {
    const dir = norm({ x: ad, y: match.rng.range(-0.45, 0.45) });
    match.kick(gk, dir, 30, { vz: 7, kind: 'clear' });
  }
  match.emit('distribute', { playerId: gk.id });
}
