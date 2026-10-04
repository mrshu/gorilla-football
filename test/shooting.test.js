import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planShot } from '../src/game/shooting.js';
import { Match } from '../src/game/match.js';
import { normalizeConfig } from '../src/game/config.js';
import { derivePhysical } from '../src/game/entities.js';
import { CHARACTERS } from '../src/data/characters.js';
import { PHYSICS, PITCH } from '../src/game/constants.js';
import { add, scale, len } from '../src/game/vec.js';

const physics = new Match(normalizeConfig({ seed: 29 }));
physics.players = []; // Test the shipped ball integrator without interceptions.
const OFFSET = PHYSICS.playerRadius + PHYSICS.ballRadius + 0.1;

function kicker(character = CHARACTERS.find((c) => c.id === 'plumber'), distance = 18, direction = 1, y = 34) {
  return { pos: { x: direction > 0 ? PITCH.length - distance : distance, y }, phys: derivePhysical(character.stats) };
}

function crossing(player, plan) {
  physics.ball.owner = null;
  physics.ball.homing = null;
  physics.ball.spin = 0;
  physics.ball.pos = add(player.pos, scale(plan.dir, OFFSET));
  physics.ball.vel = scale(plan.dir, plan.speed);
  physics.ball.z = 0.05;
  physics.ball.vz = plan.vz;
  const direction = Math.sign(plan.dir.x);
  for (let frame = 0; frame < 1200; frame++) {
    const previous = { ...physics.ball.pos, z: physics.ball.z };
    physics.integrateBall(PHYSICS.dt);
    if ((physics.ball.pos.x - plan.target.x) * direction >= 0) {
      const fraction = (plan.target.x - previous.x) / (physics.ball.pos.x - previous.x);
      return {
        y: previous.y + (physics.ball.pos.y - previous.y) * fraction,
        z: previous.z + (physics.ball.z - previous.z) * fraction,
        endFrameZ: physics.ball.z,
        time: (frame + fraction) * PHYSICS.dt,
        speed: len(physics.ball.vel),
      };
    }
  }
  assert.fail('shot did not reach the goal plane');
}

test('shots cross the actual goal plane at their requested height across ranges, characters, power and attack directions', () => {
  for (const character of CHARACTERS) {
    for (const direction of [1, -1]) {
      for (const distance of [8, 11, 18, 25, 30, 40, 46]) {
        for (const power of [0, 0.3, 0.8, 1]) {
          const player = kicker(character, distance, direction, 39);
          const plan = planShot(player, { x: direction > 0 ? 105.8 : -0.8, y: 31, z: 0.8 }, power);
          assert.ok(plan);
          const crossed = crossing(player, plan);
          const label = `${character.id}, direction ${direction}, ${distance} m, power ${power}`;
          assert.ok(Math.abs(crossed.z - plan.target.z) < 0.01, `${label}: crossing z ${crossed.z}`);
          // The engine checks rules at the end of a frame, after the exact
          // plane crossing. Extreme weak, long shots descend farther in
          // that last frame; ordinary/default-power shots stay within .2 m.
          const frameTolerance = power < 0.8 && distance >= 40 ? 0.3 : 0.2;
          assert.ok(Math.abs(crossed.endFrameZ - plan.target.z) < frameTolerance, `${label}: frame z ${crossed.endFrameZ}`);
          assert.ok(crossed.endFrameZ < PITCH.goalHeight, `${label}: on-target shots stay below the bar`);
          assert.ok(Math.abs(crossed.y - plan.target.y) < 1e-8, label);
          assert.ok(Math.abs(crossed.time - plan.travelTime) < 1e-8, label);
          assert.ok(crossed.speed > 8, `${label}: ball should still be driven through the goal`);
        }
      }
    }
  }
});

test('target height stays within the ball-centre bounds under the bar and defaults to a low driven shot', () => {
  const player = kicker();
  assert.equal(planShot(player, { x: 105, y: 34 }).target.z, 0.65);
  const low = planShot(player, { x: 105, y: 34, z: -3 });
  const high = planShot(player, { x: 105, y: 34, z: 9 });
  assert.equal(low.target.z, PHYSICS.ballRadius);
  assert.equal(high.target.z, PITCH.goalHeight - PHYSICS.ballRadius - 0.1);
  for (const plan of [low, high]) assert.ok(Math.abs(crossing(player, plan).z - plan.target.z) < 0.01);
});

test('shot strength and power affect arrival speed and time without changing the requested placement', () => {
  const weak = kicker(CHARACTERS.find((c) => c.id === 'penguin'), 25);
  const strong = kicker(CHARACTERS.find((c) => c.id === 'gorilla'), 25);
  const target = { x: 105, y: 32, z: 1.2 };
  const gentle = planShot(weak, target, 0);
  const hard = planShot(weak, target, 1);
  const cannon = planShot(strong, target, 1);
  assert.ok(gentle.speed < hard.speed && hard.speed < cannon.speed);
  assert.ok(gentle.travelTime > hard.travelTime && hard.travelTime > cannon.travelTime);
  for (const [player, plan] of [[weak, gentle], [weak, hard], [strong, cannon]]) {
    const actual = crossing(player, plan);
    assert.ok(actual.speed < plan.speed, 'air drag must still apply');
    assert.ok(Math.abs(actual.z - target.z) < 0.01);
  }
});

test('outside targets remain misses and planning has no randomness or mutation', () => {
  const player = kicker();
  const target = { x: 105.8, y: 42, z: 0.9 };
  const original = structuredClone({ player, target });
  const plan = planShot(player, target);
  assert.deepEqual(plan, planShot(player, target));
  assert.deepEqual({ player, target }, original);
  assert.equal(plan.target.x, 105);
  assert.equal(plan.target.y, 42);
  assert.ok(crossing(player, plan).y > PITCH.width / 2 + PITCH.goalWidth / 2);
});

test('power is bounded and invalid or unreachable shots cannot produce nonfinite physics', () => {
  const player = kicker();
  const target = { x: 105, y: 34 };
  assert.deepEqual(planShot(player, target, -1), planShot(player, target, 0));
  assert.deepEqual(planShot(player, target, 2), planShot(player, target, 1));
  for (const bad of [null, { x: NaN, y: 34 }, { x: 105, y: Infinity }]) assert.equal(planShot(player, bad), null);
  assert.equal(planShot(null, target), null);
  assert.equal(planShot(player, target, NaN), null);
  assert.equal(planShot({ ...player, pos: { x: 105, y: 34 } }, target), null);
  assert.equal(planShot({ ...player, phys: { shotSpeed: 0 } }, target), null);
  assert.equal(planShot({ ...player, phys: { shotSpeed: 0.1 } }, target), null);
});
