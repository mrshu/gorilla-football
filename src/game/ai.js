// Outfield AI: a small utility/state-based controller. Each frame a player
// is in one of four situations — carrying the ball, supporting a teammate
// in possession, defending against an opponent in possession, or reacting
// to a loose ball — and picks a movement target (and occasionally an
// action) accordingly. Everything is deterministic given the match RNG.

import { PITCH, PHYSICS, ROLES, SET_PIECES } from './constants.js';
import { add, sub, scale, norm, len, dist, clamp, dot } from './vec.js';
import { relToWorld, goalCenter } from './entities.js';

const HALF_W = PITCH.width / 2;

// Formation slot shifted toward the ball. mode: 'attack' | 'defend'.
export function homePosition(match, p, ballPos, mode) {
  const team = match.teams[p.team];
  const slot = team.formation.slots[p.slot];
  const ad = team.attackDir;
  const ballRelX = (ad > 0 ? ballPos.x : PITCH.length - ballPos.x) / PITCH.length;
  let shift = (ballRelX - 0.5) * 0.5;
  if (mode === 'attack') shift += 0.1;
  else shift -= 0.12;
  let relX = clamp(slot.x + shift, 0.04, 0.93);
  if (p.isGK) relX = slot.x;
  const relY = clamp(slot.y + (ballPos.y / PITCH.width - 0.5) * 0.35, 0.04, 0.96);
  return relToWorld(team, relX, relY);
}

function fwdOf(team, pos) {
  return team.attackDir > 0 ? pos.x : PITCH.length - pos.x;
}

// Position (in "forward" metres) of the second-last opponent, i.e. the offside line.
function offsideLine(match, team) {
  const opps = match.teams[1 - team.index].players.filter((o) => !o.sentOff);
  const f = opps.map((o) => fwdOf(team, o.pos)).sort((a, b) => b - a);
  return f.length >= 2 ? f[1] : f[0] ?? PITCH.length;
}

function moveTo(match, p, target, speedFrac = 1) {
  const to = sub(target, p.pos);
  const d = len(to);
  if (d < 0.25) {
    p.desiredVel = { x: 0, y: 0 };
    return;
  }
  const maxSpeed = match.effectiveMaxSpeed(p);
  const s = maxSpeed * speedFrac * Math.min(1, d / 2.0);
  p.desiredVel = scale(norm(to), s);
}

export function updateOutfieldAI(match, p, dt) {
  const ball = match.ball;
  const cache = match.frameCache;
  p.ai.decisionTimer -= dt;
  if (p.stun > 0 || p.frozen > 0 || p.sliding > 0) {
    p.desiredVel = { x: 0, y: 0 };
    return;
  }
  if (ball.owner === p.id) return carryBall(match, p, dt);
  if (ball.homing && ball.homing.playerId === p.id) {
    moveTo(match, p, ball.pos, 1);
    return;
  }
  const possession = cache.possession;
  if (possession === p.team) return support(match, p);
  if (possession !== null) return defend(match, p);
  return looseBall(match, p);
}

function nearestOpponentDistance(match, p, pos = p.pos) {
  let best = Infinity;
  for (const o of match.opponentsOf(p)) best = Math.min(best, dist(o.pos, pos));
  return best;
}

function laneToGoalClear(match, p, goal) {
  const dir = norm(sub(goal, p.pos));
  const d = dist(p.pos, goal);
  for (const o of match.opponentsOf(p)) {
    if (o.isGK) continue;
    const rel = sub(o.pos, p.pos);
    const along = dot(rel, dir);
    if (along > 0.5 && along < d) {
      const off = Math.abs(rel.x * dir.y - rel.y * dir.x);
      if (off < 1.2) return false;
    }
  }
  return true;
}

function carryBall(match, p, dt) {
  const team = match.teams[p.team];
  const ad = team.attackDir;
  const goal = match.goalTargetFor(p);
  const dGoal = dist(p.pos, goal);
  const nearOpp = nearestOpponentDistance(match, p);
  const pressure = nearOpp < 2.4;
  // An assisted human's footballer runs itself but never decides for them:
  // shooting and passing come from the decision panel instead.
  const autoAct = !match.isAssisted(p);

  if (autoAct && p.ai.decisionTimer <= 0) {
    p.ai.decisionTimer = 0.22;
    const shootRange = 14 + p.stats.shotPower * 1.3;
    const wideOk = Math.abs(p.pos.y - HALF_W) < 20 || dGoal < 12;
    const gk = match.teams[1 - p.team].players.find((o) => o.isGK && !o.sentOff);
    if (dGoal < shootRange && wideOk && (laneToGoalClear(match, p, goal) || dGoal < 14 || (pressure && dGoal < 20))) {
      const aimY = gk ? (gk.pos.y > HALF_W ? -0.75 : 0.75) : match.rng.range(-0.6, 0.6);
      match.shoot(p, aimY);
      return;
    }
    const target = match.choosePassTarget(p, null, {});
    const myFwd = fwdOf(team, p.pos);
    const ownThird = myFwd < PITCH.length * 0.33;
    if (target) {
      const gain = fwdOf(team, target.pos) - myFwd;
      const receiverOpen = nearestOpponentDistance(match, target, target.pos) > 4;
      const passWish = (pressure ? 0.5 : 0.07) + (gain > 8 && receiverOpen ? 0.35 : 0) + (p.stats.passing > 7 ? 0.1 : 0) - (p.stats.speed > 7 && !pressure ? 0.1 : 0);
      if (match.rng.chance(clamp(passWish, 0, 0.95))) {
        match.passTo(p, target, {});
        return;
      }
    } else if (pressure && ownThird) {
      const dir = norm({ x: ad, y: p.pos.y > HALF_W ? 0.5 : -0.5 });
      match.kick(p, dir, 26, { vz: 5, kind: 'clear' });
      return;
    }
    // Optional AI special usage.
    if (match.config.aiUsesSpecials && p.ability.cooldown <= 0 && match.rng.chance(0.15)) match.tryActivateAbility(p);
  }
  // Dribble toward goal steering around the nearest opponent.
  let dir = norm(sub(goal, p.pos));
  let nearest = null;
  let nd = Infinity;
  for (const o of match.opponentsOf(p)) {
    const d = dist(o.pos, p.pos);
    if (d < nd) {
      nd = d;
      nearest = o;
    }
  }
  if (nearest && nd < 6) {
    const away = norm(sub(p.pos, nearest.pos));
    const side = { x: -dir.y, y: dir.x };
    const sgn = dot(side, away) >= 0 ? 1 : -1;
    dir = norm(add(dir, scale(side, sgn * (6 - nd) / 6 * 1.4)));
  }
  // Stay away from touchlines
  if (p.pos.y < 4) dir = norm(add(dir, { x: 0, y: 0.6 }));
  if (p.pos.y > PITCH.width - 4) dir = norm(add(dir, { x: 0, y: -0.6 }));
  p.desiredVel = scale(dir, match.effectiveMaxSpeed(p) * (pressure ? 1 : 0.92));
}

function support(match, p) {
  const team = match.teams[p.team];
  const ball = match.ball;
  let home = homePosition(match, p, ball.pos, 'attack');
  // Seek space: drift away from a close opponent.
  const opps = match.opponentsOf(p);
  let nearest = null;
  let nd = Infinity;
  for (const o of opps) {
    const d = dist(o.pos, home);
    if (d < nd) {
      nd = d;
      nearest = o;
    }
  }
  if (nearest && nd < 4) home = add(home, scale(norm(sub(home, nearest.pos)), 4 - nd));
  // Stay onside
  if (p.role === ROLES.FW || p.role === ROLES.MF) {
    const line = offsideLine(match, team);
    const f = fwdOf(team, home);
    const ballF = fwdOf(team, ball.pos);
    const limit = Math.max(line, ballF) - 0.8;
    if (f > limit) home = add(home, { x: -team.attackDir * (f - limit), y: 0 });
  }
  home.x = clamp(home.x, 1, PITCH.length - 1);
  home.y = clamp(home.y, 1, PITCH.width - 1);
  moveTo(match, p, home, 0.85);
}

function outfieldRank(match, p, refPos) {
  const mates = match.teams[p.team].players.filter((m) => !m.sentOff && !m.isGK);
  const mine = dist(p.pos, refPos);
  let rank = 0;
  for (const m of mates) if (m.id !== p.id && dist(m.pos, refPos) < mine) rank++;
  return rank;
}

function defend(match, p) {
  const ball = match.ball;
  const carrier = match.frameCache.ballOwner;
  const team = match.teams[p.team];
  const rank = outfieldRank(match, p, carrier.pos);
  const dCarrier = dist(p.pos, carrier.pos);
  if (rank < 2 && !(carrier.isGK && carrier.holdingBall > 0)) {
    const lead = add(carrier.pos, scale(carrier.vel, 0.25));
    moveTo(match, p, lead, 1);
    if (p.tackleCooldown <= 0) {
      if (dCarrier < PHYSICS.tackleRange) {
        match.attemptTackle(p, false);
      } else if (dCarrier < PHYSICS.slideRange && match.rng.chance(0.008) && p.stats.tackling >= 5) {
        p.facing = norm(sub(lead, p.pos));
        match.startSlide(p);
      }
    }
    return;
  }
  // Mark the nearest opponent near my zone, goal-side.
  const home = homePosition(match, p, ball.pos, 'defend');
  const ownGoal = goalCenter(-team.attackDir);
  let mark = null;
  let md = 9;
  for (const o of match.opponentsOf(p)) {
    if (o.id === carrier.id || o.isGK) continue;
    const d = dist(o.pos, home);
    if (d < md) {
      md = d;
      mark = o;
    }
  }
  let target = home;
  if (mark) target = add(mark.pos, scale(norm(sub(ownGoal, mark.pos)), 3.2));
  moveTo(match, p, target, 0.92);
}

function looseBall(match, p) {
  const ball = match.ball;
  const team = match.teams[p.team];
  const predicted = add(ball.pos, scale(ball.vel, 0.45));
  const rank = outfieldRank(match, p, predicted);
  // An assisted human chases loose balls a little more eagerly than a
  // teammate would, so the person holding the phone stays involved.
  const chaseRank = match.isAssisted(p) ? 3 : 2;
  if (rank < chaseRank && !ball.unstoppable) {
    const target = { x: clamp(predicted.x, 0.5, PITCH.length - 0.5), y: clamp(predicted.y, 0.5, PITCH.width - 0.5) };
    moveTo(match, p, target, 1);
    return;
  }
  const mode = match.frameCache.ballHomeTeam === p.team ? 'attack' : 'defend';
  const home = homePosition(match, p, ball.pos, mode);
  if (mode === 'attack' && (p.role === ROLES.FW || p.role === ROLES.MF)) {
    const line = offsideLine(match, team);
    const f = fwdOf(team, home);
    if (f > line - 0.8) home.x -= team.attackDir * (f - (line - 0.8));
  }
  moveTo(match, p, home, 0.85);
}

// What an AI taker does with a restart.
export function chooseAiSetPieceAction(match, taker, kind) {
  if (kind === SET_PIECES.PENALTY) return 'shoot';
  if (kind === SET_PIECES.FREE_KICK) {
    const d = dist(taker.pos, match.goalTargetFor(taker));
    if (d < 26 && match.rng.chance(0.75)) return 'shoot';
  }
  return 'pass';
}
