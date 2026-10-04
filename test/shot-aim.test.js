import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Camera, applyPose, shootingPose, frameFirstPerson } from '../src/ui/camera.js';
import { shotTargetAt } from '../src/ui/shot-aim.js';
import { PITCH, PHYSICS } from '../src/game/constants.js';

function fixture(firstPerson, portrait, attackDir) {
  const camera = new Camera();
  camera.setViewport(portrait ? 390 : 844, portrait ? 844 : 390);
  const goal = { x: attackDir > 0 ? PITCH.length : 0, y: PITCH.width / 2 };
  const player = { pos: { x: goal.x - attackDir * (firstPerson ? 11 : 24), y: 34 }, facing: { x: attackDir, y: 0 } };
  if (firstPerson) frameFirstPerson(camera, player, goal, portrait);
  else applyPose(camera, shootingPose(player, goal, portrait));
  return { camera, goal };
}

test('goal targeting preserves lateral position and height in both close camera modes and attack directions', () => {
  for (const firstPerson of [false, true]) for (const portrait of [false, true]) for (const attackDir of [-1, 1]) {
    const { camera, goal } = fixture(firstPerson, portrait, attackDir);
    for (const yOffset of [-2.8, 0, 2.8]) for (const z of [0.35, 1.2, 2.05]) {
      const world = { x: goal.x, y: goal.y + yOffset, z };
      const screen = camera.project(world);
      assert.ok(screen.visible);
      const target = shotTargetAt(camera, screen, goal);
      assert.ok(target, `missing target: firstPerson=${firstPerson}, portrait=${portrait}, attackDir=${attackDir}`);
      assert.equal(target.x, goal.x);
      assert.ok(Math.abs(target.y - world.y) < 1e-8);
      assert.ok(Math.abs(target.z - world.z) < 1e-8);
    }
  }
});

test('net-centre and crossbar touches hit the vertical goal instead of the ground behind it', () => {
  const { camera, goal } = fixture(true, true, 1);
  const middle = camera.project({ ...goal, z: 1.2 });
  const ground = camera.screenToGround(middle.x, middle.y);
  assert.ok(ground.x > goal.x + 10, 'this is a real perspective case where grass targeting overshoots');
  const target = shotTargetAt(camera, middle, goal);
  assert.equal(target.x, goal.x);
  assert.ok(Math.abs(target.z - 1.2) < 1e-8);
  const bar = camera.project({ ...goal, z: PITCH.goalHeight });
  assert.equal(camera.screenToGround(bar.x, bar.y), null, 'crossbar lies above the first-person horizon');
  assert.equal(shotTargetAt(camera, bar, goal).z, PITCH.goalHeight - PHYSICS.ballRadius - 0.1);
});

test('near posts and crossbar are tolerated but returned ball centres clear all goal edges', () => {
  const { camera, goal } = fixture(false, true, 1);
  const halfWidth = PITCH.goalWidth / 2;
  for (const y of [goal.y - halfWidth - 0.3, goal.y + halfWidth + 0.3]) {
    for (const z of [-0.3, PITCH.goalHeight + 0.3]) {
      const target = shotTargetAt(camera, camera.project({ x: goal.x, y, z }), goal);
      assert.ok(target);
      assert.ok(target.y >= goal.y - halfWidth + PHYSICS.ballRadius);
      assert.ok(target.y <= goal.y + halfWidth - PHYSICS.ballRadius);
      assert.ok(target.z >= PHYSICS.ballRadius && target.z <= PITCH.goalHeight - PHYSICS.ballRadius);
    }
  }
  for (const world of [
    { x: goal.x, y: goal.y + halfWidth + 0.5, z: 1 },
    { x: goal.x, y: goal.y, z: PITCH.goalHeight + 0.5 },
    { x: goal.x, y: goal.y, z: -0.5 },
  ]) assert.equal(shotTargetAt(camera, camera.project(world), goal), null);
  const outsidePost = camera.project({ x: goal.x, y: goal.y + halfWidth + 0.3, z: 1 });
  assert.equal(shotTargetAt(camera, outsidePost, goal, { margin: 0 }), null);
  assert.ok(shotTargetAt(camera, outsidePost, goal, { margin: 0.35 }));
});

test('behind-camera goals, parallel rays and near-plane intersections cannot become shots', () => {
  const camera = new Camera();
  camera.setViewport(390, 844);
  camera.setView({ x: 50, y: 34, z: 1.2 }, { x: 70, y: 34, z: 1.2 }, 58);
  const centre = { x: 195, y: 422 };
  assert.equal(shotTargetAt(camera, centre, { x: 0, y: 34 }), null);
  assert.equal(shotTargetAt(camera, centre, { x: 50.2, y: 34 }), null);
  camera.setView({ x: 50, y: 34, z: 1.2 }, { x: 50, y: 54, z: 1.2 }, 58);
  assert.equal(shotTargetAt(camera, centre, { x: 105, y: 34 }), null);
});

test('malformed camera, points, goals and tolerance return null without mutating caller input', () => {
  const { camera, goal } = fixture(false, true, 1);
  const point = camera.project({ ...goal, z: 1 });
  for (const bad of [null, {}, { x: NaN, y: point.y }, { x: point.x, y: Infinity }, { x: -1, y: point.y }]) {
    assert.equal(shotTargetAt(camera, bad, goal), null);
  }
  for (const bad of [null, {}, { x: Infinity, y: 34 }, { x: goal.x, y: '34' }]) {
    assert.equal(shotTargetAt(camera, point, bad), null);
  }
  for (const bad of [null, {}, { viewport: { w: 0, h: 844 }, ray() {} },
    { viewport: camera.viewport, ray() { throw new Error('invalid camera'); } },
    { viewport: camera.viewport, ray: () => ({ origin: { x: 0, y: 34, z: 1 }, dir: { x: Infinity, y: 0, z: 0 } }) }]) {
    assert.equal(shotTargetAt(bad, point, goal), null);
  }
  for (const margin of [-1, Infinity, NaN, '0.4']) assert.equal(shotTargetAt(camera, point, goal, { margin }), null);
  const captured = camera.clone();
  const frozenGoal = Object.freeze({ ...goal });
  const frozenPoint = Object.freeze({ x: point.x, y: point.y });
  camera.setView({ x: 50, y: 34, z: 1 }, { x: 0, y: 34, z: 1 }, 58);
  assert.ok(shotTargetAt(captured, frozenPoint, frozenGoal), 'gesture snapshot remains usable after the live camera changes');
  assert.deepEqual(frozenGoal, goal);
  assert.deepEqual(frozenPoint, { x: point.x, y: point.y });
});
