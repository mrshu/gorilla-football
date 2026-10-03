import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mathsTokenLabel, triangleGeometry, rightTriangleGeometry } from '../src/ui/maths-quiz.js';

test('maths token descriptions retain fractions, powers, unknowns and geometry dimensions', () => {
  assert.equal(mathsTokenLabel({ t: 'frac', n: 3, d: 4 }), '3 over 4');
  assert.equal(mathsTokenLabel({ t: 'pow', v: 2, e: '□' }), '2 to the power of unknown');
  assert.equal(mathsTokenLabel({ t: 'balls', v: 5 }), '5 footballs');
  assert.equal(mathsTokenLabel({ t: 'pct', v: 25 }), '25 percent');
  assert.equal(mathsTokenLabel({ t: 'diag', kind: 'areaComp', W: 12, H: 8, w: 4, h: 3 }),
    'Find the area of a 12 by 8 rectangle with a 4 by 3 corner removed');
  assert.match(mathsTokenLabel({ t: 'diag', kind: 'angleLine', known: 35 }), /35 degrees/);
  assert.match(mathsTokenLabel({ t: 'diag', kind: 'angleTri', a: 60, b: 50 }), /60 degrees, 50 degrees/);
  assert.match(mathsTokenLabel({ t: 'diag', kind: 'pythag', legA: 5, legB: 12 }), /legs 5 and 12/);
});

test('ported triangles preserve actual angles and keep labels inside their canvas', () => {
  for (const [a, b] of [[60, 60], [45, 45], [100, 35], [35, 100]]) {
    const g = triangleGeometry(a, b, (text) => text.length * 8);
    const [left, right, apex] = g.pts;
    const baseAngle = Math.atan2(left.y - apex.y, apex.x - left.x) * 180 / Math.PI;
    assert.ok(Math.abs(baseAngle - a) < 1e-8);
    assert.equal(left.y, right.y);
    for (const label of g.labels) {
      assert.ok(label.x - label.w / 2 >= 0 && label.x + label.w / 2 <= g.W);
      assert.ok(label.y - 7 >= 0 && label.y + 7 <= g.H);
    }
  }
});

test('right-triangle diagrams preserve unequal leg proportions', () => {
  for (const [legA, legB] of [[3, 4], [7, 24], [24, 7]]) {
    const g = rightTriangleGeometry(legA, legB);
    assert.ok(Math.abs((g.x1 - g.x0) / (g.y0 - g.y1) - legA / legB) < 1e-8);
  }
});
