import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listAbilities, getAbility } from '../src/game/abilities.js';
import { CHARACTERS, STAT_KEYS } from '../src/data/characters.js';
import { TEAM_PRESETS } from '../src/data/teams.js';
import { JERSEYS, jerseysDistinct } from '../src/data/jerseys.js';
import { Match } from '../src/game/match.js';
import { normalizeConfig, MODES } from '../src/game/config.js';
import { PHYSICS } from '../src/game/constants.js';

test('every character has all stats in range and a registered ability', () => {
  assert.ok(CHARACTERS.length >= 6, 'gorilla, plumber and at least four more');
  for (const c of CHARACTERS) {
    for (const k of STAT_KEYS) {
      assert.ok(Number.isInteger(c.stats[k]) && c.stats[k] >= 1 && c.stats[k] <= 10, `${c.id}.${k}`);
    }
    const ab = getAbility(c.abilityId);
    assert.equal(typeof ab.activate, 'function');
    assert.equal(typeof ab.canActivate, 'function');
  }
  const ids = new Set(CHARACTERS.map((c) => c.abilityId));
  assert.equal(ids.size, CHARACTERS.length, 'each character has a distinct ability');
});

test('gorilla ability has exactly 10 uses; others are unlimited', () => {
  assert.equal(getAbility('gorilla_slam').maxUses, 10);
  for (const ab of listAbilities()) if (ab.id !== 'gorilla_slam') assert.equal(ab.maxUses, undefined);
});

test('characters differ substantially, not by tiny increments', () => {
  const spread = STAT_KEYS.map((k) => {
    const vals = CHARACTERS.map((c) => c.stats[k]);
    return Math.max(...vals) - Math.min(...vals);
  });
  for (const s of spread) assert.ok(s >= 5, 'each stat spans at least half the scale across the roster');
});

test('team presets have 11 valid characters each', () => {
  const ids = new Set(CHARACTERS.map((c) => c.id));
  for (const t of TEAM_PRESETS) {
    assert.equal(t.roster.length, 11);
    for (const id of t.roster) assert.ok(ids.has(id), id);
  }
});

test('jersey distinctness check', () => {
  assert.ok(!jerseysDistinct(JERSEYS[0], JERSEYS[0]));
  assert.ok(jerseysDistinct(JERSEYS[0], JERSEYS[1]));
});

function playingMatch(humanChar, seed = 3) {
  const cfg = normalizeConfig({ mode: MODES.SOLO, control: 'manual', durationMinutes: 5, seed, humans: [{ characterId: humanChar }] });
  const m = new Match(cfg);
  // The human is the kickoff taker, so press pass once the restart is set.
  for (let i = 0; i < 400 && m.state !== 'PLAY'; i++) {
    if (i > 70) m.setHumanInput(0, { pass: true });
    m.step(PHYSICS.dt);
  }
  assert.equal(m.state, 'PLAY');
  return m;
}

test('turbo hop grants speed and tackle immunity for 3 s', () => {
  const m = playingMatch('plumber');
  const p = m.humanPlayer(0);
  m.setHumanInput(0, { special: true });
  m.step(PHYSICS.dt);
  assert.ok(p.speedBoost > 2.9 && p.untackleable > 2.9);
  assert.ok(p.ability.cooldown > 0);
  for (let i = 0; i < 200; i++) m.step(PHYSICS.dt);
  assert.equal(p.speedBoost, 0);
});

test('cold snap freezes only nearby opponents', () => {
  const m = playingMatch('yeti');
  const y = m.humanPlayer(0);
  const near = m.teams[1].players[5];
  const far = m.teams[1].players[6];
  const mate = m.teams[0].players[5];
  near.pos = { x: y.pos.x + 3, y: y.pos.y };
  far.pos = { x: y.pos.x + 30, y: y.pos.y };
  mate.pos = { x: y.pos.x + 2, y: y.pos.y };
  m.setHumanInput(0, { special: true });
  m.step(PHYSICS.dt);
  assert.ok(near.frozen > 2);
  assert.equal(far.frozen, 0);
  assert.equal(mate.frozen, 0);
});

test('blink teleports the wizard forward with the ball', () => {
  const m = playingMatch('wizard');
  const w = m.humanPlayer(0);
  w.pos = { x: 40, y: 34 };
  w.facing = { x: 1, y: 0 };
  m.ball.owner = w.id;
  m.snapBallToOwner(w);
  m.setHumanInput(0, { special: true });
  m.step(PHYSICS.dt);
  assert.ok(w.pos.x > 50, `moved forward to ${w.pos.x}`);
  assert.equal(m.ball.owner, w.id);
});

test('abilities cannot be used while on cooldown', () => {
  const m = playingMatch('tortoise');
  const t = m.humanPlayer(0);
  assert.ok(m.tryActivateAbility(t));
  assert.ok(!m.tryActivateAbility(t));
});
