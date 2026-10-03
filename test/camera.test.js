import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Camera, frameSideline } from '../src/ui/camera.js';
import { PITCH } from '../src/game/constants.js';

function cam(w = 400, h = 800) {
  const c = new Camera();
  c.setViewport(w, h);
  c.setView({ x: -30, y: PITCH.width / 2, z: 24 }, { x: 40, y: PITCH.width / 2, z: 0 }, 50);
  return c;
}

test('a point at the centre of view projects to the centre of the canvas', () => {
  const c = cam();
  // Aim the camera straight at a known point and project that point.
  c.setView({ x: 0, y: 34, z: 10 }, { x: 50, y: 34, z: 0 }, 50);
  const p = c.project({ x: 50, y: 34, z: 0 });
  assert.ok(Math.abs(p.x - 200) < 0.5, `x ${p.x}`);
  assert.ok(Math.abs(p.y - 400) < 0.5, `y ${p.y}`);
  assert.ok(p.visible);
});

test('things further away project smaller', () => {
  const c = cam();
  const near = c.project({ x: 10, y: 34, z: 0 });
  const far = c.project({ x: 90, y: 34, z: 0 });
  assert.ok(far.depth > near.depth, 'depth should grow with distance');
  assert.ok(far.scale < near.scale, 'scale should shrink with distance');
});

test('points behind the camera are not visible', () => {
  const c = cam();
  const behind = c.project({ x: -60, y: 34, z: 0 });
  assert.equal(behind.visible, false);
});

test('height moves a point up the screen', () => {
  const c = cam();
  const ground = c.project({ x: 50, y: 34, z: 0 });
  const air = c.project({ x: 50, y: 34, z: 6 });
  assert.ok(air.y < ground.y, 'a lifted ball should draw higher on screen');
});

test('projecting a ground point and unprojecting it returns the same point', () => {
  const c = cam();
  for (const pt of [{ x: 20, y: 10 }, { x: 60, y: 34 }, { x: 90, y: 58 }]) {
    const s = c.project({ ...pt, z: 0 });
    assert.ok(s.visible);
    const back = c.screenToGround(s.x, s.y);
    assert.ok(back, 'ray should hit the ground');
    assert.ok(Math.abs(back.x - pt.x) < 0.05, `x ${back.x} vs ${pt.x}`);
    assert.ok(Math.abs(back.y - pt.y) < 0.05, `y ${back.y} vs ${pt.y}`);
  }
});

test('a ray towards the sky misses the ground', () => {
  const c = cam();
  assert.equal(c.screenToGround(200, -4000), null);
});

test('dragging up the screen aims away from the camera', () => {
  const c = cam();
  // Camera sits at low x looking towards high x, so "away" is +x.
  const d = c.dragToGround(200, 600, 200, 400);
  assert.ok(d.x > 0.8, `expected mostly +x, got ${JSON.stringify(d)}`);
  const back = c.dragToGround(200, 400, 200, 600);
  assert.ok(back.x < -0.8, `expected mostly -x, got ${JSON.stringify(back)}`);
});

test('a drag maps to a ground direction that points the same way on screen', () => {
  const c = cam();
  const from = { x: 200, y: 600 };
  // The invariant that matters to a player: whichever way you drag, the ball
  // should set off that way on screen.
  for (const to of [{ x: 320, y: 600 }, { x: 80, y: 600 }, { x: 200, y: 460 }, { x: 300, y: 520 }]) {
    const d = c.dragToGround(from.x, from.y, to.x, to.y);
    assert.ok(Math.abs(Math.hypot(d.x, d.y) - 1) < 1e-6, 'must be normalised');
    const origin = c.screenToGround(from.x, from.y);
    const a = c.project({ ...origin, z: 0 });
    const b = c.project({ x: origin.x + d.x * 6, y: origin.y + d.y * 6, z: 0 });
    const dragX = to.x - from.x;
    const dragY = to.y - from.y;
    const moveX = b.x - a.x;
    const moveY = b.y - a.y;
    const dotted = dragX * moveX + dragY * moveY;
    assert.ok(dotted > 0, `drag ${dragX},${dragY} produced on-screen move ${moveX.toFixed(1)},${moveY.toFixed(1)}`);
  }
});

test('the action camera looks across nearby play rather than along the pitch', () => {
  for (const attackDir of [1, -1]) {
    const c = cam();
    frameSideline(c, { x: 52, y: 34 }, attackDir, true);
    assert.ok(c.eye.y < c.target.y, 'camera should look across the action from its side');
    assert.ok(c.eye.z > 6, 'camera should remain high enough to read nearby play');
    // Looking across the width, not along the length.
    const dir = { x: c.target.x - c.eye.x, y: c.target.y - c.eye.y };
    assert.ok(Math.abs(dir.y) > Math.abs(dir.x), 'the view should run across the pitch');
  }
});

test('nearby runs up the pitch stay horizontal and readable', () => {
  const c = cam(932, 430);
  frameSideline(c, { x: 52, y: 34 }, 1, false);
  const left = c.project({ x: 47, y: 34, z: 0 });
  const right = c.project({ x: 57, y: 34, z: 0 });
  assert.ok(left.visible && right.visible);
  assert.ok(Math.abs(right.x - left.x) > 150, 'nearby play should have a useful on-screen footprint');
  assert.ok(Math.abs(right.y - left.y) < 120, 'the length should run roughly level');
});

test('the action ball clears the top HUD and bottom touch controls', () => {
  for (const [w, h, portrait] of [[932, 430, false], [430, 932, true]]) {
    const c = cam(w, h);
    frameSideline(c, { x: 52, y: 34 }, 1, portrait);
    const ball = c.project({ x: 52, y: 34, z: 0.22 });
    assert.ok(ball.visible);
    assert.ok(ball.y > 130 && ball.y < h - 100, `${w}x${h}: ball must clear the HUD and controls`);
    assert.ok(ball.x > w * 0.3 && ball.x < w * 0.7);
  }
});

test('the action camera keeps the ball comfortably framed at every pitch position', () => {
  const sizes = [[400, 800, true], [430, 932, true], [932, 430, false], [844, 390, false]];
  for (const [w, h, portrait] of sizes) {
    for (const attackDir of [1, -1]) {
      for (let x = 0; x <= PITCH.length; x += 5) {
        for (let y = 0; y <= PITCH.width; y += 4) {
          const c = cam(w, h);
          frameSideline(c, { x, y }, attackDir, portrait);
          const p = c.project({ x, y, z: 0 });
          assert.ok(p.visible, `${w}x${h}: ball at ${x},${y} dir ${attackDir} is behind the camera`);
          assert.ok(p.x >= w * 0.2 && p.x <= w * 0.8, `${w}x${h}: ball at ${x},${y} too close to an edge (x=${p.x.toFixed(0)})`);
          assert.ok(p.y >= h * 0.3 && p.y <= h * 0.7, `${w}x${h}: ball at ${x},${y} too close to an edge (y=${p.y.toFixed(0)})`);
        }
      }
    }
  }
});

test('player bodies remain readable and nearby opponents remain visible on phones', () => {
  for (const [w, h] of [[320, 568], [360, 800], [390, 844], [430, 932], [844, 390], [1280, 720]]) {
    const c = cam(w, h);
    frameSideline(c, { x: 52, y: 34 }, 1, h > w);
    for (const x of [47, 52, 57]) {
      const feet = c.project({ x, y: 34, z: 0 });
      const head = c.project({ x, y: 34, z: 1.85 });
      assert.ok(feet.visible && head.visible);
      assert.ok(head.x > 0 && head.x < w && feet.x > 0 && feet.x < w, 'nearby player must remain visible');
      assert.ok(feet.y - head.y >= 30, `${w}x${h}: a standing player needs at least 30px to read, got ${feet.y - head.y}`);
    }
  }
});

// ------------------------------------------------------------- first person

import { frameFirstPerson, FIRST_PERSON } from '../src/ui/camera.js';

const player = (x, y, fx = 1, fy = 0, size = 1) => ({
  pos: { x, y },
  facing: { x: fx, y: fy },
  character: { look: { size } },
});

test('the first-person eye sits at head height, a stride behind the player', () => {
  const c = cam(430, 932);
  const p = player(40, 34);
  frameFirstPerson(c, p, { x: 70, y: 34 }, true);
  assert.ok(Math.abs(c.eye.z - FIRST_PERSON.eyeHeight) < 0.01, `eye height ${c.eye.z}`);
  // Behind the player, along their facing, by about a stride.
  const behind = p.pos.x - c.eye.x;
  assert.ok(behind > 0.5 && behind < 4, `eye should be just behind, got ${behind}`);
  assert.ok(Math.abs(c.eye.y - p.pos.y) < 0.01);
});

test('a bigger character sees from higher up', () => {
  const small = cam(430, 932);
  const big = cam(430, 932);
  frameFirstPerson(small, player(40, 34, 1, 0, 0.9), { x: 70, y: 34 }, true);
  frameFirstPerson(big, player(40, 34, 1, 0, 1.35), { x: 70, y: 34 }, true);
  assert.ok(big.eye.z > small.eye.z, 'the Gorilla should look down on the Penguin');
});

test('the first-person view looks at what it was told to look at', () => {
  const c = cam(430, 932);
  frameFirstPerson(c, player(40, 34), { x: 40, y: 60 }, true);
  // Target is off to +y, so the view direction must be mostly +y.
  const dir = { x: c.target.x - c.eye.x, y: c.target.y - c.eye.y };
  const l = Math.hypot(dir.x, dir.y);
  assert.ok(dir.y / l > 0.9, `expected to face +y, got ${JSON.stringify(dir)}`);
});

test('the view is pitched down so the ground in front is visible', () => {
  const c = cam(430, 932);
  frameFirstPerson(c, player(40, 34), { x: 70, y: 34 }, true);
  assert.ok(c.target.z < c.eye.z, 'the camera should look downwards');
  // The ball at the player's feet should project inside the canvas.
  const ball = c.project({ x: 40.8, y: 34, z: 0.22 });
  assert.ok(ball.visible, 'the ball at your feet must be in front of the camera');
  assert.ok(ball.y > 0 && ball.y < 932, `ball at your feet is off screen (y=${ball.y})`);
});

test('a very close look target does not make the view swing about', () => {
  const c = cam(430, 932);
  const p = player(40, 34);
  // Something almost on top of the player.
  frameFirstPerson(c, p, { x: 40.1, y: 34.05 }, true);
  const reach = Math.hypot(c.target.x - c.eye.x, c.target.y - c.eye.y);
  assert.ok(reach >= FIRST_PERSON.minLook - 0.01, `look distance collapsed to ${reach}`);
});

test('the ground under the crosshair unprojects back to the pitch', () => {
  const c = cam(430, 932);
  frameFirstPerson(c, player(30, 34), { x: 60, y: 34 }, true);
  const g = c.screenToGround(215, 700);
  assert.ok(g, 'the lower half of the screen should be grass');
  assert.ok(g.x > 25 && g.x < 105, `unprojected to ${g.x}, off the pitch`);
});

// ------------------------------------------------------------ shooting view

import { shootingPose, isInShootingRange, blendPose, sidelinePose } from '../src/ui/camera.js';

test('the shooting camera sits behind the player, looking at the goal', () => {
  const goal = { x: PITCH.length, y: PITCH.width / 2 };
  const carrier = { pos: { x: PITCH.length - 20, y: 30 } };
  const pose = shootingPose(carrier, goal, false);
  // Behind the carrier, on the far side from the goal.
  assert.ok(pose.eye.x < carrier.pos.x, 'camera should be behind the carrier');
  assert.ok(pose.eye.z > 2 && pose.eye.z < 9, `camera should be low, got ${pose.eye.z}`);
  assert.ok(Math.abs(pose.target.x - goal.x) < 0.01, 'it should look at the goal');
  // The carrier is between the camera and the goal.
  const total = Math.hypot(goal.x - pose.eye.x, goal.y - pose.eye.y);
  const toCarrier = Math.hypot(carrier.pos.x - pose.eye.x, carrier.pos.y - pose.eye.y);
  assert.ok(toCarrier < total, 'the carrier should be in shot, in front of the camera');
});

test('the shooting camera only comes in when near enough to goal', () => {
  const goal = { x: PITCH.length, y: PITCH.width / 2 };
  assert.ok(isInShootingRange({ pos: { x: PITCH.length - 15, y: 34 } }, goal));
  assert.ok(!isInShootingRange({ pos: { x: 40, y: 34 } }, goal));
});

test('the shooting view actually frames the goal and the shooter', () => {
  const goal = { x: PITCH.length, y: PITCH.width / 2 };
  const carrier = { pos: { x: PITCH.length - 18, y: 26 } };
  for (const [w, h, portrait] of [[932, 430, false], [430, 932, true]]) {
    const c = cam(w, h);
    const pose = shootingPose(carrier, goal, portrait);
    c.setView(pose.eye, pose.target, pose.fov);
    const g = c.project({ x: goal.x, y: goal.y, z: 1.2 });
    const s = c.project({ x: carrier.pos.x, y: carrier.pos.y, z: 0.9 });
    assert.ok(g.visible && g.x > 0 && g.x < w && g.y > 0 && g.y < h, `${w}x${h}: goal out of shot`);
    assert.ok(s.visible && s.x > 0 && s.x < w && s.y > 0 && s.y < h, `${w}x${h}: shooter out of shot`);
  }
});

test('blending between camera poses moves smoothly from one to the other', () => {
  const wide = sidelinePose({ x: 80, y: 34 }, 1, false);
  const close = shootingPose({ pos: { x: 90, y: 34 } }, { x: PITCH.length, y: 34 }, false);
  const start = blendPose(wide, close, 0);
  const end = blendPose(wide, close, 1);
  const mid = blendPose(wide, close, 0.5);
  assert.deepEqual(start.eye, wide.eye);
  assert.deepEqual(end.eye, close.eye);
  assert.ok(mid.eye.z > Math.min(wide.eye.z, close.eye.z) && mid.eye.z < Math.max(wide.eye.z, close.eye.z));
  assert.ok(mid.fov > Math.min(wide.fov, close.fov) - 0.01 && mid.fov < Math.max(wide.fov, close.fov) + 0.01);
});

test('action framing follows a long carry without letting the player shrink away', () => {
  for (const portrait of [false, true]) {
    for (let y = 0; y <= PITCH.width; y += 2) {
      for (const x of [0, 52, PITCH.length]) {
        const c = cam(portrait ? 430 : 1280, portrait ? 932 : 720);
        frameSideline(c, { x, y }, 1, portrait);
        const feet = c.project({ x, y, z: 0 });
        const head = c.project({ x, y, z: 1.85 });
        assert.ok(feet.y - head.y >= 50, 'the carrier must stay readable through the entire carry');
      }
    }
  }
});
