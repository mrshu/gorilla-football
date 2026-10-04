import test from 'node:test';
import assert from 'node:assert/strict';
import MathsPractice, { MATHS_STORAGE_KEY } from '../src/game/maths-practice.js';
import Maths from '../src/game/maths.js';
import { Match } from '../src/game/match.js';
import { normalizeConfig } from '../src/game/config.js';
import { STATES, SET_PIECES } from '../src/game/constants.js';

test('setup normalizes independent maths bands and keeps existing football-only configs off', () => {
  assert.equal(normalizeConfig({}).humans[0].mathsBand, 0);
  const cfg = normalizeConfig({ mode: 'versus', humans: [{ mathsBand: 1 }, { mathsBand: 11 }] });
  assert.deepEqual(cfg.humans.map(human => human.mathsBand), [1, 11]);
  for (const mathsBand of [-1, 12, 2.5, 'invalid', undefined]) {
    assert.equal(normalizeConfig({ humans: [{ mathsBand }] }).humans[0].mathsBand, 0);
  }
});

function config(mode = 'solo', control = 'aim', bands = [4, 6]) {
  const cfg = normalizeConfig({ mode, control, seed: 42 });
  cfg.humans.forEach((human, i) => { human.mathsBand = bands[i]; });
  return cfg;
}

function fixture(cfg = config(), storage = null) {
  const practice = new MathsPractice({ storage });
  practice.configure(cfg);
  const match = new Match(cfg);
  match.state = STATES.PLAY;
  match.setPiece = null;
  const carrier = match.humanPlayer(0);
  ready(match, carrier);
  return { cfg, practice, match, carrier };
}

function ready(match, carrier, x = carrier.team === 0 ? 70 : 30) {
  carrier.pos.x = x;
  carrier.kickCooldown = carrier.stun = carrier.frozen = 0;
  match.ball.owner = carrier.id;
}

function regain(practice, match, carrier) {
  match.ball.owner = null;
  assert.equal(practice.nextQuestion(match), null);
  ready(match, carrier);
  return practice.nextQuestion(match);
}

function memoryStorage(initial) {
  let value = initial ?? null;
  return { getItem: (key) => { assert.equal(key, MATHS_STORAGE_KEY); return value; },
    setItem: (key, text) => { assert.equal(key, MATHS_STORAGE_KEY); value = text; },
    read: () => JSON.parse(value) };
}

test('first eligible possession then every third offers once, with no repeat after skipping', () => {
  const { practice, match, carrier } = fixture();
  const first = practice.nextQuestion(match);
  assert.equal(first.kickerId, carrier.id);
  const before = JSON.stringify(practice.profiles);
  practice.skip(first);
  assert.equal(JSON.stringify(practice.profiles), before);
  assert.equal(practice.nextQuestion(match), null);
  assert.equal(practice.answer(first, false, 5000).stats.answered, 0);
  for (let possession = 2; possession <= 7; possession++) {
    const opportunity = regain(practice, match, carrier);
    assert.equal(Boolean(opportunity), possession === 4 || possession === 7);
    assert.equal(practice.nextQuestion(match), null);
    if (opportunity) practice.skip(opportunity);
  }
});

test('questions wait for an attacking-half ready outfielder and an available focus slot', () => {
  const { practice, match, carrier } = fixture();
  carrier.pos.x = 40;
  assert.equal(practice.nextQuestion(match), null);
  carrier.pos.x = 70;
  for (const flag of ['kickCooldown', 'stun', 'frozen']) {
    carrier[flag] = 1;
    assert.equal(practice.nextQuestion(match), null);
    carrier[flag] = 0;
  }
  for (const flag of ['isGK', 'sentOff']) {
    carrier[flag] = true;
    assert.equal(practice.nextQuestion(match), null);
    carrier[flag] = false;
  }
  assert.ok(match.grantMathsFocus(0, carrier.id));
  assert.equal(practice.nextQuestion(match), null, 'a full reward slot suppresses questions');
  match.mathsFocus[0] = false;
  const opportunity = practice.nextQuestion(match);
  assert.ok(opportunity);
  assert.equal(practice.nextQuestion(match), null);
});

test('questions, skips, and wrong answers leave football state and randomness intact', () => {
  const { practice, match } = fixture();
  const twin = fixture().match;
  const before = JSON.stringify(match);
  const first = practice.nextQuestion(match);
  const updated = practice.answer(first, false, 5000);
  assert.equal(updated.stats.answered, 1);
  assert.equal(updated.stats.correct, 0);
  assert.ok(updated.state.difficulty < 4);
  assert.equal(JSON.stringify(match), before);
  assert.equal(match.rng.next(), twin.rng.next());
  assert.equal(match.rng.next(), twin.rng.next());
  assert.deepEqual(first.question, fixture().practice.nextQuestion(twin).question);
});

test('answers update one profile once and snapshots cannot change the learned skill', () => {
  const { practice, match } = fixture(config('coop'));
  const first = practice.nextQuestion(match);
  const other = JSON.stringify(practice.profiles[1]);
  const skill = first.question.skill;
  first.question.skill = 'tampered';
  first.question.band = 99;
  const updated = practice.answer(first, true, 1000);
  assert.equal(updated.stats.answered, 1);
  assert.equal(updated.stats.correct, 1);
  assert.equal(updated.stats.streak, 1);
  assert.equal(updated.stats.bestStreak, 1);
  assert.equal(updated.state.mastery[skill], 0.625);
  assert.equal(updated.state.mastery.tampered, undefined);
  assert.equal(JSON.stringify(practice.profiles[1]), other);
  assert.equal(practice.answer(first, false, 1000), updated);
  assert.equal(updated.stats.answered, 1);
  assert.equal(practice.answer({ ...first }, true, 1000), null);
});

test('co-op alternates learners and assigns at most one opportunity to each possession', () => {
  const { practice, match, carrier } = fixture(config('coop'));
  const humans = [];
  for (let i = 0; i < 8; i++) {
    const opportunity = i === 0 ? practice.nextQuestion(match) : regain(practice, match, carrier);
    if (opportunity) { humans.push(opportunity.humanIndex); practice.skip(opportunity); }
    assert.equal(practice.nextQuestion(match), null);
  }
  assert.deepEqual(humans, [0, 1, 0, 1]);
  const enabled = fixture(config('coop', 'aim', [0, 6]));
  assert.equal(enabled.practice.nextQuestion(enabled.match).humanIndex, 1);
});

test('versus routes ownership to its team; manual and assisted require the fixed human carrier', () => {
  const versus = fixture(config('versus'));
  assert.equal(versus.practice.nextQuestion(versus.match).humanIndex, 0);
  const second = versus.match.humanPlayer(1);
  ready(versus.match, second);
  assert.equal(versus.practice.nextQuestion(versus.match).humanIndex, 1);
  for (const control of ['manual', 'assisted']) {
    const { practice, match, carrier } = fixture(config('solo', control));
    const teammate = match.teammatesOf(carrier).find((p) => !p.isGK);
    ready(match, teammate);
    assert.equal(practice.nextQuestion(match), null);
    ready(match, carrier);
    assert.ok(practice.nextQuestion(match), control);
  }
});

test('staged restarts wait until ready, with an introductory midfield kickoff', () => {
  const { practice, match, carrier } = fixture();
  match.state = STATES.KICKOFF;
  carrier.pos.x = 50;
  match.setPiece = { kind: SET_PIECES.KICKOFF, takerId: carrier.id, lerp: 0.5, taken: false };
  assert.equal(practice.nextQuestion(match), null);
  match.setPiece.lerp = 1;
  const opportunity = practice.nextQuestion(match);
  assert.ok(opportunity);
  practice.skip(opportunity);
  assert.equal(practice.nextQuestion(match), null);
  match.state = STATES.SET_PIECE;
  carrier.pos.x = 70;
  for (let i = 0; i < 3; i++) {
    match.setPiece = { kind: SET_PIECES.FREE_KICK, takerId: carrier.id, lerp: 1, taken: false };
    assert.equal(Boolean(practice.nextQuestion(match)), i === 2);
  }
  const paused = fixture();
  paused.match.state = STATES.HALFTIME;
  assert.equal(paused.practice.nextQuestion(paused.match), null);
});

test('same-band configuration retains progress, changed selection resets only that profile', () => {
  const storage = memoryStorage();
  const { cfg, practice, match, carrier } = fixture(config('coop'), storage);
  practice.answer(practice.nextQuestion(match), true, 1000);
  const second = regain(practice, match, carrier);
  practice.answer(second, false, 1000);
  const saved = JSON.stringify(practice.profiles);
  const reloaded = new MathsPractice({ storage });
  reloaded.configure(cfg);
  assert.equal(JSON.stringify(reloaded.profiles), saved);
  assert.equal(storage.read().schema, 1);
  assert.equal(storage.read().profiles.length, 2);
  assert.ok(reloaded.nextQuestion(match), 'a new match resets opportunity density');
  const other = JSON.stringify(reloaded.profiles[1]);
  const changed = config('coop', 'aim', [2, 6]);
  reloaded.configure(changed);
  assert.equal(reloaded.profiles[0].state.difficulty, 2);
  assert.equal(reloaded.profiles[0].stats.answered, 0);
  assert.equal(JSON.stringify(reloaded.profiles[1]), other);
  reloaded.configure(config('coop', 'aim', [0, 6]));
  assert.equal(reloaded.profiles[0].band, 2);
  assert.equal(reloaded.enabledBands[0], 0);
  assert.equal(reloaded.nextQuestion(match).humanIndex, 1);
});

test('switching maths Off and back on preserves each learners last-band progress', () => {
  const storage = memoryStorage();
  const { cfg, practice, match } = fixture(config(), storage);
  practice.answer(practice.nextQuestion(match), true, 1000);
  const progressed = JSON.stringify(practice.profiles[0]);
  practice.configure(config('solo', 'aim', [0]));
  assert.equal(practice.nextQuestion(match), null);
  assert.equal(JSON.stringify(practice.profiles[0]), progressed);
  const reloaded = new MathsPractice({ storage });
  reloaded.configure(config('solo', 'aim', [0]));
  assert.equal(reloaded.nextQuestion(match), null);
  assert.equal(JSON.stringify(reloaded.profiles[0]), progressed);
  reloaded.configure(cfg);
  assert.ok(reloaded.nextQuestion(match));
  assert.equal(JSON.stringify(reloaded.profiles[0]), progressed);
});

test('corrupt or throwing storage is repaired safely and practice continues in memory', () => {
  for (const storage of [memoryStorage('{broken'), memoryStorage('{"schema":9,"profiles":[]}'),
    { getItem() { throw Error('blocked'); }, setItem() { throw Error('quota'); } }]) {
    const { practice, match } = fixture(config(), storage);
    const result = practice.answer(practice.nextQuestion(match), true, 1000);
    assert.equal(result.stats.answered, 1);
    assert.ok(Number.isFinite(result.state.difficulty));
  }
  const storage = memoryStorage(JSON.stringify({ schema: 1, profiles: [{ band: 4,
    state: { difficulty: 999, home: -5, fastStreak: -1, wrongStreak: 2.9,
      mastery: { add10: 9, sub10: -4, invalid: 'bad' } },
    stats: { answered: 3.9, correct: 20, streak: 30, bestStreak: -1 } }] }));
  const practice = new MathsPractice({ storage });
  practice.configure(config());
  assert.deepEqual(practice.profiles[0].state, { difficulty: 11, home: 1, fastStreak: 0,
    wrongStreak: 2, mastery: { add10: 1, sub10: 0 } });
  assert.deepEqual(practice.profiles[0].stats, { answered: 3, correct: 3, streak: 3, bestStreak: 3 });
  assert.equal(practice.profiles[1].band, 0);
});

test('generation errors and stale match opportunities do not repeat or penalise a learner', () => {
  const { cfg, practice, match, carrier } = fixture();
  const before = JSON.stringify(practice.profiles);
  const original = Maths.make;
  try {
    Maths.make = () => { throw Error('unavailable'); };
    assert.equal(practice.nextQuestion(match), null);
  } finally { Maths.make = original; }
  assert.equal(practice.nextQuestion(match), null);
  assert.equal(JSON.stringify(practice.profiles), before);
  let pending;
  for (let i = 0; i < 3; i++) pending = regain(practice, match, carrier);
  assert.ok(pending);
  practice.configure(cfg);
  assert.equal(practice.answer(pending, true, 1000), null);
  assert.equal(JSON.stringify(practice.profiles), before);
});
