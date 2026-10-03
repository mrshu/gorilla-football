import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Match } from '../src/game/match.js';
import { normalizeConfig } from '../src/game/config.js';
import { PHYSICS, PITCH, STATES } from '../src/game/constants.js';
import { updateOutfieldAI } from '../src/game/ai.js';
import { simulateMatch } from '../scripts/simulate.js';

function openMatch(control = 'aim') {
  const m = new Match(normalizeConfig({ control, seed: 41, durationMinutes: 1 }));
  m.state = STATES.PLAY;
  m.setPiece = null;
  for (const p of m.players) {
    p.pos = { x: 30 + p.team * 10, y: 2 + p.slot * 2 };
    p.vel = { x: 0, y: 0 };
    p.frozen = 100;
  }
  m.drainEvents();
  return m;
}

function carry(m, p, pos, facing) {
  p.pos = pos;
  p.facing = facing;
  p.frozen = 0;
  m.ball.owner = p.id;
  m.snapBallToOwner(p);
}

test('keepers close down and claim an unopposed idle dribble from either end', () => {
  for (const attackDir of [1, -1]) {
    const m = openMatch();
    m.teams[0].attackDir = attackDir;
    m.teams[1].attackDir = -attackDir;
    const carrier = m.teams[0].players[9];
    const keeper = m.teams[1].players[0];
    carry(m, carrier, { x: attackDir === 1 ? 95 : 10, y: 34 }, { x: attackDir, y: 0 });
    keeper.pos = { x: attackDir === 1 ? 103 : 2, y: 34 };
    keeper.frozen = 0;
    for (let i = 0; i < 180 && m.ball.owner === carrier.id; i++) m.step(PHYSICS.dt);
    assert.equal(m.ball.owner, keeper.id, 'the keeper must meet and collect the dribble');
    assert.equal(m.teams[0].score, 0);
    assert.deepEqual(m.stats.shots, [0, 0]);
    assert.ok(m.drainEvents().some((e) => e.type === 'claim' && e.victimId === carrier.id));
  }
});

test('keepers cannot scoop an owned dribble outside their box or through tackle immunity', () => {
  for (const scenario of ['outside', 'immune', 'frozen', 'teammate']) {
    const m = openMatch();
    const carrier = m.teams[scenario === 'teammate' ? 1 : 0].players[9];
    const keeper = m.teams[1].players[0];
    const x = scenario === 'outside' ? 85 : 99;
    carry(m, carrier, { x, y: 34 }, { x: 1, y: 0 });
    keeper.pos = { x: x + 1.2, y: 34 };
    keeper.frozen = scenario === 'frozen' ? 1 : 0;
    carrier.untackleable = scenario === 'immune' ? 1 : 0;
    m.updatePossession(PHYSICS.dt);
    assert.equal(m.ball.owner, carrier.id, scenario);
  }
});

test('a legal dribble over an unguarded goal line still scores without a shot', () => {
  const m = openMatch();
  const carrier = m.teams[0].players[9];
  carry(m, carrier, { x: PITCH.length - 0.4, y: 34 }, { x: 1, y: 0 });
  m.step(PHYSICS.dt);
  assert.equal(m.teams[0].score, 1);
  assert.equal(m.stats.shots[0], 0);
});

test('AI defenders approach from behind without immediately tackling', () => {
  const m = openMatch();
  const carrier = m.teams[0].players[9];
  const defender = m.teams[1].players[2];
  carry(m, carrier, { x: 50, y: 34 }, { x: 1, y: 0 });
  defender.pos = { x: 48.5, y: 34 };
  defender.frozen = 0;
  m.frameCache = m.buildFrameCache(carrier);
  let attempts = 0;
  m.attemptTackle = () => attempts++;
  for (let i = 0; i < 60; i++) updateOutfieldAI(m, defender, PHYSICS.dt);
  assert.equal(attempts, 0);
  assert.ok(defender.desiredVel.x > 0 && Math.abs(defender.desiredVel.y) > 0, 'the defender approaches alongside the carrier');
  defender.pos = { x: 51.5, y: 34 };
  for (let i = 0; i < 10; i++) updateOutfieldAI(m, defender, PHYSICS.dt);
  assert.equal(attempts, 0, 'a front-on defender waits to set their feet');
  for (let i = 0; i < 60; i++) updateOutfieldAI(m, defender, PHYSICS.dt);
  assert.equal(attempts, 1, 'the safe challenge is made once and then cools down');
});

test('human tackles retain foul and card consequences', () => {
  const m = openMatch('manual');
  const tackler = m.humanPlayer(0);
  const carrier = m.teams[1].players[9];
  carry(m, carrier, { x: 50, y: 34 }, { x: 1, y: 0 });
  tackler.pos = { x: 48.5, y: 34 };
  tackler.frozen = 0;
  const rolls = [0.99, 0, 0.05];
  m.rng.next = () => rolls.shift() ?? 0.5;
  m.attemptTackle(tackler, false);
  assert.equal(m.stats.fouls[0], 1);
  assert.equal(m.state, STATES.SET_PIECE);
  assert.equal(tackler.yellowCards, 1);
});

test('representative AI and idle runs finish without recurring kickoff fouls or idle dribble goals', () => {
  let openingFouls = 0;
  let aiShots = 0;
  for (let seed = 1; seed <= 8; seed++) {
    for (const mode of ['ai', 'idle']) {
      const result = simulateMatch({ seed, mode, minutes: 1 });
      assert.ok(result.finished, `${mode} seed ${seed} must finish`);
      openingFouls += result.metrics.earlyFouls;
      if (mode === 'idle') assert.equal(result.metrics.carriedGoals[0], 0, `idle seed ${seed}`);
      else aiShots += result.stats.shots[0];
    }
  }
  assert.ok(openingFouls <= 4, `expected occasional opening fouls, got ${openingFouls}`);
  assert.ok(aiShots > 0, 'true AI carriers must be allowed to shoot');
});
