import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AimInput } from '../src/ui/aiminput.js';
import { Camera } from '../src/ui/camera.js';
import { AIM, PITCH } from '../src/game/constants.js';

// A canvas stand-in: AimInput only ever listens and measures.
function fakeCanvas() {
  return {
    addEventListener() {},
    setPointerCapture() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 800 }),
  };
}

function makeInput() {
  const camera = new Camera();
  camera.setViewport(400, 800);
  camera.setView({ x: 0, y: PITCH.width / 2, z: 24 }, { x: 60, y: PITCH.width / 2, z: 0 }, 50);
  const input = new AimInput(fakeCanvas());
  input.configure({ camera, zones: [{ x: 0, y: 0, w: 400, h: 800 }] });
  return input;
}

const drag = (input, from, to) => input.readDrag({ start: from, current: to, moved: 0 });

test('a short drag reads as a tap, not a kick', () => {
  const input = makeInput();
  const r = drag(input, { x: 200, y: 600 }, { x: 200 + AIM.tapPx - 2, y: 600 });
  assert.equal(r.tap, true);
  assert.equal(r.power, 0);
});

test('power grows with drag length and saturates at full stretch', () => {
  const input = makeInput();
  const short = drag(input, { x: 200, y: 600 }, { x: 200, y: 600 - (AIM.tapPx + 30) });
  const long = drag(input, { x: 200, y: 600 }, { x: 200, y: 600 - AIM.maxDragPx });
  const past = drag(input, { x: 200, y: 600 }, { x: 200, y: 600 - AIM.maxDragPx * 3 });
  assert.ok(short.power > 0 && short.power < long.power, `short ${short.power} long ${long.power}`);
  assert.ok(Math.abs(long.power - 1) < 1e-6, `full drag should be full power, got ${long.power}`);
  assert.equal(past.power, 1, 'power must not exceed 1');
});

test('dragging away from the camera aims up the pitch', () => {
  const input = makeInput();
  const r = drag(input, { x: 200, y: 700 }, { x: 200, y: 450 });
  assert.equal(r.tap, false);
  assert.ok(r.dir.x > 0.8, `expected to aim up the pitch, got ${JSON.stringify(r.dir)}`);
  assert.ok(Math.abs(Math.hypot(r.dir.x, r.dir.y) - 1) < 1e-6, 'direction must be normalised');
});

test('dragging back towards the camera aims backwards', () => {
  const input = makeInput();
  const r = drag(input, { x: 200, y: 450 }, { x: 200, y: 700 });
  assert.ok(r.dir.x < -0.8, `expected to aim back, got ${JSON.stringify(r.dir)}`);
});

test('two humans get their own half of the screen', () => {
  const input = makeInput();
  input.configure({ zones: [{ x: 0, y: 400, w: 400, h: 400 }, { x: 0, y: 0, w: 400, h: 400 }] });
  assert.equal(input.zoneFor({ x: 200, y: 700 }), 0);
  assert.equal(input.zoneFor({ x: 200, y: 100 }), 1);
});

test('a touch outside every zone still belongs to the first player', () => {
  const input = makeInput();
  input.configure({ zones: [{ x: 0, y: 500, w: 400, h: 300 }] });
  assert.equal(input.zoneFor({ x: 10, y: 10 }), 0);
});

test('aim state is live while held and gone once released', () => {
  const input = makeInput();
  input.drags.set(0, { start: { x: 200, y: 700 }, current: { x: 200, y: 560 }, moved: 140 });
  const live = input.aimState(0);
  assert.ok(live.active);
  assert.ok(live.power > 0);
  input.drags.delete(0);
  assert.equal(input.aimState(0), null);
});

test('releases queue up and drain once', () => {
  const input = makeInput();
  input.released.push({ human: 0, tap: false, dir: { x: 1, y: 0 }, power: 0.5 });
  assert.equal(input.drainReleases().length, 1);
  assert.equal(input.drainReleases().length, 0);
});
