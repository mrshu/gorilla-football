import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Match } from '../src/game/match.js';
import { normalizeConfig, MODES, CONTROL } from '../src/game/config.js';
import { PHYSICS, STATES, PITCH, AIM } from '../src/game/constants.js';
import { dist, len, norm, sub } from '../src/game/vec.js';

function makeMatch(over = {}) {
  return new Match(normalizeConfig({ mode: MODES.SOLO, durationMinutes: 5, seed: 11, humans: [{ characterId: 'plumber' }], ...over }));
}

// Run until the match is in open play, taking any restart straight up the pitch.
function intoPlay(m, guardSteps = 4000) {
  let guard = 0;
  while (m.state !== STATES.PLAY && guard++ < guardSteps) {
    if (m.canKick(0)) m.aimKick(0, { x: m.teams[0].attackDir, y: 0 }, 0.5);
    m.step(PHYSICS.dt);
  }
  assert.equal(m.state, STATES.PLAY);
}

// Park every other player well away from the action, spread out. Stacking
// them on one spot makes the separation code fling somebody into the ball.
function parkEveryoneElse(m, keep) {
  let i = 0;
  for (const o of m.players) {
    if (keep && o.id === keep.id) continue;
    o.pos = { x: 4 + (i % 11) * 9, y: i < 11 ? 2 : PITCH.width - 2 };
    o.vel = { x: 0, y: 0 };
    i++;
  }
}

// Nobody at all near the ball, so a struck ball is left to the physics.
const parkAll = (m) => parkEveryoneElse(m, null);

// Put the ball at the feet of an outfield player on team 0.
function giveBall(m, player) {
  m.ball.owner = player.id;
  m.ball.homing = null;
  m.ball.unstoppable = false;
  player.kickCooldown = 0;
  player.stun = 0;
  m.snapBallToOwner(player);
}

test('nobody is joystick-controlled in whole-team play', () => {
  const m = makeMatch();
  assert.equal(m.aimControl, true);
  // The human is still attached to a player for the HUD, but the AI drives
  // every single one of them.
  const p = m.humanPlayer(0);
  assert.ok(p, 'a human player is still assigned');
  intoPlay(m);
  const start = { ...p.pos };
  for (let i = 0; i < 180; i++) m.step(PHYSICS.dt);
  assert.ok(dist(start, p.pos) > 2, 'the human-flagged player should run itself');
});

test('the active player is whoever on your team has the ball', () => {
  const m = makeMatch();
  intoPlay(m);
  const mine = m.teams[0].players[6];
  giveBall(m, mine);
  assert.equal(m.activePlayerFor(0).id, mine.id);
  // When the opposition has it, the active player is our nearest chaser.
  const theirs = m.teams[1].players[7];
  giveBall(m, theirs);
  const active = m.activePlayerFor(0);
  assert.equal(active.team, 0);
  assert.ok(!active.isGK);
});

test('you can only kick when your team has the ball', () => {
  const m = makeMatch();
  intoPlay(m);
  const mine = m.teams[0].players[6];
  giveBall(m, mine);
  assert.equal(m.canKick(0), true);
  const theirs = m.teams[1].players[7];
  giveBall(m, theirs);
  assert.equal(m.canKick(0), false);
  assert.equal(m.aimKick(0, { x: 1, y: 0 }, 1), false, 'a kick without the ball must be refused');
  m.ball.owner = null;
  assert.equal(m.canKick(0), false);
});

test('a release sends the ball the way it was aimed', () => {
  const m = makeMatch();
  intoPlay(m);
  const p = m.teams[0].players[6];
  p.pos = { x: 50, y: 34 };
  giveBall(m, p);
  assert.ok(m.aimKick(0, { x: 0, y: 1 }, 0.8));
  m.step(PHYSICS.dt);
  assert.equal(m.ball.owner, null, 'the ball should have left the player');
  const dir = norm(m.ball.vel);
  assert.ok(dir.y > 0.85, `expected the ball to travel +y, got ${JSON.stringify(dir)}`);
});

test('more power means a faster ball', () => {
  const speeds = [];
  for (const power of [0.15, 0.55, 1]) {
    const m = makeMatch({ seed: 4 });
    intoPlay(m);
    const p = m.teams[0].players[6];
    p.pos = { x: 50, y: 34 };
    giveBall(m, p);
    m.aimKick(0, { x: 1, y: 0 }, power);
    m.step(PHYSICS.dt);
    speeds.push(len(m.ball.vel));
  }
  assert.ok(speeds[0] < speeds[1] && speeds[1] < speeds[2], `speeds not increasing: ${speeds.map((s) => s.toFixed(1))}`);
  assert.ok(speeds[0] >= AIM.minSpeed - 1, 'even a gentle touch should move the ball');
});

// Highest the ball gets in the second after a kick at this power, with every
// other player moved away so nobody intercepts it.
function loftHeight(power) {
  const m = makeMatch({ seed: 6 });
  intoPlay(m);
  const p = m.teams[0].players[6];
  p.pos = { x: 30, y: 34 };
  giveBall(m, p);
  for (const q of m.players) if (q.id !== p.id) q.pos = { x: 95, y: 60 };
  m.aimKick(0, { x: 1, y: 0 }, power);
  let peak = 0;
  for (let i = 0; i < 60; i++) {
    m.step(PHYSICS.dt);
    peak = Math.max(peak, m.ball.z);
  }
  return peak;
}

test('a hard kick is lofted and a gentle one stays down', () => {
  const soft = loftHeight(0.3);
  const hard = loftHeight(1);
  assert.ok(soft < 0.3, `a soft pass should stay on the grass, peaked at ${soft.toFixed(2)} m`);
  // A full-power kick lifts about 1.25 m: enough to clear legs, still under
  // the 2.44 m crossbar so a shot on target stays on target.
  assert.ok(hard > 1 && hard < PITCH.goalHeight, `a full-power kick should rise but stay under the bar, peaked at ${hard.toFixed(2)} m`);
  assert.ok(hard > soft * 4, 'power should make a clear difference to the loft');
});

test('a kick aimed at goal from range counts as a shot', () => {
  const m = makeMatch();
  intoPlay(m);
  const p = m.teams[0].players[9];
  const goalX = m.teams[0].attackDir > 0 ? PITCH.length : 0;
  p.pos = { x: goalX - m.teams[0].attackDir * 20, y: 34 };
  giveBall(m, p);
  const before = m.stats.shots[0];
  m.aimKick(0, norm(sub({ x: goalX, y: 34 }, p.pos)), 0.9);
  m.step(PHYSICS.dt);
  assert.equal(m.stats.shots[0], before + 1);
  assert.ok(m.drainEvents().some((e) => e.type === 'shot'));
});

test('you can aim a restart and release to take it', () => {
  const m = makeMatch();
  // The opening kickoff belongs to team 0, which is the human's team.
  let guard = 0;
  while (!m.canKick(0) && guard++ < 4000) m.step(PHYSICS.dt);
  assert.ok(m.canKick(0), 'the human should be able to take the kickoff');
  assert.equal(m.state, STATES.KICKOFF);
  assert.ok(m.aimKick(0, { x: 0, y: 1 }, 0.5));
  m.step(PHYSICS.dt);
  assert.equal(m.state, STATES.PLAY, 'releasing should start play');
  assert.ok(m.drainEvents().some((e) => e.type === 'kickoff'));
});

test('an untaken restart is played automatically so the match never stalls', () => {
  const m = makeMatch();
  let guard = 0;
  while (m.state !== STATES.PLAY && guard++ < 60 * 30) m.step(PHYSICS.dt);
  assert.equal(m.state, STATES.PLAY, 'the AI should take the restart after the timeout');
});

test('tapping a spot sends your player running to it', () => {
  const m = makeMatch({ seed: 12 });
  intoPlay(m);
  const p = m.activePlayerFor(0);
  const spot = { x: p.pos.x + 18, y: p.pos.y + 10 };
  const before = dist(p.pos, spot);
  assert.ok(m.tap(0, spot));
  for (let i = 0; i < 180; i++) m.step(PHYSICS.dt);
  const after = dist(p.pos, spot);
  assert.ok(after < before - 5, `player did not run to the spot: ${before.toFixed(1)} m to ${after.toFixed(1)} m`);
});

test('open-space run suggestions carry the ball without kicking or spending maths focus', () => {
  const m = makeMatch();
  m.state = STATES.PLAY;
  m.setPiece = null;
  const p = m.humanPlayer(0);
  parkEveryoneElse(m, p);
  p.pos = { x: 40, y: 34 };
  giveBall(m, p);
  assert.ok(m.grantMathsFocus(0, p.id));
  const run = m.suggestedRun(0);
  assert.equal(run.kind, 'run');
  assert.ok(run.point.x > p.pos.x);
  assert.equal(m.playRun(0, run), true);
  assert.equal(m.ball.owner, p.id);
  assert.equal(m.hasMathsFocus(0), true);
  assert.equal(m.isCarryingRun(0), true);
  assert.equal(m.suggestedRun(0), null, 'a committed run does not need another run marker');
  const start = p.pos.x;
  m.drainEvents();
  for (let i = 0; i < 90; i++) m.step(PHYSICS.dt);
  assert.ok(p.pos.x > start + 4, 'the chosen carry advances the footballer');
  assert.equal(m.ball.owner, p.id);
  assert.equal(m.hasMathsFocus(0), true);
  assert.ok(!m.drainEvents().some(e => e.type === 'kick'));
});

test('captured run suggestions reject turnovers, new blockers and malformed destinations', () => {
  for (const invalidate of [
    (m, p) => { m.ball.owner = m.teams[0].players.find(o => o.id !== p.id && !o.isGK).id; },
    (m, p) => { m.teams[1].players[6].pos = { x: p.pos.x + 2, y: p.pos.y }; },
    (m, p, run) => { run.point.x = NaN; },
    (m, p, run) => { run.point = { x: 1, y: 1 }; },
    (m) => { m.state = STATES.GOAL; },
  ]) {
    const m = makeMatch();
    m.state = STATES.PLAY;
    m.setPiece = null;
    const p = m.humanPlayer(0);
    parkEveryoneElse(m, p);
    p.pos = { x: 40, y: 34 };
    giveBall(m, p);
    const run = m.suggestedRun(0);
    assert.ok(run);
    invalidate(m, p, run);
    assert.equal(m.playRun(0, run), false);
    assert.equal(m.moveOrders[0], null);
  }
});

test('a captured run uses the newly safe destination when a defender closes the old endpoint', () => {
  const m = makeMatch();
  m.state = STATES.PLAY;
  m.setPiece = null;
  const p = m.humanPlayer(0);
  parkEveryoneElse(m, p);
  p.pos = { x: 40, y: 34 };
  giveBall(m, p);
  const opponents = m.teams[1].players.slice(4, 7);
  opponents[0].pos = { x: 55.9, y: 34 };
  opponents[1].pos = { x: 48, y: 39 };
  opponents[2].pos = { x: 48, y: 29 };
  const captured = m.suggestedRun(0);
  assert.deepEqual(captured.point, { x: 52, y: 34 });
  opponents[0].pos.x = 55.5;
  const fresh = m.suggestedRun(0);
  assert.deepEqual(fresh.point, { x: 50, y: 34 });
  assert.equal(m.playRun(0, captured), true);
  assert.deepEqual(m.moveOrders[0].point, fresh.point);
});

test('a move order is dropped once the player gets there', () => {
  const m = makeMatch({ seed: 12 });
  intoPlay(m);
  const p = m.activePlayerFor(0);
  const spot = { x: p.pos.x + 6, y: p.pos.y };
  m.tap(0, spot);
  let arrived = false;
  for (let i = 0; i < 300; i++) {
    m.step(PHYSICS.dt);
    if (!m.moveOrders[0]) {
      arrived = true;
      break;
    }
  }
  assert.ok(arrived, 'the order should clear when the player arrives');
});

test('a tapped destination is clamped onto the pitch', () => {
  const m = makeMatch({ seed: 12 });
  intoPlay(m);
  assert.ok(m.tap(0, { x: -400, y: 900 }));
  const order = m.moveOrders[0];
  assert.ok(order.point.x >= 0 && order.point.x <= PITCH.length, `x ${order.point.x}`);
  assert.ok(order.point.y >= 0 && order.point.y <= PITCH.width, `y ${order.point.y}`);
});

test('tapping the opposition carrier tackles instead of running there', () => {
  const m = makeMatch({ seed: 12 });
  intoPlay(m);
  const theirs = m.teams[1].players[7];
  theirs.pos = { x: 50, y: 34 };
  giveBall(m, theirs);
  const mine = m.teams[0].players[6];
  mine.pos = { x: 51.4, y: 34 };
  mine.tackleCooldown = 0;
  mine.sliding = 0;
  assert.ok(m.tap(0, { ...theirs.pos }));
  assert.equal(m.moveOrders[0], null, 'that was a tackle, not a run');
  m.step(PHYSICS.dt);
  assert.ok(mine.tackleCooldown > 0 || mine.sliding > 0, 'somebody should have gone in');
});

test('a tap with no place named still does something useful', () => {
  const m = makeMatch({ seed: 12 });
  intoPlay(m);
  const p = m.teams[0].players[9];
  p.pos = { x: 40, y: 34 };
  p.facing = { x: m.teams[0].attackDir, y: 0 };
  giveBall(m, p);
  for (const o of m.teams[1].players) if (!o.isGK) o.pos = { x: 15, y: 5 };
  assert.equal(m.canDribble(0), true);
  assert.ok(m.tap(0));
  m.step(PHYSICS.dt);
  assert.equal(m.ball.owner, null, 'the touch should knock the ball ahead');
  assert.ok(len(m.ball.vel) > 3, 'the ball should be moving');
  assert.ok(p.speedBoost > 0, 'the carrier should be chasing their own touch');
  // The knock-on goes forwards, towards the goal being attacked.
  assert.ok(m.ball.vel.x * m.teams[0].attackDir > 0, 'the touch should go forwards');
  // And they should get it back shortly afterwards.
  let regained = false;
  for (let i = 0; i < 90; i++) {
    m.step(PHYSICS.dt);
    if (m.ball.owner === p.id) {
      regained = true;
      break;
    }
  }
  assert.ok(regained, 'the dribbler should reach their own knock-on');
});

test('a tap without the ball closes the opposition down instead', () => {
  const m = makeMatch({ seed: 12 });
  intoPlay(m);
  const theirs = m.teams[1].players[7];
  theirs.pos = { x: 50, y: 34 };
  giveBall(m, theirs);
  const mine = m.teams[0].players[6];
  mine.pos = { x: 52, y: 34 };
  mine.tackleCooldown = 0;
  mine.sliding = 0;
  assert.equal(m.canDribble(0), false);
  assert.ok(m.tap(0));
  m.step(PHYSICS.dt);
  assert.ok(mine.tackleCooldown > 0 || mine.sliding > 0, 'the nearest defender should have gone in');
});

test('you cannot dribble when the ball is not yours', () => {
  const m = makeMatch({ seed: 12 });
  intoPlay(m);
  giveBall(m, m.teams[1].players[7]);
  assert.equal(m.canDribble(0), false);
  m.ball.owner = null;
  assert.equal(m.canDribble(0), false);
});

test('pressing lunges a defender at the ball', () => {
  const m = makeMatch();
  intoPlay(m);
  const theirs = m.teams[1].players[7];
  theirs.pos = { x: 50, y: 34 };
  giveBall(m, theirs);
  const mine = m.teams[0].players[6];
  mine.pos = { x: 52, y: 34 };
  mine.tackleCooldown = 0;
  mine.sliding = 0;
  assert.ok(m.press(0));
  m.step(PHYSICS.dt);
  const acted = mine.tackleCooldown > 0 || mine.sliding > 0;
  assert.ok(acted, 'the nearest defender should have gone in');
});

test('a whole-team match plays to full time with no input at all', () => {
  const m = makeMatch({ durationMinutes: 1 });
  let guard = 0;
  while (!m.isFinished() && guard++ < 60 * 60 * 8) {
    m.step(PHYSICS.dt);
    if (m.state === STATES.HALFTIME) m.resumeSecondHalf();
  }
  assert.equal(m.state, STATES.FULLTIME);
  assert.ok(m.players.every((p) => Number.isFinite(p.pos.x)));
});

test('a whole-team match plays to full time while the human keeps shooting', () => {
  const m = makeMatch({ durationMinutes: 1, seed: 8 });
  let kicks = 0;
  let guard = 0;
  while (!m.isFinished() && guard++ < 60 * 60 * 8) {
    if (m.canKick(0)) {
      const p = m.activePlayerFor(0);
      const goal = { x: m.teams[0].attackDir > 0 ? PITCH.length : 0, y: PITCH.width / 2 };
      m.aimKick(0, norm(sub(goal, p.pos)), 0.85);
      kicks++;
    }
    m.step(PHYSICS.dt);
    if (m.state === STATES.HALFTIME) m.resumeSecondHalf();
  }
  assert.equal(m.state, STATES.FULLTIME);
  assert.ok(kicks > 5, `expected the human to get the ball repeatedly, got ${kicks} kicks`);
});

test('with no input your player just dribbles, indefinitely', () => {
  const m = makeMatch({ seed: 15 });
  intoPlay(m);
  const p = m.teams[0].players[9];
  p.pos = { x: 40, y: 34 };
  giveBall(m, p);
  const start = { ...p.pos };
  // Twenty seconds with nobody touching a control and nobody to challenge.
  for (let i = 0; i < Math.round(20 / PHYSICS.dt); i++) {
    for (const o of m.teams[1].players) o.pos = { x: 8, y: 4 };
    m.step(PHYSICS.dt);
    if (m.state !== STATES.PLAY) break;
    assert.equal(m.ball.owner, p.id, `the ball was played for us after ${(i / 60).toFixed(1)} s`);
  }
  assert.ok(dist(start, p.pos) > 5, 'and they should actually be running with it, not standing still');
});

test('the opposition still take the ball off a dribbler, so play moves on', () => {
  const m = makeMatch({ seed: 15 });
  intoPlay(m);
  const p = m.teams[0].players[9];
  p.pos = { x: 40, y: 34 };
  giveBall(m, p);
  let lost = false;
  for (let i = 0; i < Math.round(30 / PHYSICS.dt); i++) {
    m.step(PHYSICS.dt);
    if (m.ball.owner !== p.id) {
      lost = true;
      break;
    }
  }
  assert.ok(lost, 'a dribbler with nobody helping should eventually be dispossessed');
});

test('the opposition decides for itself; only your side waits for you', () => {
  const m = makeMatch({ seed: 15 });
  intoPlay(m);
  assert.equal(m.isHumanTeam(0), true);
  assert.equal(m.isHumanTeam(1), false);
  const theirs = m.teams[1].players[9];
  giveBall(m, theirs);
  m.step(PHYSICS.dt);
  assert.equal(m.aiMayActFor(theirs), true, 'an AI carrier must be free to play the ball');
  assert.equal(m.aimHold, null, 'no hold timer runs while the opposition has it');

  const mine = m.teams[0].players[9];
  giveBall(m, mine);
  m.step(PHYSICS.dt);
  assert.equal(m.aiMayActFor(mine), false, 'your carrier must wait for you');
  assert.ok(m.aimHold && m.aimHold.playerId === mine.id, 'the hold timer should be running');
});

test('the other control styles do not accept aim input', () => {
  for (const control of [CONTROL.MANUAL, CONTROL.ASSISTED]) {
    const m = makeMatch({ control });
    assert.equal(m.aimControl, false);
    assert.equal(m.canKick(0), false);
    assert.equal(m.aimKick(0, { x: 1, y: 0 }, 1), false);
    assert.equal(m.press(0), false);
  }
});

test('a zero-length aim is rejected rather than firing the ball nowhere', () => {
  const m = makeMatch();
  intoPlay(m);
  const p = m.teams[0].players[6];
  giveBall(m, p);
  assert.equal(m.aimKick(0, { x: 0, y: 0 }, 0.5), false);
  assert.equal(m.ball.owner, p.id, 'the player should still have the ball');
});

// ---------------------------------------------------------------- drawn paths

// A quarter-circle traced to the left of straight ahead, as a finger would.
function curvePath(start, radius = 12, turns = 10) {
  const pts = [];
  for (let i = 0; i <= turns; i++) {
    const a = (i / turns) * (Math.PI / 2);
    pts.push({ x: start.x + Math.sin(a) * radius, y: start.y + (1 - Math.cos(a)) * radius });
  }
  return pts;
}

test('the ball is kicked towards where the line ended', () => {
  const m = makeMatch({ seed: 31 });
  intoPlay(m);
  const p = m.teams[0].players[9];
  p.pos = { x: 40, y: 20 };
  giveBall(m, p);
  parkEveryoneElse(m, p);
  const path = curvePath({ x: 40, y: 20 });
  const target = path[path.length - 1];
  assert.ok(m.aimPath(0, path));
  m.step(PHYSICS.dt);
  assert.equal(m.ball.owner, null, 'the ball should have been struck');
  const toTarget = norm(sub(target, p.pos));
  const travelling = norm(m.ball.vel);
  const agreement = travelling.x * toTarget.x + travelling.y * toTarget.y;
  assert.ok(agreement > 0.8, `ball is not heading for the target (dot ${agreement.toFixed(2)})`);
});

test('a ball drawn a short distance rolls up and stops near the spot', () => {
  const m = makeMatch({ seed: 31 });
  intoPlay(m);
  const p = m.teams[0].players[9];
  p.pos = { x: 30, y: 34 };
  giveBall(m, p);
  const clear = () => parkEveryoneElse(m, p);
  clear();
  const target = { x: 48, y: 34 };
  const line = [];
  for (let i = 0; i <= 8; i++) line.push({ x: 30 + (18 * i) / 8, y: 34 });
  assert.ok(m.aimPath(0, line));
  m.step(PHYSICS.dt); // the kick itself
  for (let i = 0; i < 400; i++) {
    parkAll(m); // including the kicker, who would otherwise chase their own pass
    m.step(PHYSICS.dt);
    if (len(m.ball.vel) < 0.4) break;
  }
  const missBy = dist(m.ball.pos, target);
  assert.ok(missBy < 6, `ball stopped ${missBy.toFixed(1)} m from where the line ended`);
});

test('a ball drawn a long way is lifted', () => {
  const m = makeMatch({ seed: 31 });
  intoPlay(m);
  const p = m.teams[0].players[9];
  p.pos = { x: 20, y: 34 };
  giveBall(m, p);
  parkEveryoneElse(m, p);
  const line = [];
  for (let i = 0; i <= 8; i++) line.push({ x: 20 + (45 * i) / 8, y: 34 });
  assert.ok(m.aimPath(0, line));
  let peak = 0;
  for (let i = 0; i < 200; i++) {
    parkAll(m);
    m.step(PHYSICS.dt);
    peak = Math.max(peak, m.ball.z);
  }
  assert.ok(peak > 2, `a long ball should be lifted, peaked at ${peak.toFixed(1)} m`);
});

// Sideways drift of the ball away from the straight line it was struck along.
function swerveOf(makeLine) {
  const m = makeMatch({ seed: 31 });
  intoPlay(m);
  const p = m.teams[0].players[9];
  p.pos = { x: 25, y: 34 };
  giveBall(m, p);
  const clear = () => parkEveryoneElse(m, p);
  clear();
  assert.ok(m.aimPath(0, makeLine({ x: 25, y: 34 })));
  m.step(PHYSICS.dt);
  const launch = norm(m.ball.vel);
  const from = { ...m.ball.pos };
  for (let i = 0; i < 120; i++) {
    parkAll(m);
    m.step(PHYSICS.dt);
  }
  const rel = sub(m.ball.pos, from);
  return rel.x * launch.y - rel.y * launch.x;
}

test('a curved line puts curl on the ball and a straight one does not', () => {
  const straight = swerveOf((s) => {
    const line = [];
    for (let i = 0; i <= 10; i++) line.push({ x: s.x + (24 * i) / 10, y: s.y });
    return line;
  });
  const curved = swerveOf((s) => curvePath(s, 24, 10));
  assert.ok(Math.abs(straight) < 1.5, `a straight line should not curl, drifted ${straight.toFixed(2)} m`);
  assert.ok(Math.abs(curved) > Math.abs(straight) + 1, `a curved line should curl, drifted ${curved.toFixed(2)} m`);
});

test('the same shape drawn anywhere produces the same kick', () => {
  const kickFrom = (drawnAt) => {
    const m = makeMatch({ seed: 31 });
    intoPlay(m);
    const p = m.teams[0].players[9];
    p.pos = { x: 30, y: 50 };
    giveBall(m, p);
    parkEveryoneElse(m, p);
    m.aimPath(0, curvePath(drawnAt));
    m.step(PHYSICS.dt);
    return { vel: { ...m.ball.vel }, vz: m.ball.vz, spin: m.ball.spin };
  };
  const a = kickFrom({ x: 30, y: 50 });
  const b = kickFrom({ x: 80, y: 10 });
  assert.ok(Math.abs(a.vel.x - b.vel.x) < 0.01 && Math.abs(a.vel.y - b.vel.y) < 0.01, 'the same shape should kick the same ball');
  assert.ok(Math.abs(a.spin - b.spin) < 0.01);
});

test('a ball struck from a drawn line can be intercepted', () => {
  const m = makeMatch({ seed: 31 });
  intoPlay(m);
  const p = m.teams[0].players[9];
  p.pos = { x: 40, y: 34 };
  giveBall(m, p);
  parkEveryoneElse(m, p);
  const blocker = m.teams[1].players[5];
  blocker.pos = { x: 50, y: 34 };
  blocker.kickCooldown = 0;
  const straight = [];
  for (let i = 0; i <= 12; i++) straight.push({ x: 40 + i * 1.5, y: 34 });
  assert.ok(m.aimPath(0, straight));
  let taken = false;
  for (let i = 0; i < 300; i++) {
    m.step(PHYSICS.dt);
    if (m.ball.owner === blocker.id || m.ball.lastTouch === blocker.id) {
      taken = true;
      break;
    }
  }
  assert.ok(taken, 'a defender on the line should be able to cut the ball out');
});

test('a longer line sends a harder ball', () => {
  const speeds = [];
  for (const reach of [6, 18, 40]) {
    const m = makeMatch({ seed: 31 });
    intoPlay(m);
    const p = m.teams[0].players[9];
    p.pos = { x: 30, y: 34 };
    giveBall(m, p);
    parkEveryoneElse(m, p);
    const line = [];
    for (let i = 0; i <= 10; i++) line.push({ x: 30 + (i / 10) * reach, y: 34 });
    m.aimPath(0, line);
    m.step(PHYSICS.dt);
    speeds.push(Math.hypot(m.ball.vel.x, m.ball.vel.y, m.ball.vz));
  }
  assert.ok(speeds[0] < speeds[1] && speeds[1] < speeds[2], `speeds not increasing: ${speeds.map((s) => s.toFixed(1))}`);
});

test('a path with fewer than two points is refused', () => {
  const m = makeMatch({ seed: 31 });
  intoPlay(m);
  giveBall(m, m.teams[0].players[9]);
  assert.equal(m.aimPath(0, []), false);
  assert.equal(m.aimPath(0, [{ x: 10, y: 10 }]), false);
  // Points all on top of each other collapse to one and are refused too.
  assert.equal(m.aimPath(0, [{ x: 10, y: 10 }, { x: 10.01, y: 10.01 }]), false);
});

test('a drawn path cannot be played without the ball', () => {
  const m = makeMatch({ seed: 31 });
  intoPlay(m);
  giveBall(m, m.teams[1].players[7]);
  assert.equal(m.aimPath(0, curvePath({ x: 40, y: 34 })), false);
});

test('a wild line is clamped and still produces a sane kick', () => {
  const m = makeMatch({ seed: 31 });
  intoPlay(m);
  const p = m.teams[0].players[9];
  p.pos = { x: 50, y: 34 };
  giveBall(m, p);
  const wild = [{ x: 50, y: 34 }, { x: 400, y: -900 }, { x: 900, y: 900 }];
  assert.ok(m.aimPath(0, wild));
  m.step(PHYSICS.dt);
  const speed = Math.hypot(m.ball.vel.x, m.ball.vel.y, m.ball.vz);
  assert.ok(Number.isFinite(speed), 'the kick must be finite');
  assert.ok(speed > 1 && speed <= PHYSICS.maxBallSpeed, `absurd kick speed ${speed}`);
});

test('a match still reaches full time when every ball is a drawn path', () => {
  const m = makeMatch({ durationMinutes: 1, seed: 33 });
  let paths = 0;
  let guard = 0;
  while (!m.isFinished() && guard++ < 60 * 60 * 8) {
    if (m.canKick(0)) {
      const active = m.activePlayerFor(0);
      const goal = { x: m.teams[0].attackDir > 0 ? PITCH.length : 0, y: PITCH.width / 2 };
      const line = [];
      for (let i = 0; i <= 8; i++) {
        const t = i / 8;
        line.push({ x: active.pos.x + (goal.x - active.pos.x) * t * 0.5, y: active.pos.y + (goal.y - active.pos.y) * t * 0.5 });
      }
      if (m.aimPath(0, line)) paths++;
    }
    m.step(PHYSICS.dt);
    if (m.state === STATES.HALFTIME) m.resumeSecondHalf();
  }
  assert.equal(m.state, STATES.FULLTIME);
  assert.ok(paths > 3, `expected several drawn passes, got ${paths}`);
  assert.ok(m.players.every((q) => Number.isFinite(q.pos.x)));
});

// -------------------------------------------------------- suggested target

test('the suggested target names a teammate worth passing to', () => {
  const m = makeMatch({ seed: 44 });
  intoPlay(m);
  const p = m.teams[0].players[6];
  p.pos = { x: 45, y: 34 };
  giveBall(m, p);
  const hint = m.suggestedTarget(0);
  assert.ok(hint, 'there should be a suggestion while you have the ball');
  assert.equal(hint.kind, 'pass');
  const mate = m.getPlayer(hint.playerId);
  assert.equal(mate.team, p.team, 'the suggestion must be a teammate');
  assert.notEqual(mate.id, p.id, 'it should not suggest passing to yourself');
  assert.ok(dist(hint.point, mate.pos) < 0.01, 'the marker sits on that player');
});

test('with a clear sight of goal the suggestion is to shoot', () => {
  const m = makeMatch({ seed: 44 });
  intoPlay(m);
  const p = m.teams[0].players[9];
  const goalX = m.teams[0].attackDir > 0 ? PITCH.length : 0;
  p.pos = { x: goalX - m.teams[0].attackDir * 12, y: PITCH.width / 2 };
  giveBall(m, p);
  // Nobody in the way.
  for (const o of m.teams[1].players) if (!o.isGK) o.pos = { x: goalX - m.teams[0].attackDir * 60, y: 4 };
  const hint = m.suggestedTarget(0);
  assert.ok(hint);
  assert.equal(hint.kind, 'shot');
  assert.ok(dist(hint.point, { x: goalX, y: PITCH.width / 2 }) < 3, 'the marker should be on the goal');
});

test('there is no suggestion when the ball is not yours', () => {
  const m = makeMatch({ seed: 44 });
  intoPlay(m);
  giveBall(m, m.teams[1].players[7]);
  assert.equal(m.suggestedTarget(0), null);
  m.ball.owner = null;
  assert.equal(m.suggestedTarget(0), null);
});

test('the suggestion never points at an offside teammate', () => {
  const m = makeMatch({ seed: 44 });
  intoPlay(m);
  const p = m.teams[0].players[6];
  p.pos = { x: 50, y: 34 };
  giveBall(m, p);
  for (const t of m.teams[0].players) t.offsideFlag = t.id !== p.id;
  assert.equal(m.suggestedTarget(0), null, 'with every teammate offside there is nobody to point at');
});
