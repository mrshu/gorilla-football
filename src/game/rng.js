// Deterministic seeded PRNG (mulberry32). Used everywhere the simulation
// needs randomness so that tests and replays are reproducible.

export function createRng(seed = 123456789) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    range: (lo, hi) => lo + (hi - lo) * next(),
    chance: (p) => next() < p,
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    gaussian: () => {
      // Box-Muller, clamped to avoid rare extreme outliers.
      const u = Math.max(next(), 1e-9);
      const w = next();
      const g = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * w);
      return Math.max(-3, Math.min(3, g));
    },
  };
}
