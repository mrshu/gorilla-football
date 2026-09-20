// Team presets: a name and an 11-player roster of character ids
// (slot 0 = goalkeeper). Rosters may repeat character types.

export const TEAM_PRESETS = [
  {
    id: 'jungle',
    name: 'Jungle FC',
    // Not green: a green kit disappears into the grass in the stadium view.
    defaultJersey: 'orange',
    roster: ['tortoise', 'yeti', 'tortoise', 'gorilla', 'yeti', 'plumber', 'rocket', 'gorilla', 'penguin', 'gorilla', 'plumber'],
  },
  {
    id: 'pipeworks',
    name: 'Pipeworks United',
    defaultJersey: 'red',
    roster: ['yeti', 'tortoise', 'yeti', 'tortoise', 'plumber', 'plumber', 'rocket', 'wizard', 'penguin', 'plumber', 'rocket'],
  },
  {
    id: 'arcane',
    name: 'Arcane Athletic',
    defaultJersey: 'purple',
    roster: ['tortoise', 'tortoise', 'yeti', 'tortoise', 'rocket', 'wizard', 'rocket', 'wizard', 'rocket', 'wizard', 'penguin'],
  },
  {
    id: 'glacier',
    name: 'Glacier Rovers',
    defaultJersey: 'white',
    roster: ['gorilla', 'yeti', 'yeti', 'tortoise', 'yeti', 'penguin', 'rocket', 'yeti', 'penguin', 'yeti', 'gorilla'],
  },
  {
    id: 'speedsters',
    name: 'Speedster City',
    defaultJersey: 'yellow',
    roster: ['tortoise', 'plumber', 'yeti', 'tortoise', 'plumber', 'penguin', 'rocket', 'plumber', 'penguin', 'penguin', 'plumber'],
  },
];

export const TEAM_PRESETS_BY_ID = Object.fromEntries(TEAM_PRESETS.map((t) => [t.id, t]));

export function getTeamPreset(id) {
  const t = TEAM_PRESETS_BY_ID[id];
  if (!t) throw new Error(`Unknown team preset: ${id}`);
  return t;
}
