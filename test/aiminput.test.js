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

test('a loop returning to its start remains a stroke rather than becoming a run tap', () => {
  const input = makeInput();
  input.onDown(pointer(1, 200, 600));
  for (const [x, y] of [[260, 550], [200, 500], [140, 550], [200, 600]]) {
    input.onMove(pointer(1, x, y));
  }
  assert.equal(input.aimState(0).active, true);
  input.onUp(pointer(1, 200, 600));
  const [release] = input.drainReleases();
  assert.equal(release.tap, false);
  assert.ok(release.path.length >= 4);
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

const pointer = (pointerId, x, y) => ({ pointerId, clientX: x, clientY: y, preventDefault() {} });
const specialButton = { human: 0, x: 8, y: 720, w: 140, h: 56, enabled: true };

test('special touch is a separate action and never a grass gesture', () => {
  const input = makeInput();
  input.configure({ specialButtons: [specialButton] });
  input.onDown(pointer(1, 70, 744));
  assert.equal(input.hasGesture, false);
  input.onMove(pointer(1, 90, 750));
  input.onUp(pointer(1, 90, 750));
  assert.deepEqual(input.drainSpecials(), [0]);
  assert.deepEqual(input.drainSpecials(), []);
  assert.deepEqual(input.drainReleases(), []);
});

test('disabled specials, cancelled touches and release outside button do nothing', () => {
  const input = makeInput();
  input.configure({ specialButtons: [{ ...specialButton, enabled: false }] });
  input.onDown(pointer(1, 70, 744));
  input.onUp(pointer(1, 70, 744));
  input.configure({ specialButtons: [specialButton] });
  input.onDown(pointer(2, 70, 744));
  input.onCancel(pointer(2, 70, 744));
  input.onUp(pointer(2, 70, 744));
  input.onDown(pointer(3, 70, 744));
  input.onUp(pointer(3, 200, 700));
  assert.deepEqual(input.drainSpecials(), []);
  assert.deepEqual(input.drainReleases(), []);
});

test('a special that becomes unavailable while held is not queued', () => {
  const input = makeInput();
  input.configure({ specialButtons: [specialButton] });
  input.onDown(pointer(1, 70, 744));
  input.configure({ specialButtons: [{ ...specialButton, enabled: false }] });
  input.onUp(pointer(1, 70, 744));
  assert.deepEqual(input.drainSpecials(), []);
});

test('keyboard specials support both humans without key repeat or modified shortcuts', () => {
  const input = makeInput();
  input.configure({ specialButtons: [specialButton, { ...specialButton, human: 1 }] });
  input.onKey({ key: 'L' });
  input.onKey({ key: 'l', repeat: true });
  input.onKey({ key: '3' });
  input.onKey({ key: '3', metaKey: true });
  assert.deepEqual(input.drainSpecials(), [0, 1]);
  input.configure({ specialButtons: [{ ...specialButton, enabled: false }] });
  input.onKey({ key: 'l' });
  input.onKey({ key: '3' });
  assert.deepEqual(input.drainSpecials(), []);
});

test('pointercancel discards an aimed shot and a tap', () => {
  const input = makeInput();
  for (const to of [{ x: 200, y: 500 }, { x: 200, y: 700 }]) {
    input.onDown(pointer(1, 200, 700));
    input.onMove(pointer(1, to.x, to.y));
    assert.equal(input.hasGesture, true);
    input.onCancel(pointer(1, to.x, to.y));
    input.onUp(pointer(1, to.x, to.y));
    assert.equal(input.hasGesture, false);
  }
  assert.deepEqual(input.drainReleases(), []);
});

test('reset clears held gestures, special touches and queued actions', () => {
  const input = makeInput();
  input.configure({ specialButtons: [specialButton] });
  input.onDown(pointer(1, 200, 700));
  input.onDown(pointer(2, 70, 744));
  input.onKey({ key: 'l' });
  input.reset();
  input.onUp(pointer(1, 200, 500));
  input.onUp(pointer(2, 70, 744));
  assert.equal(input.hasGesture, false);
  assert.deepEqual(input.drainSpecials(), []);
  assert.deepEqual(input.drainReleases(), []);
});

test('gesture projection and kicker identity stay fixed when live camera and owner change', () => {
  const input = makeInput();
  let owner = 8;
  const snapshot = {
    dragToGround: () => ({ x: 1, y: 0 }),
    screenToGround: (x, y) => ({ x, y }),
  };
  const camera = { ...snapshot, clone: () => snapshot };
  input.configure({ camera, getKickOwner: () => owner });
  input.onDown(pointer(1, 200, 700));
  camera.dragToGround = () => ({ x: -1, y: 0 });
  camera.screenToGround = (x, y) => ({ x: x + 100, y: y + 100 });
  owner = 9;
  input.onMove(pointer(1, 200, 500));
  assert.equal(input.aimState(0).kickerId, 8);
  assert.deepEqual(input.aimState(0).path, [{ x: 200, y: 700 }, { x: 200, y: 500 }]);
  input.onUp(pointer(1, 200, 500));
  const release = input.drainReleases()[0];
  assert.equal(release.kickerId, 8);
  assert.deepEqual(release.dir, { x: 1, y: 0 });
  assert.deepEqual(release.path, [{ x: 200, y: 700 }, { x: 200, y: 500 }]);
});
