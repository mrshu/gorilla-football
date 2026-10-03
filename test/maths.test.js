import test from 'node:test';
import assert from 'node:assert/strict';
import Maths, { make, update, newState, MAX_BAND } from '../src/game/maths.js';
import { createRng } from '../src/game/rng.js';

const random = (seed) => createRng(seed).next;
const tokenTypes = new Set(['balls', 'num', 'op', 'eq', 'box', 'sep',
  'frac', 'pct', 'pow', 'var', 'diag']);

function value(token, answer) {
  if (token.t === 'box') return answer;
  if (token.t === 'frac') return token.n / token.d;
  if (token.t === 'pct') return token.v / 100;
  return token.v;
}

// Evaluate the visible equation independently, including multiplication
// precedence and a missing operand rather than assuming every box is last.
function expression(tokens, answer) {
  if (tokens[0].t === 'op' && tokens[0].v === '√') {
    return Math.sqrt(value(tokens[1], answer));
  }
  if (tokens[0].t === 'pow') return tokens[0].v ** tokens[0].e;
  const terms = [value(tokens[0], answer)];
  const operators = [];
  for (let i = 1; i < tokens.length; i += 2) {
    const op = tokens[i].v;
    const next = value(tokens[i + 1], answer);
    if (op === '×') terms[terms.length - 1] *= next;
    else if (op === '÷') terms[terms.length - 1] /= next;
    else { operators.push(op); terms.push(next); }
  }
  return terms.reduce((total, term, i) => i === 0 ? term
    : operators[i - 1] === '+' ? total + term : total - term, 0);
}

function checkAnswer(q) {
  const r = q.render;
  const a = q.answer;
  if (['seq', 'seqRule', 'seqQuad', 'seqGeo'].includes(q.skill)) {
    const values = r.filter((t) => t.t !== 'sep').map((t) => value(t, a));
    if (q.skill === 'seqGeo') {
      const ratio = values[1] / values[0];
      assert.ok(ratio === 2 || ratio === 3);
      for (let i = 1; i < values.length; i++) assert.equal(values[i] / values[i - 1], ratio);
    } else {
      const differences = values.slice(1).map((n, i) => n - values[i]);
      if (q.skill === 'seqQuad') {
        const second = differences.slice(1).map((n, i) => n - differences[i]);
        assert.ok([2, 4, 6].includes(second[0]));
        assert.ok(second.every((n) => n === second[0]));
      } else assert.ok(differences.every((n) => n === differences[0]));
    }
  } else if (q.skill === 'fracCmp') {
    const delta = r[0].n * r[2].d - r[2].n * r[0].d;
    assert.equal(a, delta < 0 ? '<' : delta > 0 ? '>' : '=');
  } else if (q.skill === 'ratio') {
    assert.equal(r[0].v * a, r[2].v * r[4].v);
  } else if (q.skill === 'eqn2') {
    assert.equal(parseInt(r[0].v, 10) * a + r[2].v, r[4].v);
  } else if (q.skill === 'expand') {
    const [, coefficient, offset] = r[0].v.match(/^(\d+)\(x\+(\d+)\)$/);
    assert.equal(a, Number(coefficient) * Number(offset));
  } else if (q.skill === 'simul') {
    const y = r[4].v - a;
    assert.equal(a - y, r[10].v);
    assert.ok(Number.isInteger(a) && Number.isInteger(y));
  } else if (q.skill === 'ineq') {
    const coefficient = parseInt(r[0].v, 10);
    assert.ok(coefficient * a < r[2].v);
    assert.ok(coefficient * (a + 1) >= r[2].v);
  } else if (q.skill === 'indices') {
    assert.equal(a, r[1].v === '÷' ? r[0].e - r[2].e : r[0].e + r[2].e);
  } else if (r[0].t === 'diag') {
    const d = r[0];
    if (d.kind === 'angleLine') assert.equal(a + d.known, 180);
    else if (d.kind === 'angleTri') assert.equal(a + d.a + d.b, 180);
    else if (d.kind === 'pythag') assert.equal(a * a, d.legA ** 2 + d.legB ** 2);
    else if (d.kind === 'areaComp') assert.equal(a, d.W * d.H - d.w * d.h);
    else assert.fail(`Unknown diagram ${d.kind}`);
  } else {
    const equals = r.findIndex((t) => t.t === 'eq');
    assert.ok(equals > 0, `Missing equality for ${q.skill}`);
    assert.equal(expression(r.slice(0, equals), a), expression(r.slice(equals + 1), a));
  }
}

test('all eleven bands retain mathematically correct generators and render tokens', () => {
  assert.equal(MAX_BAND, 11);
  assert.equal(make, Maths.make);
  const skills = new Set();
  for (let band = 1; band <= MAX_BAND; band++) {
    const rand = random(1000 + band);
    assert.ok(Maths._BANDS[band].length > 0);
    for (const generator of Maths._BANDS[band]) {
      for (let i = 0; i < 100; i++) {
        const q = generator(rand);
        skills.add(q.skill);
        assert.ok(q.render.every((t) => tokenTypes.has(t.t)), q.skill);
        assert.ok(q.near.every((n) => typeof n === 'string' || Number.isFinite(n)));
        if (typeof q.answer === 'number') {
          assert.ok(Number.isFinite(q.answer));
          if (band < 8) assert.ok(q.answer >= 0);
        }
        checkAnswer(q);
      }
    }
  }
  assert.equal(skills.size, 38);
});

test('question choices are unique, plausible, and contain exactly one answer', () => {
  for (let band = 1; band <= MAX_BAND; band++) {
    const rand = random(6060 + band);
    for (let i = 0; i < 100; i++) {
      const difficulty = Math.min(MAX_BAND, band + (i % 4) * 0.25);
      const q = make(difficulty, newState(difficulty), rand);
      const expected = typeof q.answer === 'string' ? 3 : Maths.choiceCount(difficulty);
      assert.equal(q.choices.length, expected);
      assert.equal(new Set(q.choices).size, expected);
      assert.equal(q.choices.filter((c) => c === q.answer).length, 1);
      assert.ok(q.band === Math.floor(difficulty) || q.band === Math.ceil(difficulty));
      for (const c of q.choices) {
        if (typeof c === 'number') {
          assert.ok(c >= (q.band >= 8 ? -30 : 0));
          assert.ok(Math.abs(c - q.answer) <= Math.max(3, Math.round(Math.abs(q.answer) * 0.6)));
        }
      }
      checkAnswer(q);
    }
  }
});

test('choice counts retain floor support and harder upper-band formats', () => {
  for (const [d, count] of [[1, 2], [1.25, 2], [1.26, 3], [1.75, 3],
    [1.76, 4], [8.99, 4], [9, 5], [10.99, 5], [11, 6]]) {
    assert.equal(Maths.choiceCount(d), count);
  }
  const near = [2, 2, 99];
  const choices = Maths.buildChoices(1, 6, near, random(4), 0);
  assert.equal(choices.length, 6);
  assert.equal(new Set(choices).size, 6);
  assert.ok(choices.includes(1) && !choices.includes(99));
  assert.deepEqual(near, [2, 2, 99]);
});

test('seeded generation and adaptive outcomes are deterministic', () => {
  function run(seed) {
    const rand = random(seed);
    let state = newState(4);
    const questions = [];
    for (let i = 0; i < 100; i++) {
      const q = make(state.difficulty, state, rand);
      questions.push(q);
      state = update(state, { correct: i % 5 !== 0, elapsedMs: 4000, band: q.band, skill: q.skill });
    }
    return { state, questions };
  }
  assert.deepEqual(run(42), run(42));
  assert.notDeepEqual(run(42).questions, run(43).questions);
});

test('updates preserve input state and adjust difficulty and per-skill mastery', () => {
  const state = newState(4);
  state.mastery.div = 0.8;
  Object.freeze(state.mastery);
  Object.freeze(state);
  const outcome = { correct: true, elapsedMs: 6000, band: 4, skill: 'mul' };
  const next = update(state, outcome);
  assert.notEqual(next, state);
  assert.notEqual(next.mastery, state.mastery);
  assert.equal(next.difficulty, 4.075);
  assert.equal(next.mastery.mul, 0.625);
  assert.equal(next.mastery.div, 0.8);
  assert.deepEqual(state, { difficulty: 4, home: 4, mastery: { div: 0.8 }, fastStreak: 0, wrongStreak: 0 });
  assert.equal(update(state, { ...outcome, correct: false }).mastery.mul, 0.375);
  assert.equal(update(state, { ...outcome, correct: false }).difficulty, 3.7);
});

test('answer pace, evidence and streak acceleration retain their learning thresholds', () => {
  const exp = 2500 + 900 * 4;
  const step = (elapsedMs) => update(newState(4), { correct: true, elapsedMs, band: 4, skill: 'x' }).difficulty;
  assert.equal(step(exp * 0.6 - 1), 4.1);
  assert.equal(step(exp * 0.6), 4.075);
  assert.equal(step(exp * 1.4), 4.075);
  assert.equal(step(exp * 1.4 + 1), 4.04);
  let state = newState(1);
  for (let i = 0; i < 4; i++) state = update(state, { correct: true, elapsedMs: 1, band: 1, skill: 'x' });
  assert.ok(state.difficulty < 1.5, 'a few lucky two-choice answers cannot launch a child up the ladder');
  state = newState(7);
  for (let i = 0; i < 5; i++) state = update(state, { correct: false, elapsedMs: 9000, band: 7, skill: 'x' });
  assert.ok(state.difficulty < 3, 'a struggling child descends quickly');
  assert.equal(update(state, { correct: true, elapsedMs: 30000, band: 7, skill: 'x' }).wrongStreak, 0);
});

test('weak skills return more often and mastered skills retain variety', () => {
  const state = newState(2);
  state.mastery = { add10: 0, sub10: 1, bond10: 1 };
  const counts = { add10: 0, sub10: 0, bond10: 0 };
  const rand = random(4242);
  for (let i = 0; i < 3000; i++) counts[make(2, state, rand).skill]++;
  assert.ok(counts.add10 > 2 * counts.sub10 && counts.add10 > 2 * counts.bond10);
  const full = newState(5);
  full.mastery = { table: 1, div: 1, fracOf: 1 };
  const shares = { table: 0, div: 0, fracOf: 0 };
  for (let i = 0; i < 3000; i++) shares[make(5, full, rand).skill]++;
  for (const count of Object.values(shares)) assert.ok(count > 600 && count < 1500);
});

test('learners settle near 80 percent, with stronger learners climbing and weaker ones dropping', () => {
  for (const [i, ability] of [1.5, 3, 4.5, 6, 7.5, 9, 10.5].entries()) {
    const result = Maths.simulate(ability, 40000, random(900 + i));
    assert.ok(result.accuracy > 0.72 && result.accuracy < 0.88, `ability ${ability}: ${result.accuracy}`);
    assert.ok(result.minD >= 1 && result.maxD <= MAX_BAND);
  }
  assert.ok(Maths.simulate(8, 4000, random(77)).band > 6);
  assert.ok(Maths.simulate(1, 4000, random(78)).band < 2.5);
  assert.ok(Maths.simulate(11, 40000, random(79)).band > 8);
  assert.equal(newState(99).difficulty, 11);
  assert.equal(newState(-2).difficulty, 1);
  assert.equal(Maths.rating(1), 47);
  assert.equal(Maths.rating(11), 99);
});
