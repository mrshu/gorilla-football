// Preserve the existing artwork/alpha while resizing to the
// maximum useful in-match resolution. Build-time only; requires macOS sips.
// Run: node scripts/build-player-sprites.mjs
import { mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CHARACTERS } from '../src/data/characters.js';

const root = fileURLToPath(new URL('../', import.meta.url));
mkdirSync(`${root}public/assets/players`, { recursive: true });
for (const shape of new Set(CHARACTERS.map((character) => character.look.shape))) {
  for (const pose of ['idle', 'run']) {
    const suffix = pose === 'idle' ? '' : '-run';
    const input = `${root}public/assets/player-sprite-${shape}${suffix}.png`;
    const output = `${root}public/assets/players/${shape}-${pose}.png`;
    const result = spawnSync('sips', ['-z', '576', '384', input, '--out', output], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.error?.message || result.stderr || 'sips failed');
  }
}
console.log('Built 384 × 576 player sprites from the original transparent artwork.');
