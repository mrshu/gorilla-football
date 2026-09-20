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

test('a tap with the ball pushes it on and you chase it', () => {
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

test('your own carrier waits for you instead of shooting by itself', () => {
  const m = makeMatch({ seed: 15 });
  intoPlay(m);
  const p = m.teams[0].players[9];
  p.pos = { x: 60, y: 34 };
  giveBall(m, p);
  // Hold the ball for well under the grace period and give no input at all.
  for (let i = 0; i < Math.round((AIM.holdGrace - 1.5) / PHYSICS.dt); i++) {
    m.step(PHYSICS.dt);
    if (m.ball.owner === null) break;
    // Keep opponents away so only the AI's own choice could release the ball.
    for (const o of m.teams[1].players) if (!o.isGK) o.pos = { x: 15, y: 5 };
  }
  assert.equal(m.ball.owner, p.id, 'the carrier should still be waiting for the human');
});

test('but the carrier plays on eventually so an idle match never stalls', () => {
  const m = makeMatch({ seed: 15 });
  intoPlay(m);
  const p = m.teams[0].players[9];
  p.pos = { x: 60, y: 34 };
  giveBall(m, p);
  let released = false;
  for (let i = 0; i < Math.round((AIM.holdGrace + 4) / PHYSICS.dt); i++) {
    m.step(PHYSICS.dt);
    for (const o of m.teams[1].players) if (!o.isGK) o.pos = { x: 15, y: 5 };
    if (m.ball.owner === null) {
      released = true;
      break;
    }
  }
  assert.ok(released, 'the carrier should play the ball after the grace period');
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
