import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Match } from '../src/game/match.js';
import { normalizeConfig } from '../src/game/config.js';
import { AIM, PHYSICS, STATES } from '../src/game/constants.js';
import { dot, len, norm, sub } from '../src/game/vec.js';

function drawingMatch() {
  const m = new Match(normalizeConfig({ control: 'aim', seed: 21 }));
  m.state = STATES.PLAY;
  m.setPiece = null;
  const kicker = m.teams[0].players[9];
  kicker.pos = { x: 30, y: 34 };
  kicker.facing = { x: 1, y: 0 };
  m.ball.owner = kicker.id;
  m.snapBallToOwner(kicker);
  m.rng.gaussian = () => 0; // isolate trajectory from aiming error
  return { m, kicker };
}

function trajectory(points, dt = PHYSICS.dt) {
  const { m, kicker } = drawingMatch();
  assert.ok(m.aimPath(0, points));
  const drawn = m.aimKicks[0].path;
  const plan = m.planKick(kicker, drawn);
  m.applyAimInputs();
  // Follow actual free-ball physics without players, restarts or captures.
  for (const p of m.players) p.sentOff = true;
  const start = { ...m.ball.pos };
  const samples = [{ pos: { ...m.ball.pos }, vel: { ...m.ball.vel } }];
  for (let t = 0; t < 15 && (len(m.ball.vel) > 0.01 || m.ball.z > 0); t += dt) {
    m.integrateBall(dt);
    samples.push({ pos: { ...m.ball.pos }, vel: { ...m.ball.vel } });
  }
  return { plan, drawn, start, samples, end: samples.at(-1).pos };
}

function loopsThenForward() {
  const points = [{ x: 30, y: 34 }];
  for (let i = 1; i <= 400; i++) {
    const a = i * Math.PI / 20;
    points.push({ x: 26 + Math.cos(a) * 4, y: 34 + Math.sin(a) * 4 });
  }
  points.push({ x: 54, y: 34 });
  return points;
}

function assertForward(result, axis) {
  let lastProgress = 0;
  for (const sample of result.samples) {
    const progress = dot(sub(sample.pos, result.start), axis);
    assert.ok(progress >= lastProgress - 1e-8, 'the ball must never double back');
    assert.ok(dot(sample.vel, axis) >= -1e-8, 'velocity must stay forward');
    lastProgress = progress;
  }
}

test('a long scribble preserves its final endpoint and cannot amplify kick power', () => {
  const scribble = trajectory(loopsThenForward());
  const straight = trajectory([{ x: 30, y: 34 }, { x: 54, y: 34 }]);
  assert.equal(scribble.drawn.length, AIM.pathMaxPoints);
  assert.deepEqual(scribble.drawn.at(-1), { x: 54, y: 34 });
  assert.equal(scribble.plan.distance, 24);
  assert.equal(scribble.plan.speed, straight.plan.speed);
  assert.equal(scribble.plan.spin, 0);
  assert.deepEqual(scribble.end, straight.end);
  assertForward(scribble, { x: 1, y: 0 });
  assert.ok(scribble.end.x - scribble.start.x > 22);
});

test('forward zigzags and backtracking strokes travel toward their endpoint without loops', () => {
  for (const points of [
    [{ x: 30, y: 34 }, { x: 38, y: 12 }, { x: 25, y: 45 }, { x: 50, y: 18 }, { x: 42, y: 50 }, { x: 54, y: 34 }],
    [{ x: 30, y: 34 }, { x: 45, y: 25 }, { x: 36, y: 26 }, { x: 54, y: 34 }],
  ]) {
    const result = trajectory(points);
    assert.equal(result.plan.spin, 0);
    assertForward(result, { x: 1, y: 0 });
    assert.ok(Math.abs(result.end.y - result.start.y) < 1e-8);
  }
});

test('simple mirrored arcs keep visible curl without reversing or gaining speed', () => {
  const results = [];
  for (const side of [-1, 1]) {
    const result = trajectory([{ x: 30, y: 34 }, { x: 42, y: 34 + side * 9 }, { x: 54, y: 34 }]);
    assertForward(result, { x: 1, y: 0 });
    assert.ok(Math.abs(result.plan.spin) > 0);
    let speed = len(result.samples[0].vel);
    let maxSide = 0;
    for (const sample of result.samples) {
      assert.ok(len(sample.vel) <= speed + 1e-8, 'swerve must not add energy');
      speed = len(sample.vel);
      const displacement = sub(sample.pos, result.start);
      maxSide = Math.max(maxSide, displacement.y * side);
      if (speed > 0.5) assert.ok(dot(norm(sample.vel), { x: 1, y: 0 }) > 0.95, 'curl must remain a modest bend');
    }
    assert.ok(maxSide > 1, 'the ball should visibly follow the drawn arc side');
    assert.ok(result.end.x - result.start.x > 22, 'curl should still reach near the target distance');
    assert.ok(Math.abs(result.end.y - result.start.y) < 3, 'curl should finish near the chord endpoint');
    results.push(result);
  }
  assert.ok(Math.abs(results[0].end.x - results[1].end.x) < 1e-8);
  assert.ok(Math.abs((results[0].end.y - results[0].start.y) + (results[1].end.y - results[1].start.y)) < 1e-8);
});

test('long lofted arcs stay forward for the entire flight and rolling finish', () => {
  const result = trajectory([{ x: 30, y: 34 }, { x: 52, y: 18 }, { x: 75, y: 34 }]);
  assert.ok(result.plan.vz > 0);
  assertForward(result, { x: 1, y: 0 });
  const initial = norm(result.samples[0].vel);
  for (const sample of result.samples) {
    if (len(sample.vel) > 0.5) assert.ok(dot(norm(sample.vel), initial) > Math.cos(0.56), 'total turn stays below 32 degrees');
  }
});

test('intentional backwards passes still travel backwards toward their named endpoint', () => {
  for (const points of [
    [{ x: 30, y: 34 }, { x: 12, y: 34 }],
    [{ x: 30, y: 34 }, { x: 21, y: 25 }, { x: 12, y: 34 }],
  ]) {
    const result = trajectory(points);
    assertForward(result, { x: -1, y: 0 });
    assert.ok(result.end.x < result.start.x - 16);
  }
});

test('closed and almost closed strokes are rejected instead of choosing an arbitrary kick', () => {
  for (const end of [{ x: 30, y: 34 }, { x: 30.2, y: 34.1 }]) {
    const { m, kicker } = drawingMatch();
    assert.equal(m.aimPath(0, [{ x: 30, y: 34 }, { x: 45, y: 15 }, { x: 20, y: 45 }, end]), false);
    assert.equal(m.aimKicks[0], null);
    assert.equal(m.ball.owner, kicker.id);
  }
});

test('curl trajectories remain consistent across fixed physics step sizes', () => {
  const points = [{ x: 30, y: 34 }, { x: 42, y: 25 }, { x: 54, y: 34 }];
  const fine = trajectory(points, 1 / 120);
  const coarse = trajectory(points, 1 / 30);
  assertForward(coarse, { x: 1, y: 0 });
  assert.ok(len(sub(fine.end, coarse.end)) < 0.3, 'curl should not depend on frame rate');
});
