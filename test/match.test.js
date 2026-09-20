import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Match } from '../src/game/match.js';
import { normalizeConfig, MODES } from '../src/game/config.js';
import { PHYSICS, STATES, SET_PIECES, PITCH } from '../src/game/constants.js';

// These tests cover the manual control path; the assisted path (AI-driven
// human player plus decision pauses) is covered in assist.test.js.
function makeMatch(over = {}) {
  const cfg = normalizeConfig({ mode: MODES.SOLO, control: 'manual', durationMinutes: 2, seed: 99, humans: [{ characterId: 'gorilla' }], ...over });
  return new Match(cfg);
}

function run(m, seconds, onStep) {
  const steps = Math.round(seconds / PHYSICS.dt);
  for (let i = 0; i < steps; i++) {
    m.step(PHYSICS.dt);
    if (onStep) onStep(i);
  }
}

function finite(o) {
  return Number.isFinite(o.x) && Number.isFinite(o.y);
}

test('config normalisation assigns humans to teams and slots', () => {
  const solo = normalizeConfig({ mode: MODES.SOLO, humans: [{ characterId: 'plumber' }] });
  assert.equal(solo.humans.length, 1);
  assert.equal(solo.teams[0].roster[solo.humans[0].slot], 'plumber');
  const versus = normalizeConfig({ mode: MODES.VERSUS, humans: [{ characterId: 'gorilla' }, { characterId: 'wizard' }] });
  assert.deepEqual(versus.humans.map((h) => h.team), [0, 1]);
  assert.equal(versus.teams[1].roster[versus.humans[1].slot], 'wizard');
  const coop = normalizeConfig({ mode: MODES.COOP, humans: [{ characterId: 'gorilla' }, { characterId: 'wizard' }] });
  assert.deepEqual(coop.humans.map((h) => h.team), [0, 0]);
  assert.notEqual(coop.humans[0].slot, coop.humans[1].slot);
});

test('config rejects identical jerseys by picking a distinct one', () => {
  const cfg = normalizeConfig({ teams: [{ presetId: 'jungle', jerseyId: 'red' }, { presetId: 'pipeworks', jerseyId: 'red' }] });
  assert.notEqual(cfg.teams[0].jersey.id, cfg.teams[1].jersey.id);
});

test('config validates duration', () => {
  assert.throws(() => normalizeConfig({ durationMinutes: 0 }));
  assert.throws(() => normalizeConfig({ durationMinutes: -3 }));
  assert.equal(normalizeConfig({ durationMinutes: 5 }).halfSeconds, 150);
});

test('match starts with a kickoff and 22 players, 11 per side', () => {
  const m = makeMatch();
  assert.equal(m.state, STATES.KICKOFF);
  assert.equal(m.players.length, 22);
  assert.equal(m.teams[0].players.length, 11);
  assert.ok(m.teams[0].players[0].isGK);
  assert.equal(m.humanPlayer(0).character.id, 'gorilla');
  assert.equal(m.humanPlayer(0).team, 0);
});

test('a full AI match plays two halves, switches sides and finishes', () => {
  const m = makeMatch({ durationMinutes: 1 });
  for (const p of m.players) p.human = null;
  const attackBefore = m.teams[0].attackDir;
  let sawHalftime = false;
  let steps = 0;
  while (!m.isFinished() && steps < 60 * 60 * 10) {
    m.step(PHYSICS.dt);
    steps++;
    if (m.state === STATES.HALFTIME) {
      sawHalftime = true;
      assert.equal(m.clock.half, 1);
      m.resumeSecondHalf();
      assert.equal(m.clock.half, 2);
      assert.equal(m.teams[0].attackDir, -attackBefore, 'teams switch sides at halftime');
    }
    for (const p of m.players) assert.ok(finite(p.pos) && finite(p.vel), 'player state stays finite');
    assert.ok(finite(m.ball.pos), 'ball stays finite');
  }
  assert.ok(sawHalftime);
  assert.equal(m.state, STATES.FULLTIME);
  const events = m.drainEvents();
  assert.ok(events.some((e) => e.type === 'fulltime'));
});

test('the clock does not run during restarts and stops at the half', () => {
  const m = makeMatch({ durationMinutes: 1 });
  for (const p of m.players) p.human = null;
  run(m, 0.5);
  assert.equal(m.clock.time, 0, 'clock paused during kickoff setup');
  run(m, 40);
  assert.ok(m.clock.time > 0);
  assert.ok(m.clock.time <= m.clock.halfSeconds);
});

test('a ball crossing the line between the posts is a goal and triggers a kickoff for the conceding team', () => {
  const m = makeMatch();
  for (const p of m.players) p.human = null;
  run(m, 3); // kickoff completes
  assert.equal(m.state, STATES.PLAY);
  // Force the ball into team 1's goal (team 0 attacks +x).
  m.ball.owner = null;
  m.ball.homing = null;
  m.ball.pos = { x: PITCH.length - 1, y: PITCH.width / 2 };
  m.ball.vel = { x: 40, y: 0 };
  m.ball.z = 0;
  m.ball.lastTouch = m.teams[0].players[9].id;
  m.ball.lastTouchTeam = 0;
  for (const p of m.players) p.pos = { x: 20, y: 20 }; // nobody near the ball
  run(m, 0.2);
  assert.equal(m.teams[0].score, 1);
  assert.equal(m.state, STATES.GOAL);
  const events = m.drainEvents();
  const goal = events.find((e) => e.type === 'goal');
  assert.ok(goal);
  assert.equal(goal.team, 0);
  run(m, 3);
  assert.equal(m.state, STATES.KICKOFF);
  assert.equal(m.setPiece.team, 1, 'conceding team kicks off');
});

test('ball over the touchline produces a throw-in set piece', () => {
  const m = makeMatch();
  for (const p of m.players) p.human = null;
  run(m, 3);
  m.ball.owner = null;
  m.ball.pos = { x: 50, y: 0.5 };
  m.ball.vel = { x: 0, y: -15 };
  m.ball.lastTouchTeam = 0;
  for (const p of m.players) p.pos = { x: 20, y: 30 };
  run(m, 0.3);
  assert.equal(m.state, STATES.SET_PIECE);
  assert.equal(m.setPiece.kind, SET_PIECES.THROW_IN);
  assert.equal(m.setPiece.team, 1);
});

test('gorilla special is a guaranteed goal and is capped at 10 uses', () => {
  const m = makeMatch({ durationMinutes: 10 });
  for (const p of m.players) if (p.human === null) p.ai.disabled = true;
  run(m, 3);
  const g = m.humanPlayer(0);
  assert.equal(g.ability.usesLeft, 10);
  let goalsBefore = m.teams[0].score;
  for (let i = 0; i < 10; i++) {
    // Give the gorilla the ball deep in its own half so the ability must work from far away too.
    if (m.state !== STATES.PLAY) {
      // finish celebrations / kickoff quickly
      let guard = 0;
      while (m.state !== STATES.PLAY && guard++ < 600) m.step(PHYSICS.dt);
    }
    g.pos = { x: i % 2 === 0 ? 30 : 80, y: 20 };
    g.stun = 0;
    g.frozen = 0;
    m.ball.owner = g.id;
    m.ball.homing = null;
    m.snapBallToOwner(g);
    g.ability.cooldown = 0;
    m.setHumanInput(0, { special: true });
    m.step(PHYSICS.dt);
    assert.equal(g.ability.usesLeft, 9 - i, `use ${i + 1} consumed`);
    let guard = 0;
    while (m.teams[0].score === goalsBefore && guard++ < 60 * 8) m.step(PHYSICS.dt);
    assert.equal(m.teams[0].score, goalsBefore + 1, `special ${i + 1} produced a goal`);
    goalsBefore = m.teams[0].score;
    m.drainEvents();
  }
  // 11th attempt does nothing.
  let guard = 0;
  while (m.state !== STATES.PLAY && guard++ < 600) m.step(PHYSICS.dt);
  g.pos = { x: 60, y: 34 };
  m.ball.owner = g.id;
  m.snapBallToOwner(g);
  g.ability.cooldown = 0;
  const before = m.teams[0].score;
  m.setHumanInput(0, { special: true });
  run(m, 2);
  assert.equal(g.ability.usesLeft, 0);
  assert.equal(m.teams[0].score, before, 'no 11th guaranteed goal');
});

test('a red card removes the player and hands human control to a teammate', () => {
  const m = makeMatch();
  run(m, 3);
  const g = m.humanPlayer(0);
  const victim = m.teams[1].players[9];
  // Force a foul with a red card
  m.commitFoul(g, victim, 'red');
  assert.ok(g.sentOff);
  assert.equal(g.human, null);
  const newHuman = m.humanPlayer(0);
  assert.ok(newHuman && newHuman.team === 0 && !newHuman.isGK);
  assert.equal(m.cards.length, 1);
  assert.equal(m.cards[0].card, 'red');
  assert.equal(m.state, STATES.SET_PIECE);
  assert.equal(m.setPiece.team, 1);
  assert.equal(m.teams[0].players.filter((p) => !p.sentOff).length, 10);
});

test('two yellow cards equal a red', () => {
  const m = makeMatch();
  run(m, 3);
  const p = m.teams[1].players[5];
  const victim = m.teams[0].players[9];
  m.commitFoul(p, victim, 'yellow');
  assert.equal(p.yellowCards, 1);
  assert.ok(!p.sentOff);
  m.commitFoul(p, victim, 'yellow');
  assert.ok(p.sentOff);
  const cards = m.cards.map((c) => c.card);
  assert.deepEqual(cards, ['yellow', 'red']);
});

test('a foul inside the defending box gives a penalty taken by the human', () => {
  const m = makeMatch();
  run(m, 3);
  const g = m.humanPlayer(0);
  const fouler = m.teams[1].players[2];
  fouler.pos = { x: PITCH.length - 8, y: PITCH.width / 2 };
  g.pos = { x: PITCH.length - 8, y: PITCH.width / 2 + 1 };
  m.commitFoul(fouler, g, null);
  assert.equal(m.state, STATES.SET_PIECE);
  assert.equal(m.setPiece.kind, SET_PIECES.PENALTY);
  assert.equal(m.setPiece.takerId, g.id);
  assert.deepEqual(m.ball.pos, { x: PITCH.length - PITCH.penaltySpot, y: PITCH.width / 2 });
});

test('an offside player touching the ball concedes a free kick', () => {
  const m = makeMatch();
  for (const p of m.players) p.human = null;
  run(m, 3);
  assert.equal(m.state, STATES.PLAY);
  const passer = m.teams[0].players[6];
  const striker = m.teams[0].players[9];
  // Team 0 attacks +x. Put every opponent except the GK behind the striker.
  for (const o of m.teams[1].players) o.pos = { x: 60, y: 10 + o.slot * 4 };
  m.teams[1].players[0].pos = { x: 104, y: 34 };
  for (const t of m.teams[0].players) t.pos = { x: 30, y: 10 + t.slot * 4 };
  passer.pos = { x: 62, y: 34 };
  striker.pos = { x: 80, y: 34 };
  m.ball.owner = passer.id;
  m.snapBallToOwner(passer);
  m.passTo(passer, striker);
  assert.ok(striker.offsideFlag, 'striker flagged at the moment of the pass');
  // Move the striker onto the ball so they touch it.
  striker.stun = 0;
  striker.kickCooldown = 0;
  let guard = 0;
  while (m.state === STATES.PLAY && guard++ < 300) {
    striker.pos = { ...m.ball.pos };
    m.step(PHYSICS.dt);
  }
  assert.equal(m.state, STATES.SET_PIECE);
  assert.equal(m.setPiece.kind, SET_PIECES.FREE_KICK);
  assert.equal(m.setPiece.team, 1);
  assert.ok(m.drainEvents().some((e) => e.type === 'offside'));
});

test('simulation is deterministic for a given seed', () => {
  const a = makeMatch({ seed: 5 });
  const b = makeMatch({ seed: 5 });
  for (const p of a.players) p.human = null;
  for (const p of b.players) p.human = null;
  run(a, 20);
  run(b, 20);
  assert.deepEqual(a.ball.pos, b.ball.pos);
  assert.deepEqual(a.players.map((p) => p.pos), b.players.map((p) => p.pos));
});
