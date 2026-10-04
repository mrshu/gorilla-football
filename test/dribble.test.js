import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findOpenRun } from '../src/game/dribble.js';
import { DECISION, PHYSICS, PITCH, STATES } from '../src/game/constants.js';
import { dist, pointSegmentDistance } from '../src/game/vec.js';

function fixture({ team = 0, attackDir = 1, x = 50, y = 34, opponents = [] } = {}) {
  const carrier = { id: 0, team, pos: { x, y }, sentOff: false, isGK: false, stun: 0, frozen: 0, sliding: 0 };
  const defenders = opponents.map((p, i) => ({ id: i + 1, team: 1 - team, pos: p.pos || p, sentOff: false, ...p }));
  const teams = [];
  teams[team] = { attackDir, players: [carrier] };
  teams[1 - team] = { attackDir: -attackDir, players: defenders };
  const match = { state: STATES.PLAY, ball: { owner: carrier.id }, teams };
  return { match, carrier };
}

function assertSafeRun(match, carrier, point) {
  assert.ok(point, 'expected an open forward run');
  const direction = match.teams[carrier.team].attackDir;
  const forward = (point.x - carrier.pos.x) * direction;
  assert.ok(forward > 0);
  assert.ok(Math.abs(point.y - carrier.pos.y) / forward <= 0.65 + 1e-9);
  assert.ok(dist(carrier.pos, point) >= 8 - 1e-9 && dist(carrier.pos, point) <= 12 + 1e-9);
  assert.ok(point.y >= 1.5 && point.y <= PITCH.width - 1.5);
  assert.ok((direction > 0 ? PITCH.length - point.x : point.x) >= 6);
  for (const defender of match.teams[1 - carrier.team].players.filter((p) => !p.sentOff)) {
    assert.ok(pointSegmentDistance(defender.pos, carrier.pos, point) >= PHYSICS.slideRange + PHYSICS.playerRadius);
  }
}

test('open space offers a 12 m run toward either goal without changing the match', () => {
  for (const team of [0, 1]) {
    for (const attackDir of [1, -1]) {
      const { match, carrier } = fixture({ team, attackDir });
      const before = structuredClone(match);
      const point = findOpenRun(match, carrier);
      assertSafeRun(match, carrier, point);
      assert.deepEqual(point, { x: 50 + attackDir * 12, y: 34 });
      assert.deepEqual(match, before);
    }
  }
});

test('a defender ahead can be avoided by a forward diagonal with real slide clearance', () => {
  for (const attackDir of [1, -1]) {
    const { match, carrier } = fixture({ attackDir, opponents: [{ x: 50 + attackDir * 9, y: 34 }] });
    const point = findOpenRun(match, carrier);
    assertSafeRun(match, carrier, point);
    assert.ok(Math.abs(point.y - carrier.pos.y) > 4);
  }
});

test('a blocking defensive line prevents every candidate, including the goalkeeper lane', () => {
  const { match, carrier } = fixture({ opponents: [
    { x: 55, y: 28 }, { pos: { x: 55, y: 34 }, isGK: true }, { x: 55, y: 40 },
  ] });
  assert.equal(findOpenRun(match, carrier), null);
});

test('a goalkeeper closing the carrier is an obstacle even without outfield defenders', () => {
  const { match, carrier } = fixture({ x: 87, opponents: [{ pos: { x: 91, y: 34 }, isGK: true }] });
  assert.equal(findOpenRun(match, carrier), null);
});

test('a shorter carry can stop safely before an opponent beyond the destination', () => {
  const { match, carrier } = fixture({ y: 1.5, opponents: [
    { x: 62, y: 1.5 }, { x: 55, y: 6 }, { x: 60, y: 9 },
  ] });
  const point = findOpenRun(match, carrier);
  assertSafeRun(match, carrier, point);
  assert.ok(dist(carrier.pos, point) <= 10 + 1e-9);
});

test('nearby pressure from any direction blocks a suggestion, even a recovering opponent', () => {
  for (const offset of [{ x: -2, y: 0 }, { x: 0, y: DECISION.pressureDistance }, { x: 2, y: 0 }]) {
    const { match, carrier } = fixture({ opponents: [{ pos: { x: 50 + offset.x, y: 34 + offset.y }, stun: 1, frozen: 1 }] });
    assert.equal(findOpenRun(match, carrier), null);
  }
});

test('opponents safely behind and sent-off obstacles do not block an open lane', () => {
  for (const attackDir of [1, -1]) {
    const { match, carrier } = fixture({ attackDir, opponents: [
      { x: 50 - attackDir * 6, y: 34 }, { pos: { x: 50 + attackDir * 4, y: 34 }, sentOff: true },
    ] });
    const point = findOpenRun(match, carrier);
    assertSafeRun(match, carrier, point);
    assert.deepEqual(point, { x: 50 + attackDir * 12, y: 34 });
  }
});

test('wide carriers run inward within the pitch instead of along or over a boundary', () => {
  for (const attackDir of [1, -1]) {
    for (const y of [0.8, PITCH.width - 0.8]) {
      const { match, carrier } = fixture({ attackDir, y });
      const point = findOpenRun(match, carrier);
      assertSafeRun(match, carrier, point);
      assert.ok(Math.abs(point.y - PITCH.width / 2) < Math.abs(y - PITCH.width / 2));
    }
  }
});

test('runs stop short of the attacking goal line; no sideways or backwards escape near it', () => {
  for (const attackDir of [1, -1]) {
    const { match, carrier } = fixture({ attackDir, x: attackDir > 0 ? 90 : 15 });
    assertSafeRun(match, carrier, findOpenRun(match, carrier));
    carrier.pos.x = attackDir > 0 ? 93 : 12;
    assert.equal(findOpenRun(match, carrier), null);
  }
});

test('only a ready outfield ball owner during live play may receive a run', () => {
  for (const state of Object.values(STATES).filter((s) => s !== STATES.PLAY)) {
    const { match, carrier } = fixture();
    match.state = state;
    assert.equal(findOpenRun(match, carrier), null);
  }
  for (const flag of ['sentOff', 'isGK', 'stun', 'frozen', 'sliding']) {
    const { match, carrier } = fixture();
    carrier[flag] = 1;
    assert.equal(findOpenRun(match, carrier), null, flag);
  }
  for (const owner of [null, 1]) {
    const { match, carrier } = fixture();
    match.ball.owner = owner;
    assert.equal(findOpenRun(match, carrier), null);
  }
  const { match } = fixture();
  assert.equal(findOpenRun(match, null), null);
});

test('invalid positions or an invalid attack direction do not create a target', () => {
  for (const pos of [{ x: NaN, y: 34 }, { x: 50, y: Infinity }, { x: -1, y: 34 }, { x: 50, y: 69 }]) {
    const { match, carrier } = fixture();
    carrier.pos = pos;
    assert.equal(findOpenRun(match, carrier), null);
  }
  const { match, carrier } = fixture({ attackDir: 0 });
  assert.equal(findOpenRun(match, carrier), null);
});
