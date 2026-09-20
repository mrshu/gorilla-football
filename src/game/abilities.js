// Special-ability registry. Each ability is a plain object:
//   id, name, description, maxUses (or undefined => unlimited), cooldown (s),
//   needsBall (bool), canActivate(match, player) => bool,
//   activate(match, player) => void
// Abilities receive the Match instance and act through its public helpers
// so they can be swapped without touching the simulation core.

import { PITCH } from './constants.js';
import { add, dist, norm, scale, sub, clamp } from './vec.js';

const registry = new Map();

export function registerAbility(ability) {
  registry.set(ability.id, ability);
}

export function getAbility(id) {
  const a = registry.get(id);
  if (!a) throw new Error(`Unknown ability: ${id}`);
  return a;
}

export function listAbilities() {
  return [...registry.values()];
}

// ---------------------------------------------------------------------------
// Gorilla — guaranteed scoring action.
// If the Gorilla holds the ball within striking range it fires an
// unstoppable homing shot into the goal. Otherwise it plays an unstoppable
// homing assist to the most advanced teammate, who is then compelled to
// finish with an unstoppable shot on receipt. Ten uses per match.
// ---------------------------------------------------------------------------
registerAbility({
  id: 'gorilla_slam',
  name: 'Jungle Thunder',
  short: 'GOAL',
  description: 'Guaranteed goal: an unstoppable shot, or an unstoppable assist a teammate must finish. 10 uses.',
  maxUses: 10,
  cooldown: 4,
  needsBall: true,
  canActivate(match, player) {
    return match.ball.owner === player.id && match.isPlayActive();
  },
  activate(match, player) {
    const goal = match.goalTargetFor(player);
    const d = dist(player.pos, goal);
    if (d <= 45) {
      match.launchHoming(player, { point: goal, speed: 38, unstoppable: true, kind: 'shot' });
      match.emit('special', { playerId: player.id, text: 'JUNGLE THUNDER!' });
      return;
    }
    const mates = match.teammatesOf(player).filter((p) => !p.isGK && !p.sentOff);
    if (mates.length === 0) {
      match.launchHoming(player, { point: goal, speed: 38, unstoppable: true, kind: 'shot' });
      return;
    }
    // Most advanced teammate.
    const team = match.teams[player.team];
    mates.sort((a, b) => (b.pos.x - a.pos.x) * team.attackDir);
    const receiver = mates[0];
    match.launchHoming(player, { playerId: receiver.id, speed: 34, unstoppable: true, kind: 'pass', assistFinish: true });
    match.emit('special', { playerId: player.id, text: 'THUNDER ASSIST!' });
  },
});

// Plumber — Turbo Hop: 3 s of speed and tackle immunity.
registerAbility({
  id: 'turbo_hop',
  name: 'Turbo Hop',
  short: 'HOP',
  description: 'Burst of speed for 3 s during which you cannot be tackled.',
  cooldown: 14,
  needsBall: false,
  canActivate(match) {
    return match.isPlayActive();
  },
  activate(match, player) {
    player.speedBoost = 3;
    player.untackleable = 3;
    match.emit('special', { playerId: player.id, text: 'TURBO HOP!' });
  },
});

// Tortoise — Shell Slam: stun every opponent within 8 m for 2 s, knocking the ball loose.
registerAbility({
  id: 'shell_slam',
  name: 'Shell Slam',
  short: 'SLAM',
  description: 'Stuns all opponents within 8 m for 2 s and knocks the ball loose.',
  cooldown: 16,
  needsBall: false,
  canActivate(match) {
    return match.isPlayActive();
  },
  activate(match, player) {
    let hit = 0;
    for (const opp of match.opponentsOf(player)) {
      if (opp.sentOff || dist(opp.pos, player.pos) > 8) continue;
      opp.stun = Math.max(opp.stun, 2);
      hit++;
      if (match.ball.owner === opp.id) {
        match.releaseBall();
        const dir = norm(sub(opp.pos, player.pos));
        match.ball.vel = scale(dir, 6);
      }
      // Knock-back
      const push = norm(sub(opp.pos, player.pos));
      opp.vel = add(opp.vel, scale(push, 7));
    }
    match.emit('special', { playerId: player.id, text: hit ? `SHELL SLAM x${hit}!` : 'SHELL SLAM!' });
  },
});

// Rocket — Magnet Boots: for 4 s any loose ball within 9 m is pulled to the player.
registerAbility({
  id: 'magnet_boots',
  name: 'Magnet Boots',
  short: 'MAGNET',
  description: 'For 4 s a loose ball within 9 m is pulled to your feet.',
  cooldown: 12,
  needsBall: false,
  canActivate(match) {
    return match.isPlayActive();
  },
  activate(match, player) {
    player.magnet = 4;
    match.emit('special', { playerId: player.id, text: 'MAGNET BOOTS!' });
  },
});

// Wizard — Blink: teleport 12 m towards the opponents' goal (with the ball if held).
registerAbility({
  id: 'blink',
  name: 'Blink',
  short: 'BLINK',
  description: 'Teleport 12 m towards goal, carrying the ball if you have it.',
  cooldown: 10,
  needsBall: false,
  canActivate(match) {
    return match.isPlayActive();
  },
  activate(match, player) {
    const team = match.teams[player.team];
    const dir = norm(add(player.facing, { x: team.attackDir * 0.6, y: 0 }));
    const target = add(player.pos, scale(dir, 12));
    target.x = clamp(target.x, 1, PITCH.length - 1);
    target.y = clamp(target.y, 1, PITCH.width - 1);
    player.pos = target;
    if (match.ball.owner === player.id) match.snapBallToOwner(player);
    match.emit('special', { playerId: player.id, text: 'BLINK!' });
  },
});

// Yeti — Cold Snap: freeze opponents within 10 m for 2.5 s.
registerAbility({
  id: 'cold_snap',
  name: 'Cold Snap',
  short: 'FREEZE',
  description: 'Freezes every opponent within 10 m for 2.5 s.',
  cooldown: 18,
  needsBall: false,
  canActivate(match) {
    return match.isPlayActive();
  },
  activate(match, player) {
    let hit = 0;
    for (const opp of match.opponentsOf(player)) {
      if (opp.sentOff || dist(opp.pos, player.pos) > 10) continue;
      opp.frozen = Math.max(opp.frozen, 2.5);
      opp.vel = { x: 0, y: 0 };
      hit++;
    }
    match.emit('special', { playerId: player.id, text: hit ? `COLD SNAP x${hit}!` : 'COLD SNAP!' });
  },
});

// Penguin — Belly Slide: a 2 s slide at high speed that wins the ball on contact without fouling.
registerAbility({
  id: 'belly_slide',
  name: 'Belly Slide',
  short: 'SLIDE',
  description: 'Slide 2 s at high speed; wins the ball on contact, never a foul.',
  cooldown: 9,
  needsBall: false,
  canActivate(match, player) {
    return match.isPlayActive() && match.ball.owner !== player.id;
  },
  activate(match, player) {
    const dir = player.facing.x || player.facing.y ? norm(player.facing) : { x: match.teams[player.team].attackDir, y: 0 };
    player.sliding = 2;
    player.slideDir = dir;
    player.slideWinsBall = true;
    match.emit('special', { playerId: player.id, text: 'BELLY SLIDE!' });
  },
});
