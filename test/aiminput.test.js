import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AimInput } from '../src/ui/aiminput.js';
import { Camera, frameFirstPerson, shootingPose, applyPose } from '../src/ui/camera.js';
import { computeAimLayout } from '../src/ui/layout.js';
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

test('maths UI keyboard use cannot queue whole-team specials or pause', () => {
  const input = makeInput();
  input.configure({ specialButtons: [specialButton, { ...specialButton, human: 1 }] });
  for (const key of ['l', '3', 'p']) {
    input.onKey({ key, target: { closest: () => ({ tagName: 'BUTTON' }) },
      preventDefault: () => assert.fail('UI browser defaults must survive') });
    input.onKey({ key, target: { isContentEditable: true },
      preventDefault: () => assert.fail('editing defaults must survive') });
    input.onKey({ key, defaultPrevented: true });
  }
  assert.deepEqual(input.drainSpecials(), []);
  assert.equal(input.takePause(), false);
  input.onKey({ key: 'l', target: { closest: () => null } });
  input.onKey({ key: '3', target: { closest: () => null } });
  input.onKey({ key: 'p', target: { closest: () => null } });
  assert.deepEqual(input.drainSpecials(), [0, 1], 'canvas and body retain gameplay keys');
  assert.equal(input.takePause(), true);
});

test('unhandled Escape still pauses from decision buttons while handled maths Escape does not', () => {
  const input = makeInput();
  const target = { closest: () => ({ tagName: 'BUTTON' }) };
  input.onKey({ key: 'Escape', target });
  assert.equal(input.takePause(), true);
  input.onKey({ key: 'Escape', target, defaultPrevented: true });
  assert.equal(input.takePause(), false);
});

test('net taps and final release coordinates choose shot height instead of grass behind goal', () => {
  const input = makeInput();
  const goal = { x: 105, y: 34 };
  frameFirstPerson(input.camera, { pos: { x: 94, y: 34 }, facing: { x: 1, y: 0 } }, goal, true);
  input.configure({ getShootingGoal: () => goal, getKickOwner: () => 9 });
  const p = input.camera.project({ ...goal, y: 32, z: 1.9 });
  const pointer = (id, point) => ({ pointerId: id, clientX: point.x, clientY: point.y, preventDefault() {} });
  input.onDown(pointer(1, p));
  assert.ok(input.aimState(0).shot, 'tap placement already previews while held');
  input.onUp(pointer(1, p));
  const tap = input.drainReleases()[0];
  assert.equal(tap.tap, false);
  assert.ok(Math.abs(tap.shot.target.y - 32) < 1e-8);
  assert.ok(Math.abs(tap.shot.target.z - 1.9) < 1e-8);
  input.onDown(pointer(2, { x: 200, y: 700 }));
  // Browsers can coalesce the last move: pointerup still names the target.
  input.onUp(pointer(2, p));
  assert.deepEqual(input.drainReleases()[0].shot.target, tap.shot.target);
});

test('dragging away from the net cancels placement without producing a pass or run', () => {
  const input = makeInput();
  const goal = { x: 105, y: 34 };
  frameFirstPerson(input.camera, { pos: { x: 94, y: 34 }, facing: { x: 1, y: 0 } }, goal, true);
  input.configure({ getShootingGoal: () => goal, getKickOwner: () => 9 });
  const p = input.camera.project({ ...goal, z: 1 });
  const pointer = (point) => ({ pointerId: 1, clientX: point.x, clientY: point.y, preventDefault() {} });
  input.onDown(pointer(p));
  input.onMove(pointer({ x: 0, y: 800 }));
  assert.equal(input.aimState(0).active, false);
  input.onUp(pointer({ x: 0, y: 800 }));
  const release = input.drainReleases()[0];
  assert.equal(release.cancelledShot, true);
  assert.equal(release.tap, false);
  assert.equal(release.path, null);
  assert.equal(release.dir, null);
});

function splitGoalInput(coop) {
  const input = makeInput();
  const goal = { x: 105, y: 34 };
  const layout = computeAimLayout(390, 844, 2, 1);
  input.camera.setViewport(layout.w, layout.h);
  applyPose(input.camera, shootingPose({ pos: { x: 85, y: 34 } }, goal, true));
  input.configure({
    zones: layout.zones,
    getShootingGoal: human => human === 0 || coop ? goal : null,
    getKickOwner: human => human === 0 || coop ? 9 : null,
  });
  const net = input.camera.project({ ...goal, z: 1.8 });
  assert.equal(input.zoneFor(net), 1, 'the visible upper net lies in P2’s portrait touch zone');
  return { input, net };
}

test('portrait versus net touches crossing the split route to the only eligible shooter', () => {
  const { input, net } = splitGoalInput(false);
  input.onDown(pointer(1, net.x, net.y));
  assert.equal(input.aimState(1), null, 'the defending human must not receive the shot');
  assert.ok(input.aimState(0)?.shot, 'the attacking human previews their placed shot');
  input.onUp(pointer(1, net.x, net.y));
  const release = input.drainReleases()[0];
  assert.equal(release.human, 0);
  assert.equal(release.kickerId, 9);
  assert.equal(release.tap, false);
  assert.equal(release.shot.target.x, 105);
  assert.ok(Math.abs(release.shot.target.z - 1.8) < 1e-8);
});

test('portrait co-op net touches preserve zone ownership when both learners can shoot', () => {
  const { input, net } = splitGoalInput(true);
  input.onDown(pointer(1, net.x, net.y));
  assert.equal(input.aimState(0), null, 'routing must not steal the partner’s eligible touch');
  assert.ok(input.aimState(1)?.shot);
  input.onUp(pointer(1, net.x, net.y));
  const release = input.drainReleases()[0];
  assert.equal(release.human, 1, 'shot ownership determines which learner spends their saved focus');
  assert.equal(release.kickerId, 9);
  assert.equal(release.tap, false);
  assert.equal(release.shot.target.x, 105);
});
