import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyOutOfPlay, goalCrossed, isInPenaltyArea, resolveTackle, applyCard, foulRestart, offsideExemptSetPiece } from '../src/game/rules.js';
import { PITCH, SET_PIECES } from '../src/game/constants.js';

const teams = [
  { index: 0, attackDir: 1 },
  { index: 1, attackDir: -1 },
];

test('ball inside the pitch is in play', () => {
  assert.equal(classifyOutOfPlay({ x: 50, y: 30 }, 0, 0, teams), null);
  assert.equal(classifyOutOfPlay({ x: 0, y: 0 }, 0, 0, teams), null);
});

test('ball over the touchline is a throw-in to the other team', () => {
  const r = classifyOutOfPlay({ x: 40, y: -0.3 }, 0, 0, teams);
  assert.equal(r.type, SET_PIECES.THROW_IN);
  assert.equal(r.team, 1);
  assert.deepEqual(r.pos, { x: 40, y: 0 });
  const r2 = classifyOutOfPlay({ x: 70, y: PITCH.width + 1 }, 0, 1, teams);
  assert.equal(r2.team, 0);
  assert.equal(r2.pos.y, PITCH.width);
});

test('ball between the posts and under the bar is a goal for the attacking team', () => {
  assert.equal(goalCrossed({ x: PITCH.length + 0.1, y: PITCH.width / 2 + 3 }, 1), 1);
  assert.equal(goalCrossed({ x: -0.2, y: PITCH.width / 2 }, 0), -1);
  assert.equal(goalCrossed({ x: PITCH.length + 0.1, y: PITCH.width / 2 + 3 }, 3), 0, 'over the bar');
  assert.equal(goalCrossed({ x: PITCH.length + 0.1, y: PITCH.width / 2 + 4 }, 0), 0, 'wide of the post');
  const r = classifyOutOfPlay({ x: PITCH.length + 0.1, y: PITCH.width / 2 }, 0, 1, teams);
  assert.equal(r.type, 'goal');
  assert.equal(r.team, 0, 'team 0 attacks the right-hand goal');
  const r2 = classifyOutOfPlay({ x: -0.1, y: PITCH.width / 2 }, 0, 0, teams);
  assert.equal(r2.team, 1);
});

test('ball over the goal line last touched by defenders is a corner for attackers', () => {
  // Team 1 defends the left goal (x=0). Team 1 touched it last => corner for team 0? No:
  // team 0 attacks x=PITCH.length, so at x=0 team 0 is the defender.
  const r = classifyOutOfPlay({ x: -0.5, y: 10 }, 0, 0, teams);
  assert.equal(r.type, SET_PIECES.CORNER);
  assert.equal(r.team, 1);
  assert.deepEqual(r.pos, { x: 0, y: 0 });
  const r2 = classifyOutOfPlay({ x: PITCH.length + 0.5, y: 60 }, 0, 1, teams);
  assert.equal(r2.type, SET_PIECES.CORNER);
  assert.equal(r2.team, 0);
  assert.deepEqual(r2.pos, { x: PITCH.length, y: PITCH.width });
});

test('ball over the goal line last touched by attackers is a goal kick', () => {
  const r = classifyOutOfPlay({ x: PITCH.length + 0.5, y: 10 }, 0, 0, teams);
  assert.equal(r.type, SET_PIECES.GOAL_KICK);
  assert.equal(r.team, 1);
  assert.equal(r.pos.x, PITCH.length - PITCH.goalAreaDepth);
});

test('penalty area membership', () => {
  assert.ok(isInPenaltyArea({ x: 10, y: 34 }, -1));
  assert.ok(!isInPenaltyArea({ x: 20, y: 34 }, -1));
  assert.ok(!isInPenaltyArea({ x: 10, y: 5 }, -1));
  assert.ok(isInPenaltyArea({ x: PITCH.length - 5, y: 34 }, 1));
});

test('foul in the fouler\'s own box is a penalty, elsewhere a free kick', () => {
  // Fouler attacks +1, so defends the goal at x=0.
  const pen = foulRestart({ x: 8, y: 34 }, 1, 1);
  assert.equal(pen.type, SET_PIECES.PENALTY);
  assert.equal(pen.team, 1);
  assert.deepEqual(pen.pos, { x: PITCH.penaltySpot, y: PITCH.width / 2 });
  const fk = foulRestart({ x: 50, y: 20 }, 1, 1);
  assert.equal(fk.type, SET_PIECES.FREE_KICK);
  assert.deepEqual(fk.pos, { x: 50, y: 20 });
  const pen2 = foulRestart({ x: PITCH.length - 3, y: 30 }, -1, 0);
  assert.equal(pen2.type, SET_PIECES.PENALTY);
  assert.equal(pen2.pos.x, PITCH.length - PITCH.penaltySpot);
});

test('tackle resolution is deterministic given the rolls', () => {
  const clean = resolveTackle({ tackling: 10, strength: 1, slide: false, fromBehind: false }, { win: 0.5, foul: 0.5, card: 0.5 });
  assert.deepEqual(clean, { won: true, foul: false, card: null });
  const miss = resolveTackle({ tackling: 1, strength: 10, slide: false, fromBehind: false }, { win: 0.99, foul: 0.99, card: 0.99 });
  assert.deepEqual(miss, { won: false, foul: false, card: null });
  const foul = resolveTackle({ tackling: 1, strength: 10, slide: true, fromBehind: true }, { win: 0.99, foul: 0.0, card: 0.99 });
  assert.equal(foul.foul, true);
  assert.equal(foul.card, null);
  const yellow = resolveTackle({ tackling: 1, strength: 10, slide: true, fromBehind: true }, { win: 0.99, foul: 0.0, card: 0.2 });
  assert.equal(yellow.card, 'yellow');
  const red = resolveTackle({ tackling: 1, strength: 10, slide: true, fromBehind: true }, { win: 0.99, foul: 0.0, card: 0.0 });
  assert.equal(red.card, 'red');
});

test('second yellow card sends the player off', () => {
  const p = { yellowCards: 0, sentOff: false };
  assert.equal(applyCard(p, 'yellow'), 'yellow');
  assert.equal(p.sentOff, false);
  assert.equal(applyCard(p, 'yellow'), 'red');
  assert.equal(p.sentOff, true);
  const q = { yellowCards: 0, sentOff: false };
  assert.equal(applyCard(q, 'red'), 'red');
  assert.equal(q.sentOff, true);
});

test('offside exemptions', () => {
  assert.ok(offsideExemptSetPiece(SET_PIECES.THROW_IN));
  assert.ok(offsideExemptSetPiece(SET_PIECES.CORNER));
  assert.ok(offsideExemptSetPiece(SET_PIECES.GOAL_KICK));
  assert.ok(!offsideExemptSetPiece(SET_PIECES.FREE_KICK));
  assert.ok(!offsideExemptSetPiece(SET_PIECES.KICKOFF));
});
