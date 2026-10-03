import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Camera, frameSideline, shootingPose, applyPose, keepBallInFrame } from '../src/ui/camera.js';
import { Renderer3D, suggestionMarker } from '../src/ui/renderer3d.js';
import { computeAimLayout } from '../src/ui/layout.js';
import { STATES } from '../src/game/constants.js';

function renderer() {
  const r = Object.create(Renderer3D.prototype);
  r.camera = new Camera();
  return r;
}

function markerFixture(w = 390, h = 844, humans = 1) {
  const layout = computeAimLayout(w, h, humans, 1);
  const camera = new Camera();
  camera.setViewport(w, h);
  frameSideline(camera, { x: 52, y: 34 }, 1, layout.portrait);
  return { layout, camera };
}

test('visible suggestion ticks keep their exact projected location and world payload', () => {
  const { camera, layout } = markerFixture();
  const suggestion = Object.freeze({ kind: 'pass', point: Object.freeze({ x: 54, y: 34 }), targetId: 8 });
  const projected = camera.project({ ...suggestion.point, z: 1.4 });
  const marker = suggestionMarker(camera, suggestion, layout);
  assert.equal(marker.clipped, false);
  assert.equal(marker.x, projected.x);
  assert.equal(marker.y, projected.y);
  assert.equal(suggestion.targetId, 8);
  assert.deepEqual(suggestion.point, { x: 54, y: 34 });
});

test('offscreen and behind-camera suggestions remain reachable with a direction cue', () => {
  const { camera, layout } = markerFixture();
  const forward = suggestionMarker(camera, { kind: 'shot', point: { x: 105, y: 34 } }, layout);
  assert.equal(forward.clipped, true);
  assert.ok(forward.direction.x > 0.9);
  const behind = suggestionMarker(camera, { kind: 'pass', point: { x: 52, y: -40 } }, layout);
  assert.equal(behind.visible, false);
  assert.equal(behind.clipped, true);
  assert.ok(behind.direction.y > 0.9);
  for (const marker of [forward, behind]) {
    assert.ok(Number.isFinite(marker.x) && Number.isFinite(marker.y));
    assert.ok(marker.x >= 36 && marker.x <= layout.w - 36);
    assert.ok(marker.y >= 193 && marker.y <= layout.h - 142);
  }
});

test('edge ticks respect each human touch zone, badges, specials and the bottom hint', () => {
  for (const [w, h] of [[320, 568], [390, 844], [844, 390], [1280, 720]]) {
    for (const humans of [1, 2]) {
      const { camera, layout } = markerFixture(w, h, humans);
      for (let human = 0; human < humans; human++) {
        for (const point of [{ x: 105, y: 34 }, { x: 0, y: 34 }, { x: 52, y: -40 }]) {
          const marker = suggestionMarker(camera, { kind: 'pass', point }, layout, human);
          const zone = layout.zones[human];
          assert.ok(marker.x - 24 >= zone.x && marker.x + 24 <= zone.x + zone.w);
          assert.ok(marker.y - 24 >= Math.max(zone.y, 157));
          assert.ok(marker.y + 41 <= layout.specialButtons[human].y);
          if (zone.y + zone.h === h) assert.ok(marker.y + 41 <= h - 99);
        }
      }
    }
  }
});

test('clipped ticks render a labelled action and retain a generous hit target', () => {
  const { camera, layout } = markerFixture();
  const r = renderer();
  r.camera = camera;
  const labels = [];
  const ctx = new Proxy({
    createRadialGradient: () => ({ addColorStop() {} }),
    fillText: (text) => labels.push(text),
  }, { get: (target, property) => target[property] || (() => {}) });
  for (const kind of ['shot', 'pass']) {
    const suggestion = { kind, point: { x: 105, y: 34 } };
    const result = r.drawSuggestion(ctx, suggestion, 1 / 60, layout, 0);
    assert.ok(result.radius >= 24);
    assert.equal(result.clipped, true);
  }
  assert.deepEqual(labels, ['SHOOT', 'PASS']);
});

test('fast passes return from shot view continuously, stay visible, and settle without a handoff snap', () => {
  for (const portrait of [false, true]) {
    for (const attackDir of [-1, 1]) {
      for (const velocity of [{ x: -38 * attackDir, y: 0 }, { x: 0, y: 38 }, { x: 0, y: -38 }]) {
        const r = renderer();
        const ball = { pos: { x: attackDir > 0 ? 85 : 20, y: 34 }, z: 0 };
        const layout = computeAimLayout(portrait ? 390 : 844, portrait ? 844 : 390, 1, attackDir);
        layout.shotAnchor = { carrier: { pos: { ...ball.pos } }, goal: { x: attackDir > 0 ? 105 : 0, y: 34 } };
        r.camera.setViewport(layout.w, layout.h);
        r.pose = shootingPose(layout.shotAnchor.carrier, layout.shotAnchor.goal, portrait);
        applyPose(r.camera, r.pose);
        r.pose = keepBallInFrame(r.camera, r.pose, ball, layout);
        r.shotBlend = 1;
        r.smoothBall = { ...ball.pos };
        let previous = r.camera.ballFrame;
        let eye = { ...r.camera.eye };
        for (let frame = 0; frame < 180; frame++) {
          if (frame < 60) {
            ball.pos.x += velocity.x / 60;
            ball.pos.y += velocity.y / 60;
          }
          r.updateCamera({ ball }, layout, 1 / 60);
          const current = r.camera.project({ ...ball.pos, z: 0.22 });
          assert.ok(current.visible && current.x >= layout.w * 0.2 - 1e-6 && current.x <= layout.w * 0.8 + 1e-6);
          assert.ok(current.y >= Math.min(160, layout.h * 0.48) - 1e-6 && current.y <= layout.h * 0.7 + 1e-6);
          assert.ok(Math.hypot((current.x - previous.x) / layout.w, (current.y - previous.y) / layout.h) < 0.03,
            `screen jumps at frame ${frame}`);
          assert.ok(Math.hypot(r.camera.eye.x - eye.x, r.camera.eye.y - eye.y, r.camera.eye.z - eye.z) < 1.6,
            `camera jumps at frame ${frame}`);
          previous = current;
          eye = { ...r.camera.eye };
        }
        assert.equal(r.returningShot, false, 'return completes once the pass settles');
      }
    }
  }
});

test('first-person entry and a changed taker discard a look target from earlier play', () => {
  const r = renderer();
  const ball = { pos: { x: 82, y: 30 }, z: 0, owner: null };
  const layout = computeAimLayout(390, 844, 1, 1, true);
  layout.eyePlayer = { id: 1, pos: { ...ball.pos }, facing: { x: 1, y: 0 } };
  layout.lookAt = { x: 105, y: 34 };
  r.smoothedLook = { x: 52, y: 34 };
  r.updateCamera({ ball, state: STATES.SET_PIECE }, layout, 1);
  assert.deepEqual(r.smoothedLook, layout.lookAt);
  assert.ok(r.camera.basis.f.x > 0.9, 'first direct kick must immediately look toward the attacking goal');
  const drag = r.camera.dragToGround(195, 680, 195, 530);
  assert.ok(drag.x > 0, 'drawing up must kick toward the attacking goal');
  layout.eyePlayer = { id: 2, pos: { x: 23, y: 34 }, facing: { x: -1, y: 0 } };
  layout.lookAt = { x: 0, y: 34 };
  r.updateCamera({ ball, state: STATES.SET_PIECE }, layout, 1);
  assert.ok(r.camera.basis.f.x < -0.9);
});

test('released first-person diagonal lobs remain visible without changing the eye or a held gesture', () => {
  const r = renderer();
  const control = renderer();
  const ball = { pos: { x: 75, y: 34 }, z: 0, owner: null };
  const layout = computeAimLayout(390, 844, 1, 1, true);
  layout.eyePlayer = { id: 1, pos: { ...ball.pos }, facing: { x: 1, y: 0 } };
  layout.lookAt = { x: 95, y: 34 };
  for (const view of [r, control]) view.updateCamera({ ball, state: STATES.SET_PIECE }, layout, 1);
  layout.eyePlayer.facing = { x: Math.SQRT1_2, y: Math.SQRT1_2 };
  for (let frame = 1; frame <= 90; frame++) {
    const time = frame / 60;
    ball.pos = { x: 75 + 17.364 * Math.SQRT1_2 * time, y: 34 + 17.364 * Math.SQRT1_2 * time };
    ball.z = Math.max(0, 9.942 * time - 4.905 * time * time);
    layout.lookAt = { ...ball.pos };
    r.updateCamera({ ball, state: STATES.PLAY }, layout, 1 / 60);
    control.updateCamera({ ball, state: STATES.SET_PIECE }, layout, 1 / 60);
    const screen = r.camera.project({ ...ball.pos, z: ball.z + 0.22 });
    assert.ok(screen.visible && screen.x >= 78 - 1e-6 && screen.x <= 312 + 1e-6);
    assert.ok(screen.y >= 160 - 1e-6 && screen.y <= 744 + 1e-6);
    assert.deepEqual(r.camera.eye, control.camera.eye, 'flight tracking turns only the look direction');
    if (frame === 1) {
      const unguarded = control.camera.project({ ...ball.pos, z: ball.z + 0.22 });
      assert.ok(Math.hypot(screen.x - unguarded.x, screen.y - unguarded.y) < 1e-6,
        'releasing a kick must not snap the near-foot ball to the action view composition');
    }
  }
  const captured = r.camera.clone();
  const pose = structuredClone(r.pose);
  layout.aiming = true;
  ball.pos.x += 20;
  r.updateCamera({ ball, state: STATES.PLAY }, layout, 1 / 60);
  assert.deepEqual(r.pose, pose);
  assert.deepEqual(r.camera.ray(200, 600), captured.ray(200, 600));
});

test('resizing during a shot return discards the previous viewport composition', () => {
  const r = renderer();
  const ball = { pos: { x: 85, y: 34 }, z: 0 };
  const layout = computeAimLayout(844, 390, 1, 1);
  r.updateCamera({ ball }, layout, 1);
  r.shotBlend = 1;
  r.camera.ballFrame = { visible: true, x: 800, y: 100 };
  const portrait = computeAimLayout(390, 844, 1, 1);
  r.updateCamera({ ball }, portrait, 1);
  const screen = r.camera.project({ ...ball.pos, z: 0.22 });
  assert.ok(Math.abs(screen.x - 195) < 1);
  assert.ok(Math.abs(screen.y - 422) < 30);
});
