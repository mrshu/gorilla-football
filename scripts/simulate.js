// Representative balance checks, including a whole-team player giving no input:
//   node scripts/simulate.js [matches] [minutes] [seed] [both|ai|idle] [--check]
import { pathToFileURL } from 'node:url';
import { Match } from '../src/game/match.js';
import { normalizeConfig } from '../src/game/config.js';
import { PHYSICS, STATES } from '../src/game/constants.js';

export function simulateMatch({ minutes = 5, seed = 42, mode = 'ai' } = {}) {
  if (!['ai', 'idle'].includes(mode)) throw new Error('Simulation mode must be ai or idle');
  const cfg = normalizeConfig({ control: mode === 'ai' ? 'manual' : 'aim', durationMinutes: minutes, seed, humans: [{ characterId: 'plumber' }] });
  // Aim control is team-level: clearing player.human alone still leaves
  // carriers waiting for input. Remove the configured humans for true AI.
  if (mode === 'ai') cfg.humans = [];
  const m = new Match(cfg);
  const counts = {};
  const metrics = { earlyFouls: 0, carriedGoals: [0, 0], noShotGoals: [0, 0], ownGoals: [0, 0], claims: 0 };
  let sinceKickoff = 0;
  let steps = 0;
  while (!m.isFinished() && steps < 60 * 60 * 60) {
    const ownedBefore = m.ball.owner !== null;
    if (m.state === STATES.PLAY) sinceKickoff += PHYSICS.dt;
    m.step(PHYSICS.dt);
    steps++;
    for (const e of m.drainEvents()) {
      counts[e.type] = (counts[e.type] || 0) + 1;
      if (e.type === 'kickoff') sinceKickoff = 0;
      if (e.type === 'foul' && sinceKickoff < 5) metrics.earlyFouls++;
      if (e.type === 'claim') metrics.claims++;
      if (e.type === 'goal') {
        if (e.ownGoal) metrics.ownGoals[e.team]++;
        if (ownedBefore) metrics.carriedGoals[e.team]++;
        if (m.stats.shots[e.team] === 0) metrics.noShotGoals[e.team]++;
      }
    }
    if (m.state === STATES.HALFTIME) m.resumeSecondHalf();
  }
  return {
    mode, seed, finished: m.isFinished(), steps,
    scores: m.teams.map((t) => t.score), stats: m.stats, cards: m.cards.length, counts, metrics,
  };
}

function main() {
  const matches = Number(process.argv[2] || 3);
  const minutes = Number(process.argv[3] || 5);
  const seed0 = Number(process.argv[4] || 42);
  const mode = process.argv[5]?.startsWith('--') ? 'both' : process.argv[5] || 'both';
  const check = process.argv.includes('--check');
  if (!Number.isInteger(matches) || matches < 1 || !Number.isFinite(seed0) || !['both', 'ai', 'idle'].includes(mode)) {
    throw new Error('Usage: node scripts/simulate.js [positive matches] [minutes] [seed] [both|ai|idle] [--check]');
  }
  for (const scenario of mode === 'both' ? ['ai', 'idle'] : [mode]) {
    let earlyFouls = 0;
    let idleCarriedGoals = 0;
    let allFinished = true;
    for (let i = 0; i < matches; i++) {
      const result = simulateMatch({ minutes, seed: seed0 + i, mode: scenario });
      earlyFouls += result.metrics.earlyFouls;
      idleCarriedGoals += result.metrics.carriedGoals[0];
      allFinished &&= result.finished;
      console.log(`${scenario} seed ${result.seed}: ${result.scores.join(' - ')} | finished=${result.finished} steps=${result.steps}`);
      console.log('  stats:', JSON.stringify(result.stats), 'cards:', result.cards);
      console.log('  balance:', JSON.stringify(result.metrics));
    }
    console.log(`${scenario}: ${earlyFouls} fouls in the first 5 playing seconds after kickoff across ${matches} matches`);
    // These broad checks flag recurring problems without forbidding legal
    // dribble goals or treating a single opening foul as a broken rule.
    if (check && (!allFinished || earlyFouls > matches || (scenario === 'idle' && idleCarriedGoals > Math.floor(matches / 5)))) {
      throw new Error(`${scenario} balance check failed: finished=${allFinished}, early fouls=${earlyFouls}, idle carried goals=${idleCarriedGoals}`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
