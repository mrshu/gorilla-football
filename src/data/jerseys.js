// Jersey palettes. `primary` fills the body, `secondary` is used for the
// number/trim so that two similar primaries still differ visually.

export const JERSEYS = [
  { id: 'red', name: 'Red', primary: '#e53935', secondary: '#ffffff' },
  { id: 'blue', name: 'Blue', primary: '#1e88e5', secondary: '#ffffff' },
  { id: 'yellow', name: 'Yellow', primary: '#fdd835', secondary: '#1a1a1a' },
  { id: 'green', name: 'Green', primary: '#43a047', secondary: '#ffffff' },
  { id: 'white', name: 'White', primary: '#f5f5f5', secondary: '#1a1a1a' },
  { id: 'black', name: 'Black', primary: '#212121', secondary: '#ffd54f' },
  { id: 'orange', name: 'Orange', primary: '#fb8c00', secondary: '#1a1a1a' },
  { id: 'purple', name: 'Purple', primary: '#8e24aa', secondary: '#ffffff' },
  { id: 'teal', name: 'Teal', primary: '#00897b', secondary: '#ffffff' },
  { id: 'pink', name: 'Pink', primary: '#ec407a', secondary: '#ffffff' },
];

export const JERSEYS_BY_ID = Object.fromEntries(JERSEYS.map((j) => [j.id, j]));

// Goalkeepers always wear a fixed contrasting kit so they stand out.
export const GK_JERSEY = { id: 'gk', name: 'Keeper', primary: '#9e9e9e', secondary: '#111111' };

export function getJersey(id) {
  return JERSEYS_BY_ID[id] || JERSEYS[0];
}

// Rough perceptual distance so the setup screen can reject near-identical kits.
export function jerseyDistance(a, b) {
  const pa = hexToRgb(a.primary);
  const pb = hexToRgb(b.primary);
  return Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]);
}

export function jerseysDistinct(a, b) {
  return a.id !== b.id && jerseyDistance(a, b) > 90;
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
