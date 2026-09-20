// Headless AI-vs-AI simulation for balance checks:
//   node scripts/simulate.js [matches] [minutes] [seed]
import { Match } from '../src/game/match.js';
import { normalizeConfig } from '../src/game/config.js';
import { PHYSICS } from '../src/game/constants.js';

const matches = Number(process.argv[2] || 3);
const minutes = Number(process.argv[3] || 5);
const seed0 = Number(process.argv[4] || 42);

for (let i = 0; i < matches; i++) {
  const cfg = normalizeConfig({ mode: 'solo', durationMinutes: minutes, seed: seed0 + i, humans: [{ characterId: 'plumber' }] });
  const m = new Match(cfg);
  // The human slot gets no input, so it behaves as an idle player; hand it to the AI for the sim.
  for (const p of m.players) p.human = null;
  const counts = {};
  let steps = 0;
  const t0 = Date.now();
  while (!m.isFinished() && steps < 60 * 60 * 60) {
    m.step(PHYSICS.dt);
    steps++;
    if (m.state === 'HALFTIME') m.resumeSecondHalf();
    for (const e of m.drainEvents()) counts[e.type] = (counts[e.type] || 0) + 1;
  }
  const ms = Date.now() - t0;
  console.log(`match ${i + 1}: ${m.teams[0].name} ${m.teams[0].score} - ${m.teams[1].score} ${m.teams[1].name} | state=${m.state} steps=${steps} (${ms} ms)`);
  console.log('  events:', JSON.stringify(counts));
  console.log('  stats:', JSON.stringify(m.stats), 'cards:', m.cards.length);
}
