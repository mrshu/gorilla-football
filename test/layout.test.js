import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLayout } from '../src/ui/layout.js';
import { PITCH } from '../src/game/constants.js';

const close = (a, b, eps = 0.5) => Math.abs(a - b) <= eps;

function overlaps(a, b) {
  return Math.hypot(a.cx - b.cx, a.cy - b.cy) < a.r + b.r;
}

const SIZES = [
  [390, 844], [430, 932], [360, 800], [844, 390], [932, 430], [1024, 768], [768, 1024], [320, 568],
];

test('controls never overlap each other at any size or player count', () => {
  for (const [w, h] of SIZES) {
    for (const [humans, coop] of [[1, false], [2, false], [2, true]]) {
      const L = computeLayout(w, h, humans, coop);
      assert.equal(L.controls.length, humans);
      const all = L.controls.flatMap((c, i) => c.buttons.map((b) => ({ ...b, cluster: i })));
      for (let i = 0; i < all.length; i++) {
        for (let j = i + 1; j < all.length; j++) {
          assert.ok(!overlaps(all[i], all[j]), `${w}x${h} h=${humans}: ${all[i].id}#${all[i].cluster} overlaps ${all[j].id}#${all[j].cluster}`);
        }
      }
    }
  }
});

test('controls stay inside the screen', () => {
  for (const [w, h] of SIZES) {
    for (const [humans, coop] of [[1, false], [2, false], [2, true]]) {
      const L = computeLayout(w, h, humans, coop);
      for (const c of L.controls) {
        for (const b of c.buttons) {
          assert.ok(b.cx - b.r >= -1 && b.cx + b.r <= w + 1, `${w}x${h}: ${b.id} off-screen horizontally`);
          assert.ok(b.cy - b.r >= -1 && b.cy + b.r <= h + 1, `${w}x${h}: ${b.id} off-screen vertically`);
        }
      }
    }
  }
});

test('buttons are large enough to hit with a thumb', () => {
  for (const [w, h] of SIZES) {
    for (const [humans, coop] of [[1, false], [2, false], [2, true]]) {
      const L = computeLayout(w, h, humans, coop);
      for (const c of L.controls) for (const b of c.buttons) assert.ok(b.r >= 18, `${w}x${h} h=${humans} coop=${coop}: ${b.id} radius ${b.r}`);
    }
  }
});

test('the whole pitch fits inside the drawing area', () => {
  for (const [w, h] of SIZES) {
    const L = computeLayout(w, h, 1);
    const corners = [
      { x: 0, y: 0 },
      { x: PITCH.length, y: 0 },
      { x: 0, y: PITCH.width },
      { x: PITCH.length, y: PITCH.width },
    ].map(L.worldToScreen);
    for (const c of corners) {
      assert.ok(c.x >= L.pitch.x - 1 && c.x <= L.pitch.x + L.pitch.w + 1, `${w}x${h}: corner outside horizontally`);
      assert.ok(c.y >= L.pitch.y - 1 && c.y <= L.pitch.y + L.pitch.h + 1, `${w}x${h}: corner outside vertically`);
    }
  }
});

test('co-op control clusters never sit above the pitch (both players face the same way)', () => {
  for (const [w, h] of SIZES) {
    const L = computeLayout(w, h, 2, true);
    for (const c of L.controls) {
      for (const b of c.buttons) assert.ok(b.cy > L.pitch.y, `${w}x${h}: ${b.id} is above the pitch`);
    }
  }
});

test('the world-to-screen map is a rotation, not a mirror', () => {
  for (const [w, h] of [[430, 932], [932, 430]]) {
    const L = computeLayout(w, h, 1);
    const o = L.worldToScreen({ x: 50, y: 34 });
    const dx = L.worldToScreen({ x: 51, y: 34 });
    const dy = L.worldToScreen({ x: 50, y: 35 });
    // Cross product of the two image basis vectors must be positive, i.e. the
    // handedness of the world is preserved.
    const cross = (dx.x - o.x) * (dy.y - o.y) - (dx.y - o.y) * (dy.x - o.x);
    assert.ok(cross > 0, `${w}x${h}: mapping flips handedness`);
  }
});

test('joystick direction maps back to the world consistently', () => {
  for (const [w, h] of [[430, 932], [932, 430]]) {
    const L = computeLayout(w, h, 1);
    for (const d of [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 0, y: -1 }]) {
      const world = L.screenDirToWorld(d);
      // Pushing the stick in direction d must move the player's on-screen
      // position in direction d.
      const a = L.worldToScreen({ x: 50, y: 34 });
      const b = L.worldToScreen({ x: 50 + world.x, y: 34 + world.y });
      assert.ok(close(Math.sign(Math.round(b.x - a.x)), Math.sign(d.x)) , `${w}x${h}: x axis inverted for ${JSON.stringify(d)}`);
      assert.ok(close(Math.sign(Math.round(b.y - a.y)), Math.sign(d.y)), `${w}x${h}: y axis inverted for ${JSON.stringify(d)}`);
    }
  }
});
