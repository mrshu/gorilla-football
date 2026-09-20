import { test } from 'node:test';
import assert from 'node:assert/strict';
import { offsidePositions } from '../src/game/rules.js';
import { PITCH } from '../src/game/constants.js';

const P = (id, x, y) => ({ id, pos: { x, y }, sentOff: false });

test('attacker beyond the second-last defender and the ball is offside', () => {
  const kicker = P(1, 60, 34);
  const mates = [P(2, 85, 30), P(3, 55, 20)];
  const opps = [P(10, 104, 34), P(11, 80, 30), P(12, 70, 40)]; // GK + two defenders
  const ball = { x: 60, y: 34 };
  assert.deepEqual(offsidePositions(kicker, mates, opps, ball, 1), [2]);
});

test('attacker level with or behind the second-last defender is onside', () => {
  const kicker = P(1, 60, 34);
  const mates = [P(2, 80, 30)];
  const opps = [P(10, 104, 34), P(11, 80, 30), P(12, 70, 40)];
  assert.deepEqual(offsidePositions(kicker, mates, opps, { x: 60, y: 34 }, 1), []);
});

test('attacker in own half is never offside', () => {
  const kicker = P(1, 20, 34);
  const mates = [P(2, 50, 30)];
  const opps = [P(10, 104, 34), P(11, 40, 30)];
  assert.deepEqual(offsidePositions(kicker, mates, opps, { x: 20, y: 34 }, 1), []);
});

test('attacker behind the ball is onside', () => {
  const kicker = P(1, 90, 34);
  const mates = [P(2, 85, 30)];
  const opps = [P(10, 104, 34), P(11, 70, 30)];
  assert.deepEqual(offsidePositions(kicker, mates, opps, { x: 90, y: 34 }, 1), []);
});

test('works for the team attacking the left goal', () => {
  const kicker = P(1, 45, 34);
  const mates = [P(2, 20, 30), P(3, 50, 30)];
  const opps = [P(10, 1, 34), P(11, 25, 30), P(12, 35, 40)];
  assert.deepEqual(offsidePositions(kicker, mates, opps, { x: 45, y: 34 }, -1), [2]);
});

test('sent-off opponents do not count as defenders', () => {
  const kicker = P(1, 60, 34);
  const mates = [P(2, 85, 30)];
  const gk = P(10, 104, 34);
  const sentOff = { ...P(11, 90, 30), sentOff: true };
  const df = P(12, 70, 40);
  assert.deepEqual(offsidePositions(kicker, mates, [gk, sentOff, df], { x: 60, y: 34 }, 1), [2]);
});

test('kicker themself is never flagged', () => {
  const kicker = P(1, 90, 34);
  assert.deepEqual(offsidePositions(kicker, [kicker], [P(10, 104, 34)], { x: 90, y: 34 }, 1), []);
});
