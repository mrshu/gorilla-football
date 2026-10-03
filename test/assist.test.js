import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Match } from '../src/game/match.js';
import { normalizeConfig, MODES, CONTROL } from '../src/game/config.js';
import { PHYSICS, STATES, SET_PIECES, DECISION } from '../src/game/constants.js';
import { dist } from '../src/game/vec.js';

// Assisted control is opt-in, so these tests ask for it explicitly.
function makeMatch(over = {}) {
  const cfg = normalizeConfig({ mode: MODES.SOLO, control: CONTROL.ASSISTED, durationMinutes: 5, seed: 21, humans: [{ characterId: 'plumber' }], ...over });
  return new Match(cfg);
}

// Advance the match, answering every decision with `answer` (default: dribble,
// or pass at a restart where dribbling is not offered).
function run(m, seconds, answer) {
  const steps = Math.round(seconds / PHYSICS.dt);
  for (let i = 0; i < steps; i++) {
    m.step(PHYSICS.dt);
    if (m.pendingDecision) {
      const trigger = m.pendingDecision.trigger;
      const choice = answer ? answer(m.pendingDecision, m) : defaultAnswer(m.pendingDecision);
      if (!choice) continue; // caller wants the decision left open
      assert.ok(m.resolveDecision(choice), `decision ${trigger} could not be resolved`);
    }
  }
}

function defaultAnswer(d) {
  const dribble = d.options.find((o) => o.id === 'dribble');
  if (dribble) return { id: 'dribble' };
  const pass = d.options.find((o) => o.id === 'pass');
  if (pass) return { id: 'pass', targetId: pass.targetId };
  return { id: 'shoot' };
}

// Reach open play with the human on the ball, without using the panel.
function possessionInPlay(m) {
  let guard = 0;
  while (m.state !== STATES.PLAY && guard++ < 3000) {
    m.step(PHYSICS.dt);
    if (m.pendingDecision) m.resolveDecision(defaultAnswer(m.pendingDecision));
  }
  const p = m.humanPlayer(0);
  assert.equal(m.state, STATES.PLAY);
  m.pendingDecision = null;
  m.ball.owner = p.id;
  m.ball.homing = null;
  m.snapBallToOwner(p);
  m.decisionCarry = null;
  return p;
}

test('whole-team aim control is the default; the others are opt-in', () => {
  assert.equal(normalizeConfig({}).control, CONTROL.AIM);
  assert.equal(normalizeConfig({}).aimControl, true);
  assert.equal(normalizeConfig({}).assist, false);
  assert.equal(normalizeConfig({ control: CONTROL.MANUAL }).control, CONTROL.MANUAL);
  assert.equal(normalizeConfig({ control: CONTROL.ASSISTED }).assist, true);
  // An unrecognised value falls back to the default rather than throwing.
  assert.equal(normalizeConfig({ control: 'nonsense' }).control, CONTROL.AIM);
});

test('the human player moves on their own with no input at all', () => {
  const m = makeMatch();
  const p = m.humanPlayer(0);
  run(m, 6);
  const start = { ...p.pos };
  run(m, 4);
  assert.ok(dist(start, p.pos) > 2, `assisted player stayed put (moved ${dist(start, p.pos).toFixed(2)} m)`);
});

// Distance actually run by the human's player over `seconds` with no joystick
// input, answering any decision with dribble. Measures path length rather than
// displacement, because a stationary player is still jostled by the crowd.
function idlePathLength(control, seconds) {
  const m = makeMatch({ control });
  const p = m.humanPlayer(0);
  for (let i = 0; i < 400 && m.state !== STATES.PLAY; i++) {
    if (i > 70) m.setHumanInput(0, { pass: true });
    m.step(PHYSICS.dt);
    if (m.pendingDecision) m.resolveDecision(defaultAnswer(m.pendingDecision));
  }
  let path = 0;
  let prev = { ...p.pos };
  for (let i = 0; i < Math.round(seconds / PHYSICS.dt); i++) {
    m.step(PHYSICS.dt);
    if (m.pendingDecision) m.resolveDecision({ id: 'dribble' });
    path += dist(prev, p.pos);
    prev = { ...p.pos };
  }
  return path;
}

test('a manually controlled player does not run on their own', () => {
  const manual = idlePathLength(CONTROL.MANUAL, 5);
  const assisted = idlePathLength(CONTROL.ASSISTED, 5);
  assert.ok(assisted > 15, `assisted player barely ran (${assisted.toFixed(1)} m in 5 s)`);
  assert.ok(manual < assisted / 3, `manual player ran ${manual.toFixed(1)} m against the assisted ${assisted.toFixed(1)} m`);
});

test('the restart freezes and asks the human what to do', () => {
  const m = makeMatch();
  run(m, 3, () => null); // never answer
  assert.ok(m.pendingDecision, 'no decision raised at kickoff');
  const d = m.pendingDecision;
  assert.equal(d.trigger, 'set_piece');
  assert.equal(d.setPieceKind, SET_PIECES.KICKOFF);
  assert.equal(d.playerId, m.humanPlayer(0).id);
  assert.ok(d.options.some((o) => o.id === 'shoot'));
  assert.ok(d.options.some((o) => o.id === 'pass'));
  assert.ok(!d.options.some((o) => o.id === 'dribble'), 'a restart must be played, not dribbled');
});

test('everything is frozen while a decision is pending', () => {
  const m = makeMatch();
  run(m, 3, () => null);
  assert.ok(m.pendingDecision);
  const clock = m.clock.time;
  const time = m.time;
  const positions = m.players.map((p) => ({ ...p.pos }));
  const ball = { ...m.ball.pos };
  for (let i = 0; i < 120; i++) m.step(PHYSICS.dt);
  assert.equal(m.clock.time, clock, 'match clock advanced during a decision');
  assert.equal(m.time, time, 'simulation time advanced during a decision');
  assert.deepEqual(m.ball.pos, ball, 'ball moved during a decision');
  assert.deepEqual(m.players.map((p) => ({ ...p.pos })), positions, 'players moved during a decision');
});

test('taking possession in open play opens a decision', () => {
  const m = makeMatch();
  const p = possessionInPlay(m);
  m.step(PHYSICS.dt);
  assert.ok(m.pendingDecision, 'no decision when the human won the ball');
  assert.equal(m.pendingDecision.trigger, 'possession');
  assert.equal(m.pendingDecision.playerId, p.id);
  const ids = m.pendingDecision.options.map((o) => o.id);
  for (const id of ['shoot', 'pass', 'special', 'dribble']) assert.ok(ids.includes(id), `missing option ${id}`);
});

test('choosing shoot shoots, and the panel closes', () => {
  const m = makeMatch();
  const p = possessionInPlay(m);
  p.pos = { x: 90, y: 34 };
  m.snapBallToOwner(p);
  m.step(PHYSICS.dt);
  m.drainEvents();
  assert.ok(m.pendingDecision);
  assert.ok(m.resolveDecision({ id: 'shoot' }));
  assert.equal(m.pendingDecision, null);
  const events = m.drainEvents();
  assert.ok(events.some((e) => e.type === 'shot'), 'no shot was taken');
  assert.equal(m.ball.owner, null);
});

test('choosing a pass sends the ball towards that exact teammate', () => {
  const m = makeMatch();
  const p = possessionInPlay(m);
  m.step(PHYSICS.dt);
  const d = m.pendingDecision;
  const option = d.options.filter((o) => o.id === 'pass').pop();
  const target = m.getPlayer(option.targetId);
  const before = dist(m.ball.pos, target.pos);
  assert.ok(m.resolveDecision({ id: 'pass', targetId: option.targetId }));
  for (let i = 0; i < 12; i++) m.step(PHYSICS.dt);
  assert.ok(dist(m.ball.pos, target.pos) < before, 'ball did not travel towards the chosen teammate');
});

test('choosing the special fires it and spends a use', () => {
  const m = makeMatch({ humans: [{ characterId: 'gorilla' }] });
  const p = possessionInPlay(m);
  m.step(PHYSICS.dt);
  assert.ok(m.pendingDecision);
  assert.equal(p.ability.usesLeft, 10);
  assert.ok(m.resolveDecision({ id: 'special' }));
  assert.equal(p.ability.usesLeft, 9);
  assert.ok(m.ball.unstoppable, 'the guaranteed goal did not launch');
});

test('an unusable special is offered but disabled, and cannot be chosen', () => {
  const m = makeMatch();
  const p = possessionInPlay(m);
  p.ability.cooldown = 8;
  m.step(PHYSICS.dt);
  const option = m.pendingDecision.options.find((o) => o.id === 'special');
  assert.ok(option, 'special should still be listed');
  assert.equal(option.disabled, true);
  assert.equal(m.resolveDecision({ id: 'special' }), false, 'a disabled option must not resolve');
  assert.ok(m.pendingDecision, 'panel should stay open after a rejected choice');
});

test('a staged restart disables specials and cannot silently take an automatic pass', () => {
  const m = makeMatch({ humans: [{ characterId: 'gorilla' }] });
  run(m, 3, () => null);
  const decision = m.pendingDecision;
  const restart = m.setPiece;
  const player = m.getPlayer(decision.playerId);
  const special = decision.options.find((option) => option.id === 'special');
  assert.equal(special.disabled, true);
  assert.equal(special.detail, 'Available in open play');
  m.drainEvents();
  assert.equal(m.resolveDecision({ id: 'special' }), false);
  assert.equal(m.pendingDecision, decision);
  assert.equal(m.setPiece, restart);
  assert.equal(m.ball.owner, player.id);
  assert.equal(player.ability.usesLeft, 10);
  assert.deepEqual(m.drainEvents(), [], 'rejecting the special must not pass or fire it');
  assert.ok(m.resolveDecision(defaultAnswer(decision)), 'a legal kick can still take the restart');
  assert.equal(m.state, STATES.PLAY);
});

test('a recovering player has a disabled paced special until recovery completes', () => {
  for (const recovery of ['stun', 'frozen']) {
    const m = makeMatch({ humans: [{ characterId: 'gorilla' }] });
    const player = possessionInPlay(m);
    player[recovery] = 1;
    m.openDecision(player, 'possession');
    const special = m.pendingDecision.options.find((option) => option.id === 'special');
    assert.equal(special.disabled, true, recovery);
    assert.match(special.detail, /Recovering/);
    assert.equal(m.resolveDecision({ id: 'special' }), false);
    assert.equal(player.ability.usesLeft, 10);
    assert.ok(m.pendingDecision);
    m.clearDecision();
    player[recovery] = 0;
    m.openDecision(player, 'possession');
    assert.equal(m.pendingDecision.options.find((option) => option.id === 'special').disabled, false);
    assert.ok(m.resolveDecision({ id: 'special' }));
    assert.equal(player.ability.usesLeft, 9);
  }
});

test('special eligibility is rechecked if the player changes after the decision opens', () => {
  const m = makeMatch({ humans: [{ characterId: 'gorilla' }] });
  const player = possessionInPlay(m);
  m.openDecision(player, 'possession');
  assert.equal(m.pendingDecision.options.find((option) => option.id === 'special').disabled, false);
  player.stun = 1;
  assert.equal(m.resolveDecision({ id: 'special' }), false);
  assert.ok(m.pendingDecision);
  assert.equal(player.ability.usesLeft, 10);
});

test('an unknown choice is rejected and leaves the panel open', () => {
  const m = makeMatch();
  possessionInPlay(m);
  m.step(PHYSICS.dt);
  assert.equal(m.resolveDecision({ id: 'nonsense' }), false);
  assert.ok(m.pendingDecision);
});

test('dribbling carries on and asks again a few seconds later', () => {
  const m = makeMatch();
  possessionInPlay(m);
  m.step(PHYSICS.dt);
  assert.ok(m.resolveDecision({ id: 'dribble' }));
  assert.equal(m.pendingDecision, null);
  let steps = 0;
  const limit = Math.round((DECISION.carryGap + 1.5) / PHYSICS.dt);
  while (!m.pendingDecision && steps < limit) {
    m.step(PHYSICS.dt);
    steps++;
  }
  assert.ok(m.pendingDecision, 'the panel never reopened while carrying');
});

test('no decisions are raised in manual control', () => {
  const m = makeMatch({ control: CONTROL.MANUAL });
  for (let i = 0; i < 1200; i++) {
    if (i > 70) m.setHumanInput(0, { pass: true });
    m.step(PHYSICS.dt);
    assert.equal(m.pendingDecision, null, 'manual control must never pause');
  }
});

test('an assisted match plays to full time when every decision is answered', () => {
  const m = makeMatch({ durationMinutes: 2 });
  let decisions = 0;
  let guard = 0;
  while (!m.isFinished() && guard++ < 60 * 60 * 6) {
    m.step(PHYSICS.dt);
    if (m.pendingDecision) {
      decisions++;
      m.resolveDecision(defaultAnswer(m.pendingDecision));
    }
    if (m.state === STATES.HALFTIME) m.resumeSecondHalf();
  }
  assert.equal(m.state, STATES.FULLTIME);
  assert.ok(decisions > 3, `expected several decisions, saw ${decisions}`);
});

test('the human keeps the ball while a restart decision is open', () => {
  const m = makeMatch();
  run(m, 3, () => null);
  const d = m.pendingDecision;
  assert.equal(m.ball.owner, d.playerId, 'taker should be holding the ball');
  assert.ok(m.resolveDecision(defaultAnswer(d)));
  assert.equal(m.state, STATES.PLAY, 'resolving a restart decision must restart play');
});
