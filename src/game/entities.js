// Construction of the mutable simulation entities (teams, players, ball).

import { PITCH, ROLES } from './constants.js';
import { getCharacter } from '../data/characters.js';
import { FORMATIONS } from '../data/formations.js';
import { GK_JERSEY } from '../data/jerseys.js';
import { getAbility } from './abilities.js';

// Map a 1..10 stat to physical quantities.
export function derivePhysical(stats) {
  return {
    maxSpeed: 5.2 + stats.speed * 0.55, // 5.75 .. 10.7 m/s
    accel: 9 + stats.acceleration * 2.2, // 11 .. 31 m/s^2
    shotSpeed: 17 + stats.shotPower * 2.0, // 19 .. 37 m/s
    shotSpread: 0.26 - stats.shotAccuracy * 0.022, // radians std-dev: 0.24 .. 0.04
    passSpeedBonus: stats.passing * 0.5,
    passSpread: 0.16 - stats.passing * 0.013,
    staminaDrain: 0.075 - stats.stamina * 0.0055, // per second at full sprint
    mass: 60 + stats.strength * 6,
  };
}

export function createTeam(index, teamCfg, attackDir) {
  const formation = FORMATIONS[teamCfg.formationId];
  return {
    index,
    name: teamCfg.name,
    jersey: teamCfg.jersey,
    attackDir,
    formation,
    players: [],
    score: 0,
    // Team-level mutable AI state
    ai: { pressers: [] },
  };
}

export function createPlayer(team, slotIndex, characterId, id) {
  const character = getCharacter(characterId);
  const slot = team.formation.slots[slotIndex];
  const ability = getAbility(character.abilityId);
  return {
    id,
    team: team.index,
    slot: slotIndex,
    role: slot.role,
    isGK: slot.role === ROLES.GK,
    character,
    stats: { ...character.stats },
    phys: derivePhysical(character.stats),
    jersey: slot.role === ROLES.GK ? GK_JERSEY : team.jersey,
    number: slotIndex + 1,
    pos: { x: 0, y: 0 },
    vel: { x: 0, y: 0 },
    facing: { x: team.attackDir, y: 0 },
    stamina: 1,
    human: null, // human index or null
    // transient state
    kickCooldown: 0,
    tackleCooldown: 0,
    stun: 0,
    frozen: 0,
    sliding: 0,
    slideDir: null,
    untackleable: 0,
    speedBoost: 0,
    magnet: 0,
    offsideFlag: false,
    offsidePos: null,
    yellowCards: 0,
    sentOff: false,
    holdingBall: 0, // GK hand-hold timer
    protect: 0, // grace period after a clean first touch during which tackles fail
    reactTimer: 0, // goalkeeper reaction delay to a shot
    ability: {
      id: ability.id,
      usesLeft: ability.maxUses ?? Infinity,
      cooldown: 0,
    },
    ai: { state: 'idle', target: null, timer: 0, decisionTimer: 0 },
    // AI-scheduled actions (set-piece kicks etc.)
    pendingKick: null,
  };
}

export function createBall() {
  return {
    pos: { x: PITCH.length / 2, y: PITCH.width / 2 },
    vel: { x: 0, y: 0 },
    z: 0,
    vz: 0,
    owner: null, // player id or null
    lastTouch: null, // player id
    lastTouchTeam: null,
    // Special-ability behaviour
    homing: null, // { target:{x,y} | playerId, speed, unstoppable, assistFor }
    unstoppable: false,
  };
}

// World position of a formation slot for the given team, optionally
// shifted by a team-relative offset (used by AI for ball-side shifting).
export function slotWorldPos(team, slotIndex) {
  const s = team.formation.slots[slotIndex];
  return relToWorld(team, s.x, s.y);
}

export function relToWorld(team, rx, ry) {
  const x = team.attackDir > 0 ? rx * PITCH.length : (1 - rx) * PITCH.length;
  return { x, y: ry * PITCH.width };
}

export function goalCenter(attackDir) {
  return { x: attackDir > 0 ? PITCH.length : 0, y: PITCH.width / 2 };
}

export function ownGoalCenter(team) {
  return goalCenter(-team.attackDir);
}
