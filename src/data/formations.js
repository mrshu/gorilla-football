// Formation slots in team-relative coordinates: x in [0,1] runs from the
// team's own goal line (0) to the opponent's goal line (1); y in [0,1]
// runs across the pitch. Slot 0 is always the goalkeeper.

export const FORMATIONS = {
  '4-4-2': {
    id: '4-4-2',
    name: '4-4-2',
    slots: [
      { role: 'GK', x: 0.04, y: 0.5 },
      { role: 'DF', x: 0.2, y: 0.15 },
      { role: 'DF', x: 0.17, y: 0.38 },
      { role: 'DF', x: 0.17, y: 0.62 },
      { role: 'DF', x: 0.2, y: 0.85 },
      { role: 'MF', x: 0.42, y: 0.12 },
      { role: 'MF', x: 0.38, y: 0.38 },
      { role: 'MF', x: 0.38, y: 0.62 },
      { role: 'MF', x: 0.42, y: 0.88 },
      { role: 'FW', x: 0.6, y: 0.4 },
      { role: 'FW', x: 0.6, y: 0.6 },
    ],
  },
};

export const DEFAULT_FORMATION = '4-4-2';

// Default human slots: first human takes the left striker, second human
// (co-op) takes the right striker.
export const HUMAN_SLOTS = [9, 10];
