// Original placeholder character roster.
//
// Every character is pure data: stats on a 1..10 scale, an ability id that
// is resolved through the ability registry (src/game/abilities.js), and a
// `look` block consumed only by the renderer. To ship licensed characters
// later, replace or extend this list (or load it from JSON) — nothing in
// the simulation references a character by name.
//
// Stats are deliberately spread wide so characters feel different:
//   speed        top running speed
//   acceleration how quickly they reach top speed / change direction
//   strength     shielding the ball, winning shoulder-to-shoulder duels
//   shotPower    ball speed when shooting
//   shotAccuracy how tightly shots group around the aim point
//   passing      pass speed/accuracy and interception resistance
//   tackling     chance of winning a tackle cleanly (less fouling)
//   stamina      how slowly they tire over a match

export const CHARACTERS = [
  {
    id: 'gorilla',
    name: 'Gorilla',
    tagline: 'Slow, immensely strong, cannon shot. Special: guaranteed goal (10 per match).',
    stats: { speed: 3, acceleration: 3, strength: 10, shotPower: 10, shotAccuracy: 6, passing: 4, tackling: 7, stamina: 8 },
    abilityId: 'gorilla_slam',
    look: { shape: 'gorilla', skin: '#5a3a1e', accent: '#c58a4b', size: 1.35 },
  },
  {
    id: 'plumber',
    name: 'Plumber',
    tagline: 'Fast and agile all-rounder. Special: Turbo Hop — burst of speed, immune to tackles.',
    stats: { speed: 8, acceleration: 8, strength: 5, shotPower: 6, shotAccuracy: 7, passing: 7, tackling: 5, stamina: 7 },
    abilityId: 'turbo_hop',
    look: { shape: 'plumber', skin: '#f0c090', accent: '#d62828', size: 1.0 },
  },
  {
    id: 'tortoise',
    name: 'Tortoise',
    tagline: 'A wall in defence. Special: Shell Slam — stuns every opponent nearby.',
    stats: { speed: 2, acceleration: 2, strength: 9, shotPower: 5, shotAccuracy: 4, passing: 5, tackling: 10, stamina: 9 },
    abilityId: 'shell_slam',
    look: { shape: 'tortoise', skin: '#2e7d32', accent: '#8d6e63', size: 1.25 },
  },
  {
    id: 'rocket',
    name: 'Rocket',
    tagline: 'Precision passer and playmaker. Special: Magnet Boots — loose balls fly to its feet.',
    stats: { speed: 6, acceleration: 7, strength: 3, shotPower: 5, shotAccuracy: 8, passing: 10, tackling: 4, stamina: 6 },
    abilityId: 'magnet_boots',
    look: { shape: 'rocket', skin: '#b0bec5', accent: '#ff7043', size: 0.95 },
  },
  {
    id: 'wizard',
    name: 'Wizard',
    tagline: 'Frail but deadly accurate. Special: Blink — teleports 12 m forward with the ball.',
    stats: { speed: 5, acceleration: 6, strength: 2, shotPower: 7, shotAccuracy: 10, passing: 8, tackling: 2, stamina: 5 },
    abilityId: 'blink',
    look: { shape: 'wizard', skin: '#e0d0ff', accent: '#5e35b1', size: 1.0 },
  },
  {
    id: 'yeti',
    name: 'Yeti',
    tagline: 'Big, tough, tireless. Special: Cold Snap — freezes nearby opponents in place.',
    stats: { speed: 4, acceleration: 4, strength: 8, shotPower: 8, shotAccuracy: 5, passing: 5, tackling: 8, stamina: 10 },
    abilityId: 'cold_snap',
    look: { shape: 'yeti', skin: '#eef3f7', accent: '#4fc3f7', size: 1.3 },
  },
  {
    id: 'penguin',
    name: 'Penguin',
    tagline: 'Sprinter with an endless slide. Special: Belly Slide — long slide that always wins the ball.',
    stats: { speed: 9, acceleration: 6, strength: 4, shotPower: 4, shotAccuracy: 6, passing: 6, tackling: 6, stamina: 4 },
    abilityId: 'belly_slide',
    look: { shape: 'penguin', skin: '#212121', accent: '#ffb300', size: 0.9 },
  },
];

export const CHARACTERS_BY_ID = Object.fromEntries(CHARACTERS.map((c) => [c.id, c]));

export const STAT_KEYS = ['speed', 'acceleration', 'strength', 'shotPower', 'shotAccuracy', 'passing', 'tackling', 'stamina'];

export function getCharacter(id) {
  const c = CHARACTERS_BY_ID[id];
  if (!c) throw new Error(`Unknown character id: ${id}`);
  return c;
}
