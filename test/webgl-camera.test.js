import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Camera, shootingPose, applyPose, frameFirstPerson } from '../src/ui/camera.js';
import { STATES } from '../src/game/constants.js';
import { RendererWebGL } from '../src/ui/renderer_webgl.js';

class Vector {
  constructor(x = 0, y = 0, z = 0) { Object.assign(this, { x, y, z }); }
  set(x, y, z) { Object.assign(this, { x, y, z }); }
  copy(point) { this.set(point.x, point.y, point.z); }
}
function renderer() {
  const r = Object.create(RendererWebGL.prototype);
  Object.assign(r, {
    camera: new Camera(), THREE: { Vector3: Vector },
    three: { position: new Vector(), lookAt(target) { this.target = target; }, updateProjectionMatrix() {} },
    keyLight: {
      position: new Vector(),
      target: { position: new Vector(), updateMatrixWorld() {} },
      shadow: { camera: { updateProjectionMatrix() {} } },
    },
  });
  return r;
}

test('WebGL camera keeps 38 m/s backwards and sideways passes visible while returning from shot view', () => {
  for (const portrait of [false, true]) {
    for (const attackDir of [-1, 1]) {
      for (const velocity of [{ x: -38 * attackDir, y: 0 }, { x: 0, y: 38 }, { x: 0, y: -38 }]) {
        const r = renderer();
        const ball = { pos: { x: attackDir > 0 ? 85 : 20, y: 34 }, z: 0 };
        const carrier = { pos: { ...ball.pos } };
        const goal = { x: attackDir > 0 ? 105 : 0, y: 34 };
        const layout = {
          w: portrait ? 390 : 1280, h: portrait ? 844 : 720,
          portrait, viewAttackDir: attackDir, shooter: false, shotAnchor: { carrier, goal },
        };
        r.camera.setViewport(layout.w, layout.h);
        r.pose = shootingPose(carrier, goal, portrait);
        applyPose(r.camera, r.pose);
        r.smoothBall = { ...ball.pos };
        r.shotBlend = 1;
        r.updateCamera({ ball }, { ...layout, shooter: true }, 1);
        let previousScreen = r.camera.ballFrame;
        let previousEye = { ...r.camera.eye };
        for (let frame = 0; frame < 165; frame++) {
          if (frame < 45) {
            ball.pos.x += velocity.x / 60;
            ball.pos.y += velocity.y / 60;
          }
          r.updateCamera({ ball }, layout, 1 / 60);
          const screen = r.camera.project({ ...ball.pos, z: 0.22 });
          assert.ok(screen.visible && screen.x >= layout.w * 0.2 - 1e-6 && screen.x <= layout.w * 0.8 + 1e-6,
            `ball x ${screen.x} in ${layout.w}px frame ${frame}, portrait=${portrait}, dir=${attackDir}`);
          assert.ok(screen.y >= Math.min(160, layout.h * 0.48) - 1e-6 && screen.y <= layout.h * 0.7 + 1e-6,
            `ball y ${screen.y} in ${layout.h}px frame ${frame}`);
          assert.ok(Math.hypot((screen.x - previousScreen.x) / layout.w, (screen.y - previousScreen.y) / layout.h) < 0.03,
            `camera return swept ball across the screen at frame ${frame}`);
          assert.ok(Math.hypot(r.camera.eye.x - previousEye.x, r.camera.eye.y - previousEye.y,
            r.camera.eye.z - previousEye.z) <= 1.6, `camera eye snapped at frame ${frame}`);
          previousScreen = screen;
          previousEye = { ...r.camera.eye };
          // The Three camera must mirror the projection used to interpret kicks.
          assert.equal(r.three.position.x, r.camera.eye.x);
          assert.equal(r.three.position.y, r.camera.eye.z);
          assert.equal(r.three.position.z, -r.camera.eye.y);
          assert.equal(r.three.target.x, r.camera.target.x);
          assert.equal(r.three.target.y, r.camera.target.z);
          assert.equal(r.three.target.z, -r.camera.target.y);
          assert.equal(r.three.fov, r.camera.fovY * 180 / Math.PI);
        }
      }
    }
  }
});

test('shot return ignores the old screen composition after resizing or explicitly resetting the view', () => {
  for (const resize of [false, true]) {
    const snapshots = [];
    for (const staleFrame of [null, { x: 0, y: 0, visible: true }]) {
      const r = renderer();
      const ball = { pos: { x: 85, y: 34 }, z: 0 };
      const layout = {
        w: 390, h: 844, portrait: true, viewAttackDir: 1,
        shooter: true, shotAnchor: { carrier: { pos: { ...ball.pos } }, goal: { x: 105, y: 34 } },
      };
      r.shotBlend = 1;
      r.updateCamera({ ball }, layout, 1);
      r.camera.ballFrame = staleFrame;
      layout.shooter = false;
      if (resize) Object.assign(layout, { w: 1280, h: 720, portrait: false });
      r.updateCamera({ ball }, layout, resize ? 1 / 60 : 1);
      snapshots.push({ eye: { ...r.camera.eye }, target: { ...r.camera.target }, ballFrame: { ...r.camera.ballFrame } });
    }
    assert.deepEqual(snapshots[0], snapshots[1], 'an obsolete screen point must not influence the new projection');
  }
});

test('entering first person immediately faces the free-kick target despite an old look point behind the taker', () => {
  for (const portrait of [false, true]) {
    for (const attackDir of [-1, 1]) {
      const r = renderer();
      const p = {
        id: 'taker', pos: { x: attackDir > 0 ? 82 : 23, y: 34 },
        facing: { x: attackDir, y: 0 }, character: { look: { size: 1 } },
      };
      const layout = {
        w: portrait ? 390 : 1280, h: portrait ? 844 : 720,
        portrait, firstPerson: true, eyePlayer: p,
        lookAt: { x: attackDir > 0 ? 105 : 0, y: 34 },
      };
      r.smoothedLook = { x: 52, y: 34 };
      r.camera.ballFrame = { x: 100, y: 300, visible: true };
      r.updateCamera({ ball: { pos: p.pos, z: 0 } }, layout, 1);
      assert.deepEqual(r.smoothedLook, layout.lookAt);
      assert.ok((r.camera.target.x - r.camera.eye.x) * attackDir > 0, 'first view must face the attacking goal');
      const direction = r.camera.dragToGround(layout.w / 2, layout.h * 0.8, layout.w / 2, layout.h * 0.65);
      assert.ok(direction.x * attackDir > 0.99, 'an upward kick gesture must aim toward the attacking goal');
      assert.equal(r.camera.ballFrame, null);
      assert.equal(r.returningShot, false);
      assert.equal(r.eyePlayerId, p.id);
    }
  }
});

test('changing the first-person eye resets stale look smoothing but continuous same-player tracking stays smooth', () => {
  const r = renderer();
  const layout = {
    w: 390, h: 844, portrait: true, firstPerson: true,
    eyePlayer: { id: 'first', pos: { x: 30, y: 34 }, facing: { x: 1, y: 0 } }, lookAt: { x: 52, y: 34 },
  };
  r.updateCamera({ ball: { pos: layout.eyePlayer.pos } }, layout, 1);
  layout.eyePlayer = { id: 'new-taker', pos: { x: 82, y: 34 }, facing: { x: 1, y: 0 } };
  layout.lookAt = { x: 105, y: 34 };
  r.updateCamera({ ball: { pos: layout.eyePlayer.pos } }, layout, 1);
  assert.deepEqual(r.smoothedLook, layout.lookAt);
  assert.ok(r.camera.target.x > r.camera.eye.x);
  layout.lookAt = { x: 100, y: 45 };
  r.updateCamera({ ball: { pos: layout.eyePlayer.pos } }, layout, 1 / 60);
  assert.ok(r.smoothedLook.x > 100 && r.smoothedLook.x < 105);
  assert.ok(r.smoothedLook.y > 34 && r.smoothedLook.y < 45);
  layout.firstPerson = false;
  layout.viewAttackDir = 1;
  r.updateCamera({ ball: { pos: layout.eyePlayer.pos } }, layout, 1);
  assert.equal(r.wasFirstPerson, false);
  layout.firstPerson = true;
  layout.lookAt = { x: 105, y: 34 };
  r.updateCamera({ ball: { pos: layout.eyePlayer.pos } }, layout, 1);
  assert.deepEqual(r.smoothedLook, layout.lookAt, 'reentering the same player also resets the look');
});

test('first-person released kicks remain visible at their actual airborne height without moving the eye', () => {
  for (const portrait of [false, true]) {
    for (const attackDir of [-1, 1]) {
      const r = renderer();
      const p = { id: 'taker', pos: { x: attackDir > 0 ? 82 : 23, y: 34 }, facing: { x: attackDir, y: 0 } };
      const layout = {
        w: portrait ? 390 : 1280, h: portrait ? 844 : 720, portrait,
        firstPerson: true, eyePlayer: p, lookAt: { x: p.pos.x + attackDir * 20, y: 34 },
      };
      const match = { state: STATES.PLAY, ball: { pos: { ...p.pos }, z: 0, owner: p.id } };
      r.updateCamera(match, layout, 1);
      const eye = { ...r.camera.eye };
      match.ball.owner = null;
      for (const [distance, height] of [[4, 2], [8, 6], [12, 12], [18, 6], [22, 0]]) {
        match.ball.pos.x = p.pos.x + attackDir * distance;
        match.ball.z = height;
        r.updateCamera(match, layout, 1 / 60);
        const screen = r.camera.project({ ...match.ball.pos, z: height + 0.22 });
        assert.ok(screen.visible && screen.x >= layout.w * 0.2 - 1e-6 && screen.x <= layout.w * 0.8 + 1e-6);
        assert.ok(screen.y >= Math.min(160, layout.h * 0.48) - 1e-6 && screen.y <= layout.h - 100 + 1e-6,
          `airborne ball at ${height}m went outside the visible first-person area`);
        assert.deepEqual(r.camera.eye, eye);
      }
      // Staged kicks and possession retain the intended facing composition.
      for (const state of [STATES.KICKOFF, STATES.SET_PIECE]) {
        match.state = state;
        r.updateCamera(match, layout, 1);
        const expected = new Camera();
        frameFirstPerson(expected, p, layout.lookAt, portrait);
        assert.deepEqual(r.camera.target, expected.target);
        assert.equal(r.camera.ballFrame, null);
      }
    }
  }
});
