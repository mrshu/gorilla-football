// Match configuration: normalisation and validation of what the pre-match
// screen produces before it is handed to the simulation.

import { TEAM_PRESETS, getTeamPreset } from '../data/teams.js';
import { getCharacter } from '../data/characters.js';
import { getJersey, jerseysDistinct, JERSEYS } from '../data/jerseys.js';
import { HUMAN_SLOTS, DEFAULT_FORMATION } from '../data/formations.js';

export const MODES = Object.freeze({
  SOLO: 'solo', // 1 human vs AI
  VERSUS: 'versus', // 2 humans, opposite teams
  COOP: 'coop', // 2 humans, same team vs AI
});

export const MODE_INFO = [
  { id: MODES.SOLO, name: '1 Player vs AI', humans: 1 },
  { id: MODES.VERSUS, name: '2 Players: Versus', humans: 2 },
  { id: MODES.COOP, name: '2 Players: Co-op vs AI', humans: 2 },
];

export const DURATION_OPTIONS = [1, 2, 3, 5, 8, 10, 15];
export const DEFAULT_DURATION_MINUTES = 5;

// How a human plays.
//   AIM:      you run the whole team. Everyone moves themselves; you hold,
//             aim and release to play the ball, with a special ability button.
//   MANUAL:   you drive one player with a joystick and three buttons.
//   ASSISTED: one player is AI-driven and the match freezes to ask what to do.
export const CONTROL = Object.freeze({ AIM: 'aim', MANUAL: 'manual', ASSISTED: 'assisted' });

export const CONTROL_INFO = [
  { id: CONTROL.AIM, name: 'Whole team', detail: 'Hold anywhere to aim, release to play the ball. Your players run themselves.' },
  { id: CONTROL.MANUAL, name: 'One player', detail: 'You drive a single player with the joystick and three buttons.' },
  { id: CONTROL.ASSISTED, name: 'One player, paced', detail: 'One player runs themselves and the match pauses to ask what to do.' },
];

const CONTROL_IDS = new Set(Object.values(CONTROL));

// Where the stadium camera sits in whole-team play.
export const VIEW = Object.freeze({ BROADCAST: 'broadcast', FIRST: 'first' });

export const VIEW_INFO = [
  { id: VIEW.BROADCAST, name: 'Side view', detail: 'A raised camera in the side stand, the way football is televised.' },
  { id: VIEW.FIRST, name: 'First person', detail: 'You look out from the player you are playing through.' },
];

const VIEW_IDS = new Set(Object.values(VIEW));

export function humanCount(mode) {
  return mode === MODES.SOLO ? 1 : 2;
}

// Human i plays on team 0 except human 2 in versus mode.
export function humanTeamIndex(mode, humanIndex) {
  if (mode === MODES.VERSUS && humanIndex === 1) return 1;
  return 0;
}

export function defaultConfig() {
  return {
    mode: MODES.SOLO,
    durationMinutes: DEFAULT_DURATION_MINUTES,
    seed: (Date.now() % 2147483647) | 0,
    control: CONTROL.AIM,
    view: VIEW.BROADCAST,
    aiUsesSpecials: false,
    teams: [
      { presetId: TEAM_PRESETS[0].id, jerseyId: TEAM_PRESETS[0].defaultJersey },
      { presetId: TEAM_PRESETS[1].id, jerseyId: TEAM_PRESETS[1].defaultJersey },
    ],
    humans: [
      { characterId: 'gorilla' },
      { characterId: 'plumber' },
    ],
  };
}

// Returns a fully-resolved config object or throws a descriptive Error.
export function normalizeConfig(input) {
  const cfg = { ...defaultConfig(), ...input };
  if (!Object.values(MODES).includes(cfg.mode)) throw new Error(`Invalid mode: ${cfg.mode}`);
  const minutes = Number(cfg.durationMinutes);
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 90) throw new Error('Match duration must be between 0 and 90 minutes');
  if (!Array.isArray(cfg.teams) || cfg.teams.length !== 2) throw new Error('Exactly two teams required');
  const control = CONTROL_IDS.has(cfg.control) ? cfg.control : CONTROL.AIM;
  const view = VIEW_IDS.has(cfg.view) ? cfg.view : VIEW.BROADCAST;

  const teams = cfg.teams.map((t, i) => {
    const preset = getTeamPreset(t.presetId);
    const jersey = getJersey(t.jerseyId);
    const roster = (t.roster || preset.roster).slice();
    if (roster.length !== 11) throw new Error(`Team ${i} must have exactly 11 players`);
    roster.forEach(getCharacter);
    return { presetId: preset.id, name: t.name || preset.name, jersey, roster, formationId: t.formationId || DEFAULT_FORMATION };
  });

  if (!jerseysDistinct(teams[0].jersey, teams[1].jersey)) {
    // Auto-resolve: pick the first jersey distinct from team 0's.
    const alt = JERSEYS.find((j) => jerseysDistinct(teams[0].jersey, j));
    teams[1] = { ...teams[1], jersey: alt };
  }

  const n = humanCount(cfg.mode);
  const humans = [];
  for (let i = 0; i < n; i++) {
    const h = (cfg.humans && cfg.humans[i]) || {};
    const characterId = h.characterId || (i === 0 ? 'gorilla' : 'plumber');
    getCharacter(characterId);
    const team = humanTeamIndex(cfg.mode, i);
    const slot = cfg.mode === MODES.COOP ? HUMAN_SLOTS[i] : HUMAN_SLOTS[0];
    humans.push({ index: i, team, slot, characterId });
    teams[team].roster[slot] = characterId;
  }

  return {
    mode: cfg.mode,
    control,
    view,
    assist: control === CONTROL.ASSISTED,
    aimControl: control === CONTROL.AIM,
    durationMinutes: minutes,
    halfSeconds: (minutes * 60) / 2,
    seed: (cfg.seed ?? 1) | 0,
    aiUsesSpecials: Boolean(cfg.aiUsesSpecials),
    teams,
    humans,
  };
}
