import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeDecisionLayout } from '../src/ui/decision-layout.js';

const sizes = [[320, 568], [390, 844], [430, 932], [844, 390], [932, 430], [1024, 768]];

test('decision choices reserve a separate area from the pitch and HUD', () => {
  for (const [w, h] of sizes) {
    for (const flip of [false, true]) {
      for (const count of [1, 5, 6, 12]) {
        const { panel, pitchArea, hud, columns } = computeDecisionLayout(w, h, count, { flip });
        assert.equal(panel.w, w);
        assert.ok(panel.y >= 0 && panel.y + panel.h <= h);
        assert.ok(pitchArea.h >= (h - hud.h) * 0.5);
        assert.ok(columns >= 1 && columns <= count);
        assert.equal(pitchArea.y, hud.y + hud.h);
        if (flip) {
          assert.equal(panel.y, 0);
          assert.equal(panel.y + panel.h, hud.y);
          assert.equal(pitchArea.y + pitchArea.h, h);
        } else {
          assert.equal(hud.y, 0);
          assert.equal(pitchArea.y + pitchArea.h, panel.y);
          assert.equal(panel.y + panel.h, h);
        }
      }
    }
  }
});

test('landscape fits six decisions in one row while portrait keeps thumb-sized columns', () => {
  assert.equal(computeDecisionLayout(844, 390, 6).columns, 6);
  assert.equal(computeDecisionLayout(390, 844, 6).columns, 2);
  assert.equal(computeDecisionLayout(320, 568, 6).columns, 2);
});
