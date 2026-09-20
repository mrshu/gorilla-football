import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadThree } from '../src/ui/three-loader.js';

// The game has to keep working with no network: the loader must resolve to
// null rather than throw or hang, so the caller falls back to the canvas
// renderer. There is no document here, which is exactly that case.
test('the three.js loader resolves to null when it cannot load', async () => {
  const result = await loadThree({ url: 'https://example.invalid/three.js', timeout: 50 });
  assert.equal(result, null);
});

test('the loader is safe to call repeatedly', async () => {
  const a = await loadThree({ timeout: 50 });
  const b = await loadThree({ timeout: 50 });
  assert.equal(a, b);
});
