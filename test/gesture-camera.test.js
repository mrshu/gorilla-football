import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Camera, frameSideline } from '../src/ui/camera.js';
import { Renderer3D } from '../src/ui/renderer3d.js';
import { RendererWebGL } from '../src/ui/renderer_webgl.js';

// Test both renderer paths without WebGL/DOM: a held gesture must bypass
// every camera-follow/framing update as the live ball moves across the pitch.
for (const Renderer of [Renderer3D, RendererWebGL]) {
  test(`${Renderer.name} leaves the projection unchanged during a held gesture`, () => {
    const camera = new Camera();
    camera.setViewport(1280, 720);
    frameSideline(camera, { x: 70, y: 26 }, 1, false);
    const start = camera.clone();
    const renderer = { camera, smoothBall: { x: 70, y: 26 } };
    for (const pos of [{ x: 90, y: 10 }, { x: 95, y: 55 }, { x: 30, y: 34 }]) {
      Renderer.prototype.updateCamera.call(renderer, { ball: { pos } }, { aiming: true, w: 1280, h: 720 }, 0.1);
      assert.deepEqual(camera.eye, start.eye);
      assert.deepEqual(camera.target, start.target);
      assert.deepEqual(camera.screenToGround(650, 450), start.screenToGround(650, 450));
    }
  });
}

test('a camera snapshot remains independent when the live view is resized or turned', () => {
  const live = new Camera();
  live.setViewport(1280, 720);
  frameSideline(live, { x: 52, y: 34 }, 1, false);
  const captured = live.clone();
  const point = captured.screenToGround(650, 450);
  live.setViewport(390, 844);
  frameSideline(live, { x: 90, y: 10 }, -1, true);
  assert.deepEqual(captured.screenToGround(650, 450), point);
  assert.equal(captured.viewport.w, 1280);
  assert.notDeepEqual(captured.eye, live.eye);
});
