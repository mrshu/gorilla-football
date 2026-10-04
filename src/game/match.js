// The Match simulation. Pure JavaScript, no DOM: drives players, ball,
// rules and match flow with a fixed time step. UI code reads state and
// drains `events`; controllers push human input via setHumanInput().

import { PITCH, PHYSICS, TIMING, STATES, SET_PIECES, ROLES, DECISION, AIM } from './constants.js';
import { add, sub, scale, norm, len, dist, clamp, dot, clampLen, lerp, fromAngle, angle, rotate } from './vec.js';
import { createRng } from './rng.js';
import { createTeam, createPlayer, createBall, slotWorldPos, relToWorld, goalCenter } from './entities.js';
import { classifyOutOfPlay, offsidePositions, offsideExemptSetPiece, resolveTackle, applyCard, foulRestart, isInPenaltyArea } from './rules.js';
import { getAbility } from './abilities.js';
import { updateOutfieldAI, chooseAiSetPieceAction, homePosition } from './ai.js';
import { updateGoalkeeper, goalkeeperDistribute } from './goalkeeper.js';
import { findOpenRun } from './dribble.js';

const HALF_W = PITCH.width / 2;

export class Match {
  constructor(config) {
    this.config = config;
    this.rng = createRng(config.seed);
    this.events = [];
    this.time = 0; // total simulated seconds (never pauses inside a match)
    this.clock = { half: 1, time: 0, halfSeconds: config.halfSeconds };
    this.state = STATES.KICKOFF;
    this.setPiece = null;
    this.goalTimer = 0;
    this.lastSetPieceKind = null;
    this.kickoffTeam = 0;
    this.offsideKicker = null;
    this.humanInputs = config.humans.map(() => ({ move: { x: 0, y: 0 }, pass: false, shoot: false, special: false }));
    // Assisted play: the AI runs the human's footballer and the match freezes
    // whenever they have a choice worth making.
    this.assist = Boolean(config.assist);
    // Whole-team control: everyone is AI-driven and the human plays the ball
    // by aiming and releasing. `aimKick` is set by the UI for one frame.
    this.aimControl = Boolean(config.aimControl);
    this.aimKicks = config.humans.map(() => null);
    // One earned precision charge per learner, retained until their next
    // normal kick. It belongs to the human, rather than the current carrier.
    this.mathsFocus = config.humans.map(() => false);
    this.presses = config.humans.map(() => false);
    this.dribbles = config.humans.map(() => false);
    this.moveOrders = config.humans.map(() => null); // { playerId, point }
    this.aimHold = null; // { playerId, since } while a human's team carries
    this.pendingDecision = null;
    this.decisionCarry = null;
    this.stats = { shots: [0, 0], fouls: [0, 0], offsides: [0, 0], saves: [0, 0], specials: [0, 0] };
    this.cards = []; // {playerId, team, card, minute}
    this.goals = []; // {team, scorerId, half, time}

    this.teams = [createTeam(0, config.teams[0], +1), createTeam(1, config.teams[1], -1)];
    this.players = [];
    let id = 0;
    for (const team of this.teams) {
      const roster = config.teams[team.index].roster;
      for (let slot = 0; slot < 11; slot++) {
        const p = createPlayer(team, slot, roster[slot], id++);
        team.players.push(p);
        this.players.push(p);
      }
    }
    for (const h of config.humans) {
      const p = this.teams[h.team].players[h.slot];
      p.human = h.index;
    }
    this.ball = createBall();
    for (const p of this.players) p.pos = slotWorldPos(this.teams[p.team], p.slot);
    this.beginSetPiece({ kind: SET_PIECES.KICKOFF, team: this.kickoffTeam, pos: { x: PITCH.length / 2, y: HALF_W } });
    // Start everyone already in their kickoff positions. A restart normally
    // interpolates players in from wherever they were, but there is no
    // "wherever they were" at the start of a match, and the first frame a
    // renderer draws should look like a kickoff rather than twenty-two
    // players piled on the corner flag.
    this.snapToSetPiece();
  }

  // ------------------------------------------------------------------ API

  emit(type, data = {}) {
    this.events.push({ ...data, type, time: this.time, clock: this.clockLabel() });
  }

  drainEvents() {
    const e = this.events;
    this.events = [];
    return e;
  }

  clockLabel() {
    const base = (this.clock.half - 1) * this.clock.halfSeconds;
    const t = Math.floor(base + Math.min(this.clock.time, this.clock.halfSeconds));
    return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
  }

  setHumanInput(index, input) {
    const h = this.humanInputs[index];
    if (!h) return;
    if (input.move) h.move = { x: clamp(input.move.x, -1, 1), y: clamp(input.move.y, -1, 1) };
    if (input.pass) h.pass = true;
    if (input.shoot) h.shoot = true;
    if (input.special) h.special = true;
  }

  humanPlayer(index) {
    return this.players.find((p) => p.human === index) || null;
  }

  // Validate the question's snapshot before banking a more accurate kick.
  grantMathsFocus(humanIndex, kickerId) {
    const human = Number.isInteger(humanIndex) ? this.config.humans[humanIndex] : null;
    const restart = [STATES.KICKOFF, STATES.SET_PIECE].includes(this.state) ? this.setPiece : null;
    if (!human || (this.state !== STATES.PLAY && (!restart || restart.lerp < 1))) return false;
    const activeId = restart ? restart.takerId : this.ball.owner;
    const player = activeId !== null ? this.getPlayer(activeId) : null;
    if (!player || player.id !== kickerId || player.team !== human.team
        || (!this.aimControl && player.human !== humanIndex) || player.sentOff
        || player.stun > 0 || player.frozen > 0 || player.kickCooldown > 0) return false;
    if (this.hasMathsFocus(humanIndex)) return false;
    this.mathsFocus[humanIndex] = true;
    return true;
  }

  hasMathsFocus(humanIndex) {
    return Number.isInteger(humanIndex) && this.mathsFocus[humanIndex] === true;
  }

  mathsAccuracyScale(player, humanIndex = this.aimControl ? null : player.human) {
    if (!this.hasMathsFocus(humanIndex) || player.sentOff
        || this.config.humans[humanIndex].team !== player.team) return 1;
    this.mathsFocus[humanIndex] = false;
    this.emit('mathsfocusused', { humanIndex, playerId: player.id });
    return 0.4;
  }

  getPlayer(id) {
    return this.players[id];
  }

  teammatesOf(player) {
    return this.teams[player.team].players.filter((p) => p.id !== player.id && !p.sentOff);
  }

  opponentsOf(player) {
    return this.teams[1 - player.team].players.filter((p) => !p.sentOff);
  }

  isPlayActive() {
    return this.state === STATES.PLAY;
  }

  isFinished() {
    return this.state === STATES.FULLTIME;
  }

  goalTargetFor(player) {
    const team = this.teams[player.team];
    const g = goalCenter(team.attackDir);
    return { x: g.x + team.attackDir * 0.8, y: g.y };
  }

  possessionTeam() {
    if (this.ball.owner !== null) return this.getPlayer(this.ball.owner).team;
    return null;
  }

  resumeSecondHalf() {
    if (this.state !== STATES.HALFTIME) return;
    for (const t of this.teams) t.attackDir = -t.attackDir;
    for (const p of this.players) p.facing = { x: this.teams[p.team].attackDir, y: 0 };
    this.clock.half = 2;
    this.clock.time = 0;
    this.emit('secondhalf');
    this.beginSetPiece({ kind: SET_PIECES.KICKOFF, team: 1 - this.kickoffTeam, pos: { x: PITCH.length / 2, y: HALF_W } });
  }

  // ------------------------------------------------------------- stepping

  step(dt = PHYSICS.dt) {
    if (this.state === STATES.HALFTIME || this.state === STATES.FULLTIME) return;
    // A pending decision freezes everything: the clock, the ball and all 22
    // players. Nothing advances until resolveDecision() is called.
    if (this.pendingDecision) return;
    if (this.aimControl) this.applyAimInputs();
    this.time += dt;
    this.tickTimers(dt);

    switch (this.state) {
      case STATES.GOAL:
        this.goalTimer -= dt;
        for (const p of this.players) this.integratePlayer(p, dt, { x: 0, y: 0 });
        if (this.goalTimer <= 0) {
          if (this.clock.time >= this.clock.halfSeconds) this.endHalf();
          else this.beginSetPiece({ kind: SET_PIECES.KICKOFF, team: this.pendingKickoffTeam, pos: { x: PITCH.length / 2, y: HALF_W } });
        }
        break;
      case STATES.KICKOFF:
      case STATES.SET_PIECE:
        this.stepSetPiece(dt);
        break;
      case STATES.PLAY:
        this.stepPlay(dt);
        break;
      default:
        break;
    }
    this.consumeHumanButtons();
  }

  tickTimers(dt) {
    for (const p of this.players) {
      p.kickCooldown = Math.max(0, p.kickCooldown - dt);
      p.tackleCooldown = Math.max(0, p.tackleCooldown - dt);
      p.stun = Math.max(0, p.stun - dt);
      p.frozen = Math.max(0, p.frozen - dt);
      p.untackleable = Math.max(0, p.untackleable - dt);
      p.speedBoost = Math.max(0, p.speedBoost - dt);
      p.magnet = Math.max(0, p.magnet - dt);
      p.protect = Math.max(0, p.protect - dt);
      p.reactTimer = Math.max(0, p.reactTimer - dt);
      p.ability.cooldown = Math.max(0, p.ability.cooldown - dt);
      if (p.sliding > 0) {
        p.sliding = Math.max(0, p.sliding - dt);
        if (p.sliding === 0) {
          p.slideDir = null;
          p.slideWinsBall = false;
        }
      }
    }
  }

  consumeHumanButtons() {
    for (const h of this.humanInputs) {
      h.pass = false;
      h.shoot = false;
      h.special = false;
    }
  }

  // ------------------------------------------------------------ set pieces

  beginSetPiece({ kind, team, pos }) {
    this.lastSetPieceKind = kind;
    this.clearOffsideFlags();
    this.decisionCarry = null;
    const ball = this.ball;
    ball.owner = null;
    ball.homing = null;
    ball.spin = 0;
    ball.unstoppable = false;
    ball.vel = { x: 0, y: 0 };
    ball.z = 0;
    ball.vz = 0;
    ball.pos = { ...pos };
    ball.lastTouchTeam = team;
    ball.lastTouch = null;
    if (kind === SET_PIECES.KICKOFF) this.pendingKickoffTeam = team;

    const taker = this.chooseTaker(kind, team, pos);
    const targets = this.setPieceTargets(kind, team, pos, taker);
    this.setPiece = { kind, team, pos: { ...pos }, takerId: taker.id, timer: 0, lerp: 0, starts: new Map(), targets, taken: false, aim: null };
    for (const p of this.players) this.setPiece.starts.set(p.id, { ...p.pos });
    for (const p of this.players) {
      p.vel = { x: 0, y: 0 };
      p.sliding = 0;
      p.pendingKick = null;
    }
    this.state = kind === SET_PIECES.KICKOFF ? STATES.KICKOFF : STATES.SET_PIECE;
    this.emit('setpiece', { kind, team, takerId: taker.id });
  }

  chooseTaker(kind, teamIdx, pos) {
    const team = this.teams[teamIdx];
    const active = team.players.filter((p) => !p.sentOff);
    if (kind === SET_PIECES.GOAL_KICK) return active.find((p) => p.isGK) || active[0];
    const outfield = active.filter((p) => !p.isGK);
    const humans = outfield.filter((p) => p.human !== null);
    if (kind === SET_PIECES.PENALTY) {
      if (humans.length) return humans[0];
      return outfield.slice().sort((a, b) => b.stats.shotAccuracy + b.stats.shotPower - (a.stats.shotAccuracy + a.stats.shotPower))[0];
    }
    if (kind === SET_PIECES.KICKOFF) {
      if (humans.length) return humans[0];
      const fw = outfield.filter((p) => p.role === ROLES.FW);
      return (fw.length ? fw : outfield)[0];
    }
    // Human takes if reasonably close, otherwise nearest outfield player.
    const nearHuman = humans.filter((p) => dist(p.pos, pos) < 25).sort((a, b) => dist(a.pos, pos) - dist(b.pos, pos))[0];
    if (nearHuman) return nearHuman;
    return outfield.slice().sort((a, b) => dist(a.pos, pos) - dist(b.pos, pos))[0];
  }

  // Compute where every player should stand for the restart.
  setPieceTargets(kind, teamIdx, pos, taker) {
    const targets = new Map();
    const attacking = this.teams[teamIdx];
    const defending = this.teams[1 - teamIdx];
    const inside = (p) => ({ x: clamp(p.x, 0.8, PITCH.length - 0.8), y: clamp(p.y, 0.8, PITCH.width - 0.8) });

    for (const team of this.teams) {
      for (const p of team.players) {
        if (p.sentOff) {
          targets.set(p.id, { x: -6, y: PITCH.width / 2 + (p.team ? 8 : -8) });
          continue;
        }
        let t;
        if (kind === SET_PIECES.KICKOFF) {
          const s = team.formation.slots[p.slot];
          t = relToWorld(team, Math.min(s.x, team.index === teamIdx ? 0.44 : 0.4), s.y);
          if (team.index === teamIdx && p.role === ROLES.FW && p.id !== taker.id) t = relToWorld(team, 0.47, 0.44);
        } else if (kind === SET_PIECES.PENALTY) {
          const goalSide = attacking.attackDir; // goal being attacked
          if (p.isGK && team.index === defending.index) {
            t = { x: goalSide > 0 ? PITCH.length - 0.4 : 0.4, y: HALF_W };
          } else {
            // Outside the box, behind the ball.
            const s = team.formation.slots[p.slot];
            const backX = goalSide > 0 ? PITCH.length - PITCH.penaltyAreaDepth - 3 - s.y * 6 : PITCH.penaltyAreaDepth + 3 + s.y * 6;
            const spreadY = 6 + (p.id % 7) * 8;
            t = { x: backX - goalSide * (team.index === defending.index ? 0 : 4) - goalSide * (p.slot % 3) * 3, y: spreadY };
            if (p.isGK) t = { x: goalSide > 0 ? 2 : PITCH.length - 2, y: HALF_W };
          }
        } else if (kind === SET_PIECES.CORNER) {
          const goalSide = attacking.attackDir;
          const boxX = goalSide > 0 ? PITCH.length - 9 : 9;
          if (team.index === teamIdx) {
            if (p.role === ROLES.FW || p.role === ROLES.MF) {
              const i = p.slot - 5;
              t = { x: boxX - goalSide * (i % 3) * 3, y: HALF_W - 10 + (i * 4.5 + 3) };
            } else if (p.isGK) t = slotWorldPos(team, p.slot);
            else t = homePosition(this, p, pos, 'attack');
          } else {
            if (p.isGK) t = { x: goalSide > 0 ? PITCH.length - 0.6 : 0.6, y: HALF_W };
            else if (p.role === ROLES.DF || p.role === ROLES.MF) {
              const i = p.slot - 1;
              t = { x: boxX + goalSide * 2 - goalSide * (i % 2) * 2.5, y: HALF_W - 12 + i * 3.4 };
            } else t = homePosition(this, p, pos, 'defend');
          }
        } else if (kind === SET_PIECES.GOAL_KICK) {
          const mode = team.index === teamIdx ? 'attack' : 'defend';
          t = p.isGK ? (team.index === teamIdx ? pos : slotWorldPos(team, p.slot)) : homePosition(this, p, pos, mode);
          if (team.index !== teamIdx && !p.isGK) {
            // Opponents must be outside the penalty area
            const goalSide = -attacking.attackDir;
            if (isInPenaltyArea(t, goalSide)) t = { x: t.x + attacking.attackDir * 12, y: t.y };
          }
        } else {
          // throw-in / free kick: formation shifted toward the ball; opponents at least 9.15 m away
          const mode = team.index === teamIdx ? 'attack' : 'defend';
          t = p.isGK ? slotWorldPos(team, p.slot) : homePosition(this, p, pos, mode);
          if (team.index !== teamIdx && !p.isGK) {
            const d = dist(t, pos);
            const minD = kind === SET_PIECES.THROW_IN ? 2.5 : PITCH.freeKickDistance + 0.5;
            if (d < minD) {
              const away = d > 0.1 ? norm(sub(t, pos)) : { x: -attacking.attackDir, y: 0 };
              t = add(pos, scale(away, minD));
            }
          }
        }
        if (p.id === taker.id) {
          const towardCentre = kind === SET_PIECES.KICKOFF ? { x: -attacking.attackDir, y: 0 } : norm(sub({ x: PITCH.length / 2, y: HALF_W }, pos));
          t = add(pos, scale(towardCentre, -0.9));
          if (kind === SET_PIECES.PENALTY) t = add(pos, { x: -attacking.attackDir * 1.5, y: 0 });
        }
        targets.set(p.id, inside(t));
      }
    }
    // Opponents' wall for a free kick near goal.
    if (kind === SET_PIECES.FREE_KICK) {
      const goal = goalCenter(attacking.attackDir);
      const d = dist(pos, goal);
      if (d < 30) {
        const wallDir = norm(sub(goal, pos));
        const base = add(pos, scale(wallDir, PITCH.freeKickDistance + 0.6));
        const side = { x: -wallDir.y, y: wallDir.x };
        const wall = defending.players.filter((p) => !p.isGK && !p.sentOff).slice(0, 3);
        wall.forEach((p, i) => targets.set(p.id, inside(add(base, scale(side, (i - 1) * 1.3)))));
      }
    }
    return targets;
  }

  // Put every player on their mark for the current restart immediately,
  // skipping the walk-into-position animation.
  snapToSetPiece() {
    const sp = this.setPiece;
    if (!sp) return;
    for (const p of this.players) {
      const target = sp.targets.get(p.id);
      if (!target) continue;
      p.pos = { ...target };
      p.vel = { x: 0, y: 0 };
      sp.starts.set(p.id, { ...target });
    }
  }

  stepSetPiece(dt) {
    const sp = this.setPiece;
    sp.timer += dt;
    const lerpDur = 1.0;
    sp.lerp = Math.min(1, sp.timer / lerpDur);
    const ease = sp.lerp * (2 - sp.lerp);
    for (const p of this.players) {
      const start = sp.starts.get(p.id);
      const target = sp.targets.get(p.id);
      p.pos = lerp(start, target, ease);
      p.vel = { x: 0, y: 0 };
      p.facing = norm(sub(this.ball.pos, p.pos));
      if (p.pos.x < 0 && p.sentOff) continue;
    }
    if (sp.lerp < 1) return;

    const taker = this.getPlayer(sp.takerId);
    // Taker holds the ball while waiting.
    this.ball.owner = taker.id;
    this.ball.pos = add(taker.pos, scale(norm(sub(sp.pos, taker.pos)), 0.9));
    if (this.setPiece.kind !== SET_PIECES.PENALTY) this.ball.pos = { ...sp.pos };

    const humanIdx = taker.human;
    const waited = sp.timer - lerpDur;
    if (this.aimControl) {
      // Whoever is on that team takes it; the human aims and releases.
      const human = this.config.humans.find((h) => h.team === taker.team);
      if (human) {
        if (waited > TIMING.setPieceHumanTimeout) this.takeSetPiece(taker, 'auto', null);
        return;
      }
      if (waited > TIMING.setPieceAiDelay) this.takeSetPiece(taker, 'auto', null);
      return;
    }
    if (humanIdx !== null && humanIdx !== undefined) {
      if (this.assist) {
        // Assisted play: freeze and ask, instead of waiting for a button.
        this.openDecision(taker, 'set_piece', sp.kind);
        return;
      }
      const inp = this.humanInputs[humanIdx];
      const mv = inp.move;
      if (len(mv) > 0.2) {
        sp.aim = norm(mv);
        taker.facing = sp.aim;
      }
      if (inp.shoot) {
        this.takeSetPiece(taker, 'shoot', sp.aim);
        return;
      }
      if (inp.pass) {
        this.takeSetPiece(taker, 'pass', sp.aim);
        return;
      }
      if (waited > TIMING.setPieceHumanTimeout) this.takeSetPiece(taker, 'auto', sp.aim);
      return;
    }
    if (waited > TIMING.setPieceAiDelay) this.takeSetPiece(taker, 'auto', null);
  }

  takeSetPiece(taker, mode, aim, { target: explicitTarget = null, humanIndex } = {}) {
    const sp = this.setPiece;
    const kind = sp.kind;
    this.state = STATES.PLAY;
    this.setPiece = null;
    this.ball.owner = taker.id;
    this.ball.pos = { ...sp.pos };
    this.ball.lastTouchTeam = taker.team;
    this.ball.lastTouch = taker.id;
    taker.kickCooldown = 0;

    // Timed automatic restarts must not spend a learner’s saved reward.
    const focusHuman = mode === 'auto' ? null : humanIndex;
    const exempt = offsideExemptSetPiece(kind);
    let action = mode;
    if (mode === 'auto') action = chooseAiSetPieceAction(this, taker, kind);
    if (kind === SET_PIECES.PENALTY) action = 'shoot';

    if (action === 'shoot') {
      const aimY = aim ? clamp(aim.y, -1, 1) : this.rng.range(-0.7, 0.7);
      this.shoot(taker, aimY, { noOffside: exempt, force: true, humanIndex: focusHuman });
    } else {
      const target = explicitTarget || this.choosePassTarget(taker, aim, { setPiece: kind });
      if (target) this.passTo(taker, target, { noOffside: exempt, loft: kind === SET_PIECES.CORNER || kind === SET_PIECES.GOAL_KICK, humanIndex: focusHuman });
      else {
        const dir = aim || { x: this.teams[taker.team].attackDir, y: 0 };
        this.kick(taker, dir, 16, { noOffside: exempt });
      }
    }
    if (kind === SET_PIECES.KICKOFF) this.emit('kickoff', { team: taker.team });
    this.emit('whistle');
  }

  // --------------------------------------------------------------- playing

  stepPlay(dt) {
    this.clock.time += dt;
    if (this.clock.time >= this.clock.halfSeconds) {
      this.endHalf();
      return;
    }

    // Controllers
    const prevOwner = this.ball.owner;
    const ballOwner = this.ball.owner !== null ? this.getPlayer(this.ball.owner) : null;
    this.frameCache = this.buildFrameCache(ballOwner);
    for (const p of this.players) {
      if (p.sentOff) continue;
      const input = p.human !== null && !this.aimControl ? this.humanInputs[p.human] : null;
      if (input && !this.assist) this.controlHuman(p, input, dt);
      else if (input) this.controlAssistedHuman(p, input, dt);
      else if (p.isGK) updateGoalkeeper(this, p, dt);
      else updateOutfieldAI(this, p, dt);
      // A foul/offside can stage a restart during a controller action.
      // Preserve its positions instead of running the remaining old frame.
      if (this.state !== STATES.PLAY) return;
    }
    // Movement
    for (const p of this.players) {
      if (p.sentOff) continue;
      this.integratePlayer(p, dt, p.desiredVel || { x: 0, y: 0 });
    }
    this.separatePlayers();
    // Ball
    this.updatePossession(dt);
    this.integrateBall(dt);
    if (this.state !== STATES.PLAY) return;
    this.checkOutOfPlay();
    if (this.state !== STATES.PLAY) return;
    this.trackAimHold();
    if (this.aimControl) this.pruneMoveOrders();
    this.maybeOpenDecision(prevOwner);
  }

  // Drop orders whose player is no longer the one you are playing through.
  pruneMoveOrders() {
    for (let i = 0; i < this.moveOrders.length; i++) {
      const order = this.moveOrders[i];
      if (!order) continue;
      const active = this.activePlayerFor(i);
      if (!active || active.id !== order.playerId) this.moveOrders[i] = null;
    }
  }

  trackAimHold() {
    if (!this.aimControl) return;
    const owner = this.ball.owner !== null ? this.getPlayer(this.ball.owner) : null;
    if (!owner || !this.isHumanTeam(owner.team)) {
      this.aimHold = null;
      return;
    }
    if (!this.aimHold || this.aimHold.playerId !== owner.id) {
      this.aimHold = { playerId: owner.id, since: this.time };
    }
  }

  // ------------------------------------------------------ whole-team play
  //
  // One touch runs the match: hold to aim, release to play the ball. The
  // human never steers a player, so possession is whoever on their team has
  // the ball. A release with no aim is a press instead of a kick.

  // Teams with a human on them in whole-team play. Their ball carrier waits
  // for the human instead of deciding for itself.
  isHumanTeam(teamIndex) {
    return this.aimControl && this.config.humans.some((h) => h.team === teamIndex);
  }

  // May the AI play the ball off this carrier's foot, or must it wait for the
  // person holding the phone?
  //
  // It waits, for as long as it takes. With no input your player simply keeps
  // dribbling; the ball is never passed or shot on your behalf. Play still
  // moves, because the opposition close them down and take it off them.
  aiMayActFor(p) {
    if (this.isAssisted(p)) return false;
    if (!this.aimControl || !this.isHumanTeam(p.team)) return true;
    return false;
  }

  // Who a human is "playing through" right now: their ball carrier, else the
  // teammate nearest the ball.
  activePlayerFor(humanIndex) {
    const teamIndex = this.config.humans[humanIndex]?.team ?? 0;
    const team = this.teams[teamIndex];
    const owner = this.ball.owner !== null ? this.getPlayer(this.ball.owner) : null;
    if (owner && owner.team === teamIndex) return owner;
    let best = null;
    let bestD = Infinity;
    for (const p of team.players) {
      if (p.sentOff || p.isGK) continue;
      const d = dist(p.pos, this.ball.pos);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }

  // True when this human can play the ball right now.
  canKick(humanIndex) {
    if (!this.aimControl) return false;
    const teamIndex = this.config.humans[humanIndex]?.team ?? 0;
    if (this.state === STATES.PLAY) {
      const owner = this.ball.owner !== null ? this.getPlayer(this.ball.owner) : null;
      return Boolean(owner && owner.team === teamIndex && owner.kickCooldown <= 0);
    }
    if (this.state === STATES.SET_PIECE || this.state === STATES.KICKOFF) {
      const sp = this.setPiece;
      return Boolean(sp && sp.lerp >= 1 && this.getPlayer(sp.takerId).team === teamIndex);
    }
    return false;
  }

  // Queue a drawn path for this frame. `points` is a world-space polyline in
  // metres, as traced by the finger. Returns true if it was accepted.
  aimPath(humanIndex, points) {
    if (!this.canKick(humanIndex)) return false;
    const path = sanitisePath(points);
    if (path.length < 2 || dist(path[0], path[path.length - 1]) < AIM.pathMinSpacing) return false;
    this.aimKicks[humanIndex] = { path };
    return true;
  }

  // Play the displayed marker as its named pass or shot. Keep the carrier
  // and receiver identities so a stale marker never kicks for another player.
  playSuggestion(humanIndex, suggestion) {
    if (!suggestionAction(this, humanIndex, suggestion)) return false;
    this.aimKicks[humanIndex] = {
      suggestion: { ...suggestion, point: { ...suggestion.point } },
      restart: this.setPiece,
    };
    return true;
  }

  // Queue a kick for this frame. `dir` is a unit vector on the pitch and
  // `power` runs 0..1. Returns true if it was accepted.
  aimKick(humanIndex, dir, power) {
    if (!this.canKick(humanIndex)) return false;
    const l = Math.hypot(dir.x, dir.y);
    if (!Number.isFinite(l) || l < 1e-6 || !Number.isFinite(power)) return false;
    this.aimKicks[humanIndex] = { dir: { x: dir.x / l, y: dir.y / l }, power: clamp(power, 0, 1) };
    return true;
  }

  // A tap on the grass is an order: go there. The player you are playing
  // through runs to the spot, carrying the ball if they have it. Tapping
  // somebody down is what happens when you tap the opposition's carrier.
  tap(humanIndex, point = null) {
    if (!this.aimControl) return false;
    if (!point) {
      // No place named: fall back to closing down or knocking the ball on.
      if (this.canDribble(humanIndex)) {
        this.dribbles[humanIndex] = true;
        return true;
      }
      return this.press(humanIndex);
    }
    const player = this.activePlayerFor(humanIndex);
    if (!player) return false;
    const carrier = this.ball.owner !== null ? this.getPlayer(this.ball.owner) : null;
    const theirs = carrier && carrier.team !== player.team;
    // Tapping right on top of an opponent with the ball means "get stuck in".
    if (theirs && dist(point, carrier.pos) < AIM.moveOrderRadius * 2) return this.press(humanIndex);
    // Co-op shares a carrier: the latest destination replaces a partner's
    // older order, so movement and decision pacing follow the same command.
    for (let i = 0; i < this.moveOrders.length; i++) {
      if (this.moveOrders[i]?.playerId === player.id) this.moveOrders[i] = null;
    }
    this.moveOrders[humanIndex] = {
      playerId: player.id,
      point: {
        x: clamp(point.x, 0.5, PITCH.length - 0.5),
        y: clamp(point.y, 0.5, PITCH.width - 0.5),
      },
    };
    this.emit('moveorder', { playerId: player.id, humanIndex, point: this.moveOrders[humanIndex].point });
    return true;
  }

  // The best place to put the ball next, for the marker on the pitch. It is
  // the same ranking the AI passes by, so the hint never disagrees with what
  // a computer-controlled player would have done. Null when it is not your
  // ball to play.
  suggestedTarget(humanIndex) {
    if (!this.aimControl || !this.canKick(humanIndex)) return null;
    const carrier = this.state === STATES.PLAY
      ? (this.ball.owner !== null ? this.getPlayer(this.ball.owner) : null)
      : (this.setPiece ? this.getPlayer(this.setPiece.takerId) : null);
    if (!carrier) return null;
    const setPiece = this.setPiece ? this.setPiece.kind : undefined;
    const ranked = this.rankPassTargets(carrier, null, { setPiece })
      .filter((r) => r.player.stun <= 0 && r.player.frozen <= 0);
    const best = ranked.length ? ranked[0] : null;

    // If there is a clear sight of goal from close in, that beats any pass.
    const goal = this.goalTargetFor(carrier);
    const dGoal = dist(carrier.pos, goal);
    const identity = { kickerId: carrier.id, setPieceKind: setPiece ?? null };
    if (setPiece === SET_PIECES.PENALTY || (dGoal < 18 + carrier.stats.shotPower && this.laneIsClear(carrier, goal))) {
      return { kind: 'shot', point: goal, playerId: null, ...identity };
    }
    if (!best) return null;
    return { kind: 'pass', point: { ...best.player.pos }, playerId: best.player.id, ...identity };
  }

  suggestedRun(humanIndex) {
    if (!this.canDribble(humanIndex) || this.isCarryingRun(humanIndex)
        || this.suggestedTarget(humanIndex)?.kind === 'shot') return null;
    const carrier = this.getPlayer(this.ball.owner);
    const point = findOpenRun(this, carrier);
    return point ? { kind: 'run', point, playerId: null, kickerId: carrier.id, setPieceKind: null } : null;
  }

  playRun(humanIndex, suggestion) {
    if (!Number.isInteger(humanIndex) || !this.config.humans[humanIndex]
        || !this.canDribble(humanIndex) || suggestion?.kind !== 'run'
        || suggestion.kickerId !== this.ball.owner || suggestion.setPieceKind !== null
        || suggestion.playerId !== null || !Number.isFinite(suggestion.point?.x)
        || !Number.isFinite(suggestion.point?.y)) return false;
    const carrier = this.getPlayer(this.ball.owner);
    const safe = findOpenRun(this, carrier);
    // A captured marker cannot send a new carrier into a newly blocked lane.
    if (!safe || dist(safe, suggestion.point) > 2) return false;
    return this.tap(humanIndex, safe);
  }

  // A chosen carry runs in real time until its destination or nearby pressure
  // calls for another decision. This changes pacing, never speed or tackling.
  isCarryingRun(humanIndex) {
    if (!this.canDribble(humanIndex)) return false;
    const carrier = this.getPlayer(this.ball.owner);
    const order = this.moveOrders.find((order) => order?.playerId === carrier.id);
    if (!order || order.playerId !== carrier.id || !Number.isFinite(order.point?.x)
        || !Number.isFinite(order.point?.y)) return false;
    const to = sub(order.point, carrier.pos);
    const distance = len(to);
    if (distance <= AIM.moveOrderRadius) return false;
    const dir = scale(to, 1 / distance);
    const ahead = Math.min(distance, 4);
    for (const opponent of this.opponentsOf(carrier)) {
      const rel = sub(opponent.pos, carrier.pos);
      if (len(rel) < 3) return false;
      const along = dot(rel, dir);
      const sideways = Math.abs(rel.x * dir.y - rel.y * dir.x);
      if (along > 0 && along < ahead + 1 && sideways < 2.5) return false;
    }
    return true;
  }

  // Is there a clear run from this player to that point?
  laneIsClear(p, point) {
    const to = sub(point, p.pos);
    const d = len(to);
    if (d < 1e-6) return true;
    const dir = scale(to, 1 / d);
    for (const o of this.opponentsOf(p)) {
      if (o.isGK) continue;
      const rel = sub(o.pos, p.pos);
      const along = dot(rel, dir);
      if (along <= 0.5 || along >= d) continue;
      if (Math.abs(rel.x * dir.y - rel.y * dir.x) < 1.3) return false;
    }
    return true;
  }

  // The standing order for this player, or null. Cleared once they arrive.
  moveOrderFor(player) {
    for (let i = 0; i < this.moveOrders.length; i++) {
      const order = this.moveOrders[i];
      if (!order || order.playerId !== player.id) continue;
      if (dist(player.pos, order.point) <= AIM.moveOrderRadius) {
        this.moveOrders[i] = null;
        return null;
      }
      return order.point;
    }
    return null;
  }

  clearMoveOrder(humanIndex) {
    this.moveOrders[humanIndex] = null;
  }

  canDribble(humanIndex) {
    if (!this.aimControl || this.state !== STATES.PLAY) return false;
    const teamIndex = this.config.humans[humanIndex]?.team ?? 0;
    const owner = this.ball.owner !== null ? this.getPlayer(this.ball.owner) : null;
    return Boolean(owner && owner.team === teamIndex && owner.kickCooldown <= 0 && !owner.isGK
      && !owner.sentOff && owner.stun <= 0 && owner.frozen <= 0 && owner.sliding <= 0);
  }

  press(humanIndex) {
    if (!this.aimControl) return false;
    this.presses[humanIndex] = true;
    return true;
  }

  // Apply queued kicks and presses. Called before the world is stepped so a
  // release lands on the same frame the player let go.
  applyAimInputs() {
    for (let i = 0; i < this.aimKicks.length; i++) {
      const kick = this.aimKicks[i];
      this.aimKicks[i] = null;
      if (!kick || !this.canKick(i)) continue;
      if (kick.suggestion) {
        const action = suggestionAction(this, i, kick.suggestion);
        if (!action || this.setPiece !== kick.restart) continue;
        const { kicker, target, aimY } = action;
        if (this.setPiece) {
          this.takeSetPiece(kicker, kick.suggestion.kind === 'shot' ? 'shoot' : 'pass', { x: 0, y: aimY }, { target, humanIndex: i });
        } else if (target) this.passTo(kicker, target, { humanIndex: i });
        else this.shoot(kicker, aimY, { humanIndex: i });
        continue;
      }
      const teamIndex = this.config.humans[i]?.team ?? 0;
      if (this.state === STATES.SET_PIECE || this.state === STATES.KICKOFF) {
        const taker = this.getPlayer(this.setPiece.takerId);
        if (taker.sentOff || taker.stun > 0 || taker.frozen > 0 || taker.kickCooldown > 0) continue;
        this.playBall(taker, kick, { setPieceKind: this.setPiece.kind, humanIndex: i });
        continue;
      }
      const owner = this.getPlayer(this.ball.owner);
      if (owner.team !== teamIndex || owner.sentOff || owner.stun > 0 || owner.frozen > 0) continue;
      this.playBall(owner, kick, { humanIndex: i });
    }
    for (let i = 0; i < this.dribbles.length; i++) {
      if (!this.dribbles[i]) continue;
      this.dribbles[i] = false;
      if (this.canDribble(i)) this.pushBallOn(this.getPlayer(this.ball.owner));
    }
    for (let i = 0; i < this.presses.length; i++) {
      if (!this.presses[i]) continue;
      this.presses[i] = false;
      this.pressWithNearest(i);
    }
  }

  // Knock the ball into space ahead and chase it. The touch is short enough
  // that the carrier usually keeps it, but an opponent in the way can nick it,
  // which is what makes tapping forward a decision rather than a free ride.
  pushBallOn(p) {
    const team = this.teams[p.team];
    const goal = goalCenter(team.attackDir);
    const facing = len(p.vel) > 1.5 ? norm(p.vel) : len(p.facing) > 0.01 ? norm(p.facing) : { x: team.attackDir, y: 0 };
    // Bias the touch towards goal so tapping always makes progress.
    const dir = norm(add(scale(facing, 1), scale(norm(sub(goal, p.pos)), 0.65)));
    const speed = AIM.dribbleSpeed + p.stats.speed * 0.35;
    this.ball.owner = null;
    this.ball.homing = null;
    this.ball.unstoppable = false;
    this.ball.pos = add(p.pos, scale(dir, PHYSICS.playerRadius + PHYSICS.ballRadius + 0.1));
    this.ball.vel = scale(dir, speed);
    this.ball.z = 0;
    this.ball.vz = 0;
    this.ball.lastTouch = p.id;
    this.ball.lastTouchTeam = p.team;
    p.facing = dir;
    // Just long enough that the ball gets away, then they can take it again.
    p.kickCooldown = AIM.dribbleCooldown;
    p.speedBoost = Math.max(p.speedBoost, AIM.dribbleBoost);
    this.clearOffsideFlags();
    this.emit('dribble', { playerId: p.id, team: p.team });
  }

  // One kick covers passing and shooting: the ball simply goes where it is
  // aimed, as hard as it was hit.
  playBall(kicker, kick, { setPieceKind = null, humanIndex } = {}) {
    if (kick.path) return this.playBallAlongPath(kicker, kick.path, { setPieceKind, humanIndex });
    const { dir, power } = kick;
    const speed = AIM.minSpeed + power * (kicker.phys.shotSpeed - AIM.minSpeed);
    // Aiming is forgiving at low power and demanding at high power, and a
    // better striker strays less either way.
    const spread = (AIM.baseSpread + power * AIM.powerSpread) * (0.55 + kicker.phys.shotSpread);
    const err = this.rng.gaussian() * spread * this.mathsAccuracyScale(kicker, humanIndex);
    const aimed = fromAngle(angle(dir) + err);
    const lofted = power > AIM.loftPower;
    const vz = lofted ? (power - AIM.loftPower) * AIM.loftScale : 0;
    const goal = goalCenter(this.teams[kicker.team].attackDir);
    const towardsGoal = dot(aimed, norm(sub(goal, kicker.pos))) > 0.86 && dist(kicker.pos, goal) < 40;
    if (towardsGoal) this.stats.shots[kicker.team]++;
    if (setPieceKind) {
      this.state = STATES.PLAY;
      const sp = this.setPiece;
      this.setPiece = null;
      this.ball.pos = { ...sp.pos };
      this.ball.owner = kicker.id;
      kicker.kickCooldown = 0;
      this.kick(kicker, aimed, speed, { vz, kind: towardsGoal ? 'shot' : 'pass', noOffside: offsideExemptSetPiece(setPieceKind) });
      if (setPieceKind === SET_PIECES.KICKOFF) this.emit('kickoff', { team: kicker.team });
      this.emit('whistle');
      return;
    }
    this.kick(kicker, aimed, speed, { vz, kind: towardsGoal ? 'shot' : 'pass' });
    if (towardsGoal) this.emit('shot', { playerId: kicker.id, team: kicker.team });
  }

  // Work out the kick that lands the ball where the line was drawn.
  //
  // The drawing names a target and a shape; the ball then flies by the same
  // physics as any other ball. A short line is driven along the grass hard
  // enough to arrive and stop there; a long one is lifted and dropped on the
  // spot. If the kicker is not strong enough to reach, they hit it as hard as
  // they can and it falls short, which is what would really happen. A line
  // that bulges sideways puts curl on it.
  planKick(kicker, drawn) {
    const start = { ...this.ball.pos };
    const anchored = anchorPath(drawn, start);
    const target = anchored[anchored.length - 1];
    const to = sub(target, start);
    const distance = len(to);
    const dir = distance > 1e-6 ? scale(to, 1 / distance) : { x: this.teams[kicker.team].attackDir, y: 0 };
    const maxSpeed = kicker.phys.shotSpeed;

    let speed;
    let vz = 0;
    if (distance <= AIM.groundPassMax) {
      // Rolling: friction has to eat exactly this much distance.
      speed = Math.sqrt(2 * PHYSICS.ballRollFriction * Math.max(distance, 1));
    } else {
      // Lifted: a projectile launched at a fixed angle that lands on the spot.
      const g = PHYSICS.gravity;
      const a = AIM.loftAngle;
      const launch = Math.sqrt((distance * g) / Math.max(0.2, Math.sin(2 * a)));
      speed = launch * Math.cos(a);
      vz = launch * Math.sin(a);
      if (launch > maxSpeed) {
        // Cannot reach: hit it as hard as they can at the same angle.
        speed = maxSpeed * Math.cos(a);
        vz = maxSpeed * Math.sin(a);
      }
    }
    speed = Math.min(speed, maxSpeed);
    const spin = drawnCurl(anchored);
    // Begin on the drawn arc's side of its chord, then bend back towards
    // the endpoint. Launching straight at the endpoint first would curl
    // the ball away on the opposite side of the line the person drew.
    const curlTurn = PHYSICS.ballMagnus * spin / PHYSICS.ballSpinDecay;
    return { dir: rotate(dir, -curlTurn / 2), speed, vz, distance, target, spin };
  }

  playBallAlongPath(kicker, drawn, { setPieceKind = null, humanIndex } = {}) {
    const plan = this.planKick(kicker, drawn);
    // Aim is not perfect: a harder kick and a weaker striker stray more.
    const effort = plan.speed / Math.max(1, kicker.phys.shotSpeed);
    const spread = (AIM.baseSpread + effort * AIM.powerSpread) * (0.55 + kicker.phys.shotSpread);
    const dir = fromAngle(angle(plan.dir) + this.rng.gaussian() * spread * this.mathsAccuracyScale(kicker, humanIndex));
    const speed = plan.speed;
    const target = plan.target;

    if (setPieceKind) {
      this.state = STATES.PLAY;
      const sp = this.setPiece;
      this.setPiece = null;
      this.ball.pos = { ...sp.pos };
      kicker.kickCooldown = 0;
    }
    const goal = goalCenter(this.teams[kicker.team].attackDir);
    const towardsGoal = dist(target, goal) < 7 && dist(kicker.pos, goal) < 46;
    if (towardsGoal) {
      this.stats.shots[kicker.team]++;
      this.emit('shot', { playerId: kicker.id, team: kicker.team });
    }

    this.ball.owner = null;
    this.ball.homing = null;
    this.ball.unstoppable = false;
    this.ball.pos = add(kicker.pos, scale(dir, PHYSICS.playerRadius + PHYSICS.ballRadius + 0.1));
    this.ball.z = plan.vz > 0 ? 0.08 : 0;
    this.ball.vz = plan.vz;
    this.ball.vel = scale(dir, speed);
    this.ball.spin = plan.spin;
    kicker.kickCooldown = PHYSICS.kickCooldown;
    kicker.facing = dir;
    kicker.holdingBall = 0;
    this.ball.lastTouch = kicker.id;
    this.ball.lastTouchTeam = kicker.team;
    if (setPieceKind && !offsideExemptSetPiece(setPieceKind)) this.flagOffside(kicker);
    else if (setPieceKind) this.clearOffsideFlags();
    else this.flagOffside(kicker);
    this.emit('kick', { playerId: kicker.id, kind: towardsGoal ? 'shot' : 'pass' });
    if (setPieceKind === SET_PIECES.KICKOFF) this.emit('kickoff', { team: kicker.team });
    if (setPieceKind) this.emit('whistle');
  }

  pressWithNearest(humanIndex) {
    const teamIndex = this.config.humans[humanIndex]?.team ?? 0;
    const owner = this.ball.owner !== null ? this.getPlayer(this.ball.owner) : null;
    const anchor = owner ? owner.pos : this.ball.pos;
    let best = null;
    let bestD = Infinity;
    for (const p of this.teams[teamIndex].players) {
      if (p.sentOff || p.isGK || p.tackleCooldown > 0 || p.stun > 0 || p.frozen > 0) continue;
      const d = dist(p.pos, anchor);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    if (!best) return;
    if (owner && owner.team !== teamIndex && bestD <= PHYSICS.tackleRange) {
      this.attemptTackle(best, false);
      return;
    }
    if (bestD <= PHYSICS.slideRange + 1.5) {
      best.facing = norm(sub(anchor, best.pos));
      this.startSlide(best);
    }
  }

  buildFrameCache(ballOwner) {
    const ball = this.ball;
    const byTeam = this.teams.map((t) => t.players.filter((p) => !p.sentOff).slice().sort((a, b) => dist(a.pos, ball.pos) - dist(b.pos, ball.pos)));
    return {
      ballOwner,
      possession: ballOwner ? ballOwner.team : null,
      nearestByTeam: byTeam,
      ballHomeTeam: ballOwner ? ballOwner.team : this.ball.lastTouchTeam,
    };
  }

  // Human controller: joystick + 3 buttons.
  controlHuman(p, input, dt) {
    const mv = input.move;
    const mag = Math.min(1, len(mv));
    const maxSpeed = this.effectiveMaxSpeed(p);
    p.desiredVel = mag > 0.08 ? scale(norm(mv), maxSpeed * Math.max(0.35, mag)) : { x: 0, y: 0 };
    if (mag > 0.15 && p.sliding <= 0) p.facing = norm(mv);
    const hasBall = this.ball.owner === p.id;

    if (input.special) this.tryActivateAbility(p);
    if (hasBall && this.ball.owner !== p.id) return;

    if (input.pass) {
      if (hasBall) {
        const target = this.choosePassTarget(p, mag > 0.15 ? norm(mv) : null, {});
        if (target) this.passTo(p, target, {});
        else this.kick(p, p.facing, 18, {});
      } else this.attemptTackle(p, false);
    }
    // Only one possession-releasing action can succeed in this frame.
    if (hasBall && this.ball.owner !== p.id) return;
    if (input.shoot) {
      if (hasBall) this.shoot(p, mag > 0.15 ? mv.y * 0.9 : 0, {});
      else this.startSlide(p);
    }
  }

  // Assisted controller: the AI drives the player, the joystick overrides
  // steering while it is pushed, and the buttons still work as live shortcuts
  // so an experienced player is never forced to wait for the panel.
  controlAssistedHuman(p, input, dt) {
    if (p.isGK) updateGoalkeeper(this, p, dt);
    else updateOutfieldAI(this, p, dt);

    const mv = input.move;
    const mag = Math.min(1, len(mv));
    if (mag > 0.15) {
      const maxSpeed = this.effectiveMaxSpeed(p);
      p.desiredVel = scale(norm(mv), maxSpeed * Math.max(0.4, mag));
      if (p.sliding <= 0) p.facing = norm(mv);
    }

    const hasBall = this.ball.owner === p.id;
    if (input.special) this.tryActivateAbility(p);
    if (hasBall && this.ball.owner !== p.id) return;
    if (input.pass) {
      if (hasBall) {
        const target = this.choosePassTarget(p, mag > 0.15 ? norm(mv) : null, {});
        if (target) this.passTo(p, target, {});
        else this.kick(p, p.facing, 18, {});
      } else this.attemptTackle(p, false);
    }
    // Only one possession-releasing action can succeed in this frame.
    if (hasBall && this.ball.owner !== p.id) return;
    if (input.shoot) {
      if (hasBall) this.shoot(p, mag > 0.15 ? mv.y * 0.9 : this.preferredShotAim(p), {});
      else this.startSlide(p);
    }
  }

  tryActivateAbility(p) {
    const ab = getAbility(p.ability.id);
    if (p.ability.cooldown > 0 || p.ability.usesLeft <= 0) return false;
    if (p.stun > 0 || p.frozen > 0) return false;
    if (ab.needsBall && this.ball.owner !== p.id) return false;
    if (!ab.canActivate(this, p)) return false;
    ab.activate(this, p);
    p.ability.cooldown = ab.cooldown;
    if (Number.isFinite(p.ability.usesLeft)) p.ability.usesLeft -= 1;
    this.stats.specials[p.team]++;
    return true;
  }

  effectiveMaxSpeed(p) {
    const staminaFactor = 0.68 + 0.32 * p.stamina;
    const boost = p.speedBoost > 0 ? 1.6 : 1;
    return p.phys.maxSpeed * staminaFactor * boost;
  }

  integratePlayer(p, dt, desiredVel) {
    if (p.sentOff) return;
    if (p.frozen > 0) {
      p.vel = { x: 0, y: 0 };
      return;
    }
    if (p.sliding > 0 && p.slideDir) {
      const slideSpeed = p.slideWinsBall ? 11 : 8;
      p.vel = scale(p.slideDir, slideSpeed * Math.min(1, p.sliding / 0.5 + 0.3));
      p.pos = add(p.pos, scale(p.vel, dt));
      this.keepInBounds(p);
      return;
    }
    if (p.stun > 0) desiredVel = { x: 0, y: 0 };
    const maxSpeed = this.effectiveMaxSpeed(p);
    const desired = clampLen(desiredVel, maxSpeed);
    const diff = sub(desired, p.vel);
    const accel = p.phys.accel * (p.speedBoost > 0 ? 1.5 : 1);
    const dv = clampLen(diff, accel * dt);
    p.vel = add(p.vel, dv);
    p.pos = add(p.pos, scale(p.vel, dt));
    // Stamina
    const speedFrac = len(p.vel) / Math.max(1e-6, p.phys.maxSpeed);
    if (speedFrac > 0.55) p.stamina = Math.max(0, p.stamina - p.phys.staminaDrain * speedFrac * speedFrac * dt);
    else p.stamina = Math.min(1, p.stamina + 0.03 * dt);
    if (len(p.vel) > 0.5 && this.ball.owner !== p.id) p.facing = norm(p.vel);
    else if (this.ball.owner === p.id && len(p.vel) > 0.5 && p.human === null) p.facing = norm(p.vel);
    this.keepInBounds(p);
  }

  keepInBounds(p) {
    const m = 2.5;
    p.pos.x = clamp(p.pos.x, -m, PITCH.length + m);
    p.pos.y = clamp(p.pos.y, -m, PITCH.width + m);
  }

  separatePlayers() {
    const r2 = PHYSICS.playerRadius * 2;
    const ps = this.players;
    for (let i = 0; i < ps.length; i++) {
      const a = ps[i];
      if (a.sentOff) continue;
      for (let j = i + 1; j < ps.length; j++) {
        const b = ps[j];
        if (b.sentOff) continue;
        const d = sub(b.pos, a.pos);
        const l = len(d);
        if (l >= r2 || l < 1e-6) continue;
        const push = scale(norm(d), (r2 - l) * 0.5);
        const ma = a.phys.mass;
        const mb = b.phys.mass;
        const wa = mb / (ma + mb);
        const wb = ma / (ma + mb);
        a.pos = sub(a.pos, scale(push, wa * 2));
        b.pos = add(b.pos, scale(push, wb * 2));
      }
    }
  }

  // ---------------------------------------------------------- possession

  updatePossession(dt) {
    const ball = this.ball;
    // Magnet boots: pull loose ball
    if (ball.owner === null && !ball.homing) {
      for (const p of this.players) {
        if (p.magnet > 0 && !p.sentOff) {
          const d = dist(p.pos, ball.pos);
          if (d < 9 && d > 0.3) {
            const pull = scale(norm(sub(p.pos, ball.pos)), 26 * dt);
            ball.vel = add(scale(ball.vel, 1 - 2.5 * dt), pull);
            ball.vel = add(ball.vel, scale(norm(sub(p.pos, ball.pos)), 7 * dt));
          }
        }
      }
    }

    if (ball.owner !== null) {
      const owner = this.getPlayer(ball.owner);
      if (owner.stun > 0 || owner.sentOff) {
        this.releaseBall();
        ball.vel = add(scale(owner.vel, 0.5), scale(norm(owner.facing), 2));
      } else {
        this.snapBallToOwner(owner);
        // A goalkeeper may smother an opponent's controlled dribble inside
        // their own box. Ownership must not make the ball untouchable.
        if (!owner.isGK && owner.untackleable <= 0 && !ball.unstoppable) {
          const keeper = this.opponentsOf(owner).find((p) => p.isGK);
          if (keeper && keeper.stun <= 0 && keeper.frozen <= 0
              && keeper.kickCooldown <= 0 && isInPenaltyArea(keeper.pos, -this.teams[keeper.team].attackDir)
              && isInPenaltyArea(ball.pos, -this.teams[keeper.team].attackDir)
              && dist(keeper.pos, ball.pos) <= PHYSICS.controlRadius + 0.1) {
            this.releaseBall();
            this.collectBall(keeper, { dribble: true });
            this.emit('claim', { playerId: keeper.id, victimId: owner.id });
            return;
          }
        }
        if (owner.isGK && ball.owner === owner.id) owner.holdingBall += dt;
        // Sliding tacklers hitting the carrier
        for (const q of this.players) {
          if (q.sentOff || q.team === owner.team || q.sliding <= 0) continue;
          if (dist(q.pos, ball.pos) < PHYSICS.playerRadius + 0.6 && q.tackleCooldown <= 0) this.resolveSlideContact(q, owner);
        }
        return;
      }
    }

    // Loose ball: nearest eligible player collects it.
    let best = null;
    let bestD = Infinity;
    for (const p of this.players) {
      if (p.sentOff || p.frozen > 0 || p.stun > 0) continue;
      if (p.kickCooldown > 0) continue;
      const d = dist(p.pos, ball.pos);
      const reach = p.isGK ? PHYSICS.controlRadius + 0.1 : PHYSICS.controlRadius + (p.sliding > 0 ? 0.5 : 0);
      if (d > reach || ball.z > (p.isGK ? 2.3 : 1.7)) continue;
      if (ball.homing) {
        if (ball.homing.playerId !== p.id) continue;
      } else if (ball.unstoppable) continue;
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    if (best) this.collectBall(best);
  }

  collectBall(p, { dribble = false } = {}) {
    const ball = this.ball;
    const speed = len(ball.vel);
    const wasHoming = ball.homing;
    if (!wasHoming && speed > 17 && !p.isGK) {
      // Hard ball: chance to miscontrol and deflect
      const pControl = clamp(1 - (speed - 17) / 30, 0.35, 1);
      if (!this.rng.chance(pControl)) {
        this.deflectBall(p, 0.35);
        this.onTouch(p);
        return;
      }
    }
    if (p.isGK) {
      // Handled as a catch: goalkeeper module decides catch vs parry
      const outcome = this.goalkeeperCatch(p, { dribble });
      if (outcome === 'parry') return;
    }
    ball.owner = p.id;
    ball.homing = null;
    ball.spin = 0;
    ball.unstoppable = false;
    ball.vel = { ...p.vel };
    ball.z = 0;
    ball.vz = 0;
    p.holdingBall = 0;
    p.ai.decisionTimer = p.isGK ? 0 : 0.45 + this.rng.range(0, 0.4); // first touch: carry before deciding
    p.protect = 0.5;
    this.snapBallToOwner(p);
    this.onTouch(p);
    if (this.state !== STATES.PLAY) return;
    if (wasHoming && wasHoming.assistFinish) {
      // Compelled finish
      const goal = this.goalTargetFor(p);
      this.launchHoming(p, { point: goal, speed: 38, unstoppable: true, kind: 'shot' });
      this.emit('special', { playerId: p.id, text: 'THUNDER FINISH!' });
    }
  }

  goalkeeperCatch(gk, { dribble = false } = {}) {
    const ball = this.ball;
    const speed = len(ball.vel);
    if (ball.unstoppable) return 'parry';
    const towardOwnGoal = dot(ball.vel, { x: -this.teams[gk.team].attackDir, y: 0 }) > 0;
    const pCatch = clamp(1 - (speed - 10) / 30, 0.2, 0.95);
    if (!dribble && towardOwnGoal && speed > 8) {
      this.stats.saves[gk.team]++;
      this.emit('save', { playerId: gk.id });
    }
    // A slow ball already within arm's reach is a reliable collection.
    if (dribble || speed <= 10) return 'catch';
    if (this.rng.chance(pCatch)) return 'catch';
    // Parry: deflect away from goal, upfield-ish
    const away = norm(add({ x: this.teams[gk.team].attackDir, y: 0 }, { x: 0, y: this.rng.range(-1.2, 1.2) }));
    ball.vel = scale(away, Math.max(8, speed * 0.45));
    ball.vz = 3;
    ball.z = Math.max(ball.z, 0.3);
    gk.kickCooldown = 0.5;
    ball.lastTouch = gk.id;
    ball.lastTouchTeam = gk.team;
    this.onTouch(gk);
    return 'parry';
  }

  deflectBall(p, factor) {
    const ball = this.ball;
    const away = norm(add(norm(sub(ball.pos, p.pos)), scale({ x: this.rng.gaussian(), y: this.rng.gaussian() }, 0.4)));
    ball.vel = scale(away, Math.max(3, len(ball.vel) * factor));
    ball.vz = Math.max(ball.vz, 1.5);
    ball.z = Math.max(ball.z, 0.1);
    p.kickCooldown = 0.35;
    ball.lastTouch = p.id;
    ball.lastTouchTeam = p.team;
  }

  snapBallToOwner(p) {
    const ball = this.ball;
    const f = len(p.facing) > 0.01 ? norm(p.facing) : { x: this.teams[p.team].attackDir, y: 0 };
    ball.pos = add(p.pos, scale(f, p.isGK ? 0.4 : PHYSICS.dribbleOffset));
    ball.vel = { ...p.vel };
    ball.z = 0;
    ball.vz = 0;
  }

  releaseBall() {
    const ball = this.ball;
    if (ball.owner !== null) {
      const owner = this.getPlayer(ball.owner);
      owner.kickCooldown = Math.max(owner.kickCooldown, 0.3);
    }
    ball.owner = null;
  }

  // Called whenever a player touches the ball (collect, kick, deflect).
  onTouch(p) {
    const ball = this.ball;
    const prevTeam = ball.lastTouchTeam;
    ball.lastTouch = p.id;
    ball.lastTouchTeam = p.team;
    if (p.offsideFlag && this.state === STATES.PLAY && !ball.unstoppable) {
      const spot = p.offsidePos || p.pos;
      this.clearOffsideFlags();
      this.stats.offsides[p.team]++;
      this.emit('offside', { playerId: p.id, team: p.team });
      const restart = foulRestart(spot, this.teams[p.team].attackDir, 1 - p.team);
      // Offside always yields an indirect free kick (never a penalty).
      this.beginSetPiece({ kind: SET_PIECES.FREE_KICK, team: 1 - p.team, pos: restart.type === SET_PIECES.PENALTY ? spot : restart.pos });
      return;
    }
    // Any touch by anyone resets offside flags for the previous phase.
    if (prevTeam !== p.team || p.id !== this.offsideKicker) this.clearOffsideFlags();
  }

  clearOffsideFlags() {
    for (const p of this.players) {
      p.offsideFlag = false;
      p.offsidePos = null;
    }
    this.offsideKicker = null;
  }

  // ------------------------------------------------------------- kicking

  // Generic kick: dir (unit), speed (m/s). opts: {vz, noOffside, kind}
  kick(p, dir, speed, opts = {}) {
    const ball = this.ball;
    const d = len(dir) > 0.01 ? norm(dir) : { x: this.teams[p.team].attackDir, y: 0 };
    ball.owner = null;
    ball.homing = null;
    ball.spin = 0;
    ball.unstoppable = false;
    ball.pos = add(p.pos, scale(d, PHYSICS.playerRadius + PHYSICS.ballRadius + 0.1));
    ball.vel = scale(d, Math.min(speed, PHYSICS.maxBallSpeed));
    ball.z = 0.05;
    ball.vz = opts.vz ?? 0;
    p.kickCooldown = PHYSICS.kickCooldown;
    p.facing = d;
    p.holdingBall = 0;
    const prevKicker = ball.lastTouch;
    ball.lastTouch = p.id;
    ball.lastTouchTeam = p.team;
    if (!opts.noOffside && this.state === STATES.PLAY) this.flagOffside(p);
    else this.clearOffsideFlags();
    this.emit('kick', { playerId: p.id, kind: opts.kind || 'kick', prevKicker });
  }

  flagOffside(kicker) {
    const team = this.teams[kicker.team];
    const mates = this.teammatesOf(kicker);
    const opps = this.opponentsOf(kicker);
    const ids = offsidePositions(kicker, mates, opps, this.ball.pos, team.attackDir);
    this.clearOffsideFlags();
    this.offsideKicker = kicker.id;
    for (const id of ids) {
      const p = this.getPlayer(id);
      p.offsideFlag = true;
      p.offsidePos = { ...p.pos };
    }
  }

  passTo(p, target, opts = {}) {
    const to = target.pos ? target : { pos: target, vel: { x: 0, y: 0 } };
    const d = dist(p.pos, to.pos);
    let speed = clamp(d * 0.62 + 6 + p.phys.passSpeedBonus * 0.6, 8, 26);
    const travel = d / speed;
    const lead = add(to.pos, scale(to.vel || { x: 0, y: 0 }, travel * 0.75));
    let dir = norm(sub(lead, p.pos));
    const err = this.rng.gaussian() * p.phys.passSpread * (opts.loft ? 1.4 : 1) * this.mathsAccuracyScale(p, opts.humanIndex);
    dir = fromAngle(angle(dir) + err);
    let vz = 0;
    if (opts.loft || d > 32) {
      vz = clamp(d * 0.16, 3, 8);
      speed = clamp(speed * 1.05, 9, 28);
    }
    this.kick(p, dir, speed, { ...opts, vz, kind: 'pass' });
  }

  shoot(p, aimY = 0, opts = {}) {
    const team = this.teams[p.team];
    const goal = goalCenter(team.attackDir);
    const target = { x: goal.x, y: goal.y + clamp(aimY, -1, 1) * (PITCH.goalWidth / 2 - 0.6) };
    let dir = norm(sub(target, p.pos));
    const err = this.rng.gaussian() * p.phys.shotSpread * this.mathsAccuracyScale(p, opts.humanIndex);
    dir = fromAngle(angle(dir) + err);
    const d = dist(p.pos, goal);
    const speed = p.phys.shotSpeed * (d > 40 ? 0.9 : 1);
    const vz = this.rng.range(0.5, 2.6) + (d > 28 ? 1.5 : 0);
    this.stats.shots[p.team]++;
    this.kick(p, dir, speed, { ...opts, vz, kind: 'shot' });
    this.emit('shot', { playerId: p.id, team: p.team });
  }

  // Ability helper: launch a homing ball. opts: {point} | {playerId}, speed, unstoppable, kind, assistFinish
  launchHoming(p, opts) {
    const ball = this.ball;
    ball.owner = null;
    ball.homing = { point: opts.point || null, playerId: opts.playerId ?? null, speed: opts.speed || 30, assistFinish: Boolean(opts.assistFinish) };
    ball.unstoppable = Boolean(opts.unstoppable);
    const target = ball.homing.point || this.getPlayer(ball.homing.playerId).pos;
    const dir = norm(sub(target, p.pos));
    ball.pos = add(p.pos, scale(dir, PHYSICS.playerRadius + 0.4));
    ball.vel = scale(dir, ball.homing.speed);
    ball.z = 0.4;
    ball.vz = 0;
    p.kickCooldown = PHYSICS.kickCooldown;
    ball.lastTouch = p.id;
    ball.lastTouchTeam = p.team;
    this.clearOffsideFlags();
    if (opts.kind === 'shot') this.stats.shots[p.team]++;
    this.emit('kick', { playerId: p.id, kind: opts.kind || 'special' });
  }

  // Choose the best pass target. aim: unit vector or null.
  choosePassTarget(p, aim, opts = {}) {
    const ranked = this.rankPassTargets(p, aim, opts);
    return ranked.length ? ranked[0].player : null;
  }

  // Every legal pass target, best first, with the score that ranked it. The
  // decision panel shows the top few; the AI just takes the first.
  rankPassTargets(p, aim, { setPiece } = {}) {
    const team = this.teams[p.team];
    const mates = this.teammatesOf(p).filter((m) => !(m.isGK && setPiece !== SET_PIECES.THROW_IN && !aim));
    const opps = this.opponentsOf(p);
    const ranked = [];
    for (const m of mates) {
      if (m.offsideFlag) continue;
      const to = sub(m.pos, p.pos);
      const d = len(to);
      if (d < 2 || d > 55) continue;
      const dir = norm(to);
      let score = 0;
      if (aim) score += dot(dir, aim) * 6;
      else score += dir.x * team.attackDir * 2.5;
      // Openness: distance of nearest opponent to receiver
      let nearOpp = Infinity;
      let laneBlocked = 0;
      for (const o of opps) {
        nearOpp = Math.min(nearOpp, dist(o.pos, m.pos));
        // lane check
        const rel = sub(o.pos, p.pos);
        const along = dot(rel, dir);
        if (along > 1 && along < d) {
          const off = Math.abs(rel.x * dir.y - rel.y * dir.x);
          if (off < 1.6) laneBlocked++;
        }
      }
      score += Math.min(nearOpp, 12) * 0.35 - laneBlocked * 3;
      score -= Math.abs(d - 18) * 0.06;
      if (m.isGK) score -= 4;
      // In assisted play the human is the protagonist: teammates look for them
      // a little more often so the human actually gets decisions to make.
      if (this.isAssisted(m) && p.human === null) score += 2.5;
      if (setPiece === SET_PIECES.KICKOFF) score = -d + (m.role === ROLES.FW || m.role === ROLES.MF ? 5 : 0);
      ranked.push({ player: m, score, distance: d, marked: nearOpp, blocked: laneBlocked });
    }
    ranked.sort((a, b) => b.score - a.score);
    return ranked;
  }


  // ------------------------------------------------------------- decisions
  //
  // In assisted control the human's footballer is driven by the same AI as
  // everyone else. The match freezes at the moments where a real player would
  // have a choice, and resumes once that choice is made.

  isAssisted(p) {
    return this.assist && p && p.human !== null && p.human !== undefined && !p.sentOff;
  }

  // Decide whether the frozen decision panel should open this frame.
  // `prevOwner` is the ball owner id at the start of the frame.
  maybeOpenDecision(prevOwner) {
    if (!this.assist || this.pendingDecision || this.state !== STATES.PLAY) return;
    const owner = this.ball.owner !== null ? this.getPlayer(this.ball.owner) : null;
    if (!owner || !this.isAssisted(owner) || owner.isGK) {
      this.decisionCarry = null;
      return;
    }
    if (prevOwner !== owner.id || !this.decisionCarry || this.decisionCarry.playerId !== owner.id) {
      this.decisionCarry = { playerId: owner.id, rangeDone: false, pressureAt: -99, lastOpen: this.time };
      this.openDecision(owner, 'possession');
      return;
    }
    const c = this.decisionCarry;
    const dGoal = dist(owner.pos, this.goalTargetFor(owner));
    const shootRange = 14 + owner.stats.shotPower * 1.3;
    if (!c.rangeDone && dGoal < shootRange) {
      c.rangeDone = true;
      this.openDecision(owner, 'shooting_range');
      return;
    }
    let nearest = Infinity;
    for (const o of this.opponentsOf(owner)) nearest = Math.min(nearest, dist(o.pos, owner.pos));
    if (nearest < DECISION.pressureDistance && this.time - c.pressureAt > DECISION.pressureGap) {
      c.pressureAt = this.time;
      this.openDecision(owner, 'pressure');
      return;
    }
    if (this.time - c.lastOpen > DECISION.carryGap) this.openDecision(owner, 'carrying');
  }

  openDecision(p, trigger, setPieceKind = null) {
    if (this.pendingDecision) return;
    if (this.decisionCarry && this.decisionCarry.playerId === p.id) this.decisionCarry.lastOpen = this.time;
    this.pendingDecision = {
      humanIndex: p.human,
      playerId: p.id,
      team: p.team,
      trigger,
      setPieceKind,
      clock: this.clockLabel(),
      options: this.buildDecisionOptions(p, setPieceKind),
    };
    this.emit('decision', { playerId: p.id, humanIndex: p.human, trigger, setPieceKind });
  }

  // The choices offered in the panel. Ids are stable so the UI stays dumb.
  buildDecisionOptions(p, setPieceKind) {
    const options = [];
    const goal = this.goalTargetFor(p);
    const dGoal = dist(p.pos, goal);
    const onTarget = Math.abs(p.pos.y - HALF_W) < 24 || dGoal < 14;
    options.push({
      id: 'shoot',
      label: 'SHOOT',
      detail: `${Math.round(dGoal)} m out`,
      quality: dGoal < 18 && onTarget ? 'good' : dGoal < 32 ? 'ok' : 'poor',
    });
    const ranked = this.rankPassTargets(p, null, { setPiece: setPieceKind }).slice(0, DECISION.passOptions);
    for (const r of ranked) {
      options.push({
        id: 'pass',
        targetId: r.player.id,
        label: `PASS #${r.player.number}`,
        detail: `${r.player.character.name} · ${Math.round(r.distance)} m${r.blocked ? ' · covered' : r.marked > 7 ? ' · free' : ''}`,
        quality: r.blocked ? 'poor' : r.marked > 7 ? 'good' : 'ok',
      });
    }
    const ability = getAbility(p.ability.id);
    const usable = !setPieceKind && p.ability.cooldown <= 0 && p.ability.usesLeft > 0
      && p.stun <= 0 && p.frozen <= 0 && (!ability.needsBall || this.ball.owner === p.id)
      && ability.canActivate(this, p);
    const specialDetail = setPieceKind || !this.isPlayActive()
      ? 'Available in open play'
      : p.stun > 0 || p.frozen > 0
        ? `${ability.name} · Recovering`
        : p.ability.cooldown > 0
          ? `${ability.name} · ${Math.ceil(p.ability.cooldown)} s`
          : Number.isFinite(p.ability.usesLeft)
            ? `${ability.name} · ${p.ability.usesLeft} left`
            : ability.name;
    options.push({
      id: 'special',
      label: ability.short || 'SPECIAL',
      detail: specialDetail,
      disabled: !usable,
      quality: 'special',
    });
    if (!setPieceKind) options.push({ id: 'dribble', label: 'DRIBBLE', detail: 'Carry on and decide later', quality: 'ok' });
    return options;
  }

  // Apply the human's choice and unfreeze. Returns true if it was applied.
  resolveDecision(choice = {}) {
    const d = this.pendingDecision;
    if (!d) return false;
    const p = this.getPlayer(d.playerId);
    const option = d.options.find((o) => o.id === choice.id && (choice.targetId === undefined || o.targetId === choice.targetId));
    if (!option || option.disabled) return false;
    // Recheck the actual action before dismissing the panel. A recovering
    // player or staged restart must not silently turn a special into a pass.
    if (choice.id === 'special' && (d.setPieceKind || !this.tryActivateAbility(p))) return false;
    this.pendingDecision = null;

    if (d.setPieceKind) {
      // The restart is still staged; play it the way the human asked.
      const target = choice.targetId !== undefined ? this.getPlayer(choice.targetId) : null;
      this.takeSetPiece(p, choice.id === 'shoot' ? 'shoot' : 'pass', null, { target });
      return true;
    }

    switch (choice.id) {
      case 'shoot':
        this.shoot(p, this.preferredShotAim(p));
        break;
      case 'pass': {
        const target = this.getPlayer(choice.targetId);
        if (target) this.passTo(p, target, {});
        else this.kick(p, p.facing, 18, {});
        break;
      }
      case 'special':
        // Already activated by the eligibility check above.
        break;
      case 'dribble':
      default:
        break;
    }
    if (this.decisionCarry) this.decisionCarry.lastOpen = this.time;
    return true;
  }

  // Aim away from where the opposing keeper is standing.
  preferredShotAim(p) {
    const gk = this.teams[1 - p.team].players.find((o) => o.isGK && !o.sentOff);
    if (!gk) return this.rng.range(-0.6, 0.6);
    return gk.pos.y > HALF_W ? -0.75 : 0.75;
  }

  // Cancel a pending decision, e.g. because the match was restarted around it.
  clearDecision() {
    this.pendingDecision = null;
    this.decisionCarry = null;
  }

  // ------------------------------------------------------------- tackling

  attemptTackle(p, slide) {
    if (p.tackleCooldown > 0 || p.stun > 0 || p.frozen > 0) return false;
    const ball = this.ball;
    if (ball.owner === null) return false;
    const owner = this.getPlayer(ball.owner);
    if (owner.team === p.team) return false;
    const range = slide ? PHYSICS.slideRange : PHYSICS.tackleRange;
    if (dist(p.pos, owner.pos) > range) return false;
    p.tackleCooldown = PHYSICS.tackleCooldown;
    if (owner.isGK && owner.holdingBall > 0) return false; // keeper protected
    if (owner.protect > 0) {
      this.emit('tackle', { playerId: p.id, victimId: owner.id, result: 'missed' });
      return false;
    }
    if (owner.untackleable > 0) {
      this.emit('tackle', { playerId: p.id, result: 'immune' });
      return false;
    }
    const fromBehind = dot(norm(sub(p.pos, owner.pos)), owner.facing) < -0.35;
    const rolls = { win: this.rng.next(), foul: this.rng.next(), card: this.rng.next() };
    const result = resolveTackle({ tackling: p.stats.tackling, strength: owner.stats.strength, slide, fromBehind }, rolls);
    if (result.won) {
      this.releaseBall();
      owner.stun = Math.max(owner.stun, 0.4);
      ball.owner = p.id;
      ball.homing = null;
      ball.unstoppable = false;
      this.snapBallToOwner(p);
      this.onTouch(p);
      this.emit('tackle', { playerId: p.id, victimId: owner.id, result: 'won' });
      return true;
    }
    if (result.foul) {
      this.commitFoul(p, owner, result.card);
      return false;
    }
    this.emit('tackle', { playerId: p.id, victimId: owner.id, result: 'missed' });
    return false;
  }

  startSlide(p) {
    if (p.sliding > 0 || p.tackleCooldown > 0 || p.stun > 0 || p.frozen > 0) return;
    p.sliding = 0.65;
    p.slideDir = len(p.facing) > 0.01 ? norm(p.facing) : { x: this.teams[p.team].attackDir, y: 0 };
    p.slideWinsBall = false;
  }

  // A sliding player touches the ball carrier.
  resolveSlideContact(q, owner) {
    if (q.slideWinsBall) {
      // Belly Slide: clean win, no foul
      q.tackleCooldown = PHYSICS.tackleCooldown;
      if (owner.isGK && owner.holdingBall > 0) return;
      this.releaseBall();
      owner.stun = Math.max(owner.stun, 0.5);
      this.ball.owner = q.id;
      this.snapBallToOwner(q);
      this.onTouch(q);
      q.sliding = 0;
      q.slideWinsBall = false;
      this.emit('tackle', { playerId: q.id, victimId: owner.id, result: 'won' });
      return;
    }
    this.attemptTackle(q, true);
  }

  commitFoul(fouler, victim, card) {
    this.stats.fouls[fouler.team]++;
    victim.stun = Math.max(victim.stun, PHYSICS.stunAfterTackled);
    const spot = { ...victim.pos };
    let sanction = null;
    if (card) {
      sanction = applyCard(fouler, card);
      const minute = this.clockLabel();
      this.cards.push({ playerId: fouler.id, team: fouler.team, card: sanction, minute });
      this.emit('card', { playerId: fouler.id, team: fouler.team, card: sanction, secondYellow: sanction === 'red' && card === 'yellow' });
      if (fouler.sentOff) this.handleSentOff(fouler);
    }
    this.emit('foul', { playerId: fouler.id, victimId: victim.id, team: fouler.team });
    const restart = foulRestart(spot, this.teams[fouler.team].attackDir, victim.team);
    this.beginSetPiece({ kind: restart.type, team: restart.team, pos: restart.pos });
  }

  handleSentOff(p) {
    this.releaseBall();
    if (this.ball.owner === p.id) this.ball.owner = null;
    p.desiredVel = { x: 0, y: 0 };
    p.vel = { x: 0, y: 0 };
    if (p.human !== null) {
      // Hand control to the nearest available outfield teammate so the human can keep playing.
      const idx = p.human;
      p.human = null;
      const mates = this.teammatesOf(p).filter((m) => !m.isGK && m.human === null).sort((a, b) => dist(a.pos, p.pos) - dist(b.pos, p.pos));
      if (mates.length) {
        mates[0].human = idx;
        this.emit('control', { humanIndex: idx, playerId: mates[0].id });
      }
    }
    p.pos = { x: -5, y: PITCH.width / 2 };
  }

  // ------------------------------------------------------------------ ball

  integrateBall(dt) {
    const ball = this.ball;
    if (ball.owner !== null) return;
    if (ball.homing) {
      const target = ball.homing.point || this.getPlayer(ball.homing.playerId).pos;
      const to = sub(target, ball.pos);
      const d = len(to);
      const dir = d > 1e-6 ? norm(to) : { x: 0, y: 0 };
      ball.vel = scale(dir, ball.homing.speed);
      const stepLen = Math.min(d, ball.homing.speed * dt);
      ball.pos = add(ball.pos, scale(dir, stepLen));
      ball.z = 0.4;
      if (ball.homing.point && d <= stepLen + 1e-6) {
        // Reached the target point: leave it there (goal detection follows).
        ball.pos = { ...target };
      }
      return;
    }
    // Vertical
    if (ball.z > 0 || ball.vz > 0) {
      ball.vz -= PHYSICS.gravity * dt;
      ball.z += ball.vz * dt;
      ball.vel = scale(ball.vel, Math.max(0, 1 - PHYSICS.ballAirDrag * dt));
      if (ball.z <= 0) {
        ball.z = 0;
        ball.vz = -ball.vz * PHYSICS.ballBounce;
        if (ball.vz < 1.0) ball.vz = 0;
        ball.vel = scale(ball.vel, 0.8);
      }
    } else {
      const speed = len(ball.vel);
      if (speed > 0) {
        const ns = Math.max(0, speed - PHYSICS.ballRollFriction * dt);
        ball.vel = scale(ball.vel, ns / speed);
      }
    }
    // Integrate a bounded turn without adding energy. Decaying spin has a
    // finite total turn (Magnus * initial spin / decay), so a drawn arc can
    // bend the kick but cannot reverse its original direction or loop.
    if (ball.spin !== 0) {
      const speed = len(ball.vel);
      const spin = clamp(ball.spin, -AIM.curlMax, AIM.curlMax);
      const decay = Math.exp(-PHYSICS.ballSpinDecay * dt);
      if (speed > 0.5) {
        const turn = PHYSICS.ballMagnus * spin * (1 - decay) / PHYSICS.ballSpinDecay;
        ball.vel = rotate(ball.vel, turn);
      }
      ball.spin = spin * decay;
      if (Math.abs(ball.spin) < 0.02) ball.spin = 0;
    }
    ball.vel = clampLen(ball.vel, PHYSICS.maxBallSpeed);
    ball.pos = add(ball.pos, scale(ball.vel, dt));
    // Goal frame: bounce off posts/bar crudely -> treat as goal line handled by rules; bounce off net back.
    // Ball hitting a player who cannot control it deflects.
    for (const p of this.players) {
      if (p.sentOff || p.kickCooldown > 0 || ball.unstoppable) continue;
      if (ball.z > 1.9) continue;
      const d = dist(p.pos, ball.pos);
      if (d < PHYSICS.playerRadius + PHYSICS.ballRadius && (p.frozen > 0 || p.stun > 0)) {
        this.deflectBall(p, 0.5);
        this.onTouch(p);
        break;
      }
    }
  }

  checkOutOfPlay() {
    const ball = this.ball;
    const teams = this.teams.map((t) => ({ index: t.index, attackDir: t.attackDir }));
    const res = classifyOutOfPlay(ball.pos, ball.z, ball.lastTouchTeam, teams);
    if (!res) return;
    if (res.type === 'goal') {
      this.scoreGoal(res.team);
      return;
    }
    this.clearOffsideFlags();
    this.emit('out', { kind: res.type, team: res.team });
    this.beginSetPiece({ kind: res.type, team: res.team, pos: res.pos });
  }

  scoreGoal(teamIdx) {
    const team = this.teams[teamIdx];
    team.score++;
    const scorer = this.ball.lastTouch !== null ? this.getPlayer(this.ball.lastTouch) : null;
    const ownGoal = scorer && scorer.team !== teamIdx;
    this.goals.push({ team: teamIdx, scorerId: scorer ? scorer.id : null, ownGoal, half: this.clock.half, minute: this.clockLabel() });
    this.emit('goal', { team: teamIdx, scorerId: scorer ? scorer.id : null, ownGoal, score: [this.teams[0].score, this.teams[1].score] });
    this.state = STATES.GOAL;
    this.goalTimer = TIMING.goalCelebration;
    this.pendingKickoffTeam = 1 - teamIdx;
    this.ball.owner = null;
    this.ball.homing = null;
    this.ball.spin = 0;
    this.ball.unstoppable = false;
    this.ball.vel = { x: 0, y: 0 };
    for (const p of this.players) p.desiredVel = { x: 0, y: 0 };
  }

  endHalf() {
    this.clock.time = this.clock.halfSeconds;
    this.ball.owner = null;
    this.ball.homing = null;
    this.ball.spin = 0;
    this.ball.vel = { x: 0, y: 0 };
    this.setPiece = null;
    if (this.clock.half === 1) {
      this.state = STATES.HALFTIME;
      this.emit('halftime', { score: [this.teams[0].score, this.teams[1].score] });
    } else {
      this.state = STATES.FULLTIME;
      this.emit('fulltime', { score: [this.teams[0].score, this.teams[1].score] });
    }
  }
}

// ---------------------------------------------------------------- helpers

function suggestionAction(match, humanIndex, suggestion) {
  if (!Number.isInteger(humanIndex) || !match.config.humans[humanIndex]
      || !match.canKick(humanIndex) || !suggestion
      || !['pass', 'shot'].includes(suggestion.kind)
      || !Number.isFinite(suggestion.point?.x) || !Number.isFinite(suggestion.point?.y)
      || (suggestion.setPieceKind ?? null) !== (match.setPiece?.kind ?? null)) return null;
  const kicker = match.setPiece ? match.getPlayer(match.setPiece.takerId) : match.getPlayer(match.ball.owner);
  if (!kicker || kicker.id !== suggestion.kickerId || kicker.sentOff || kicker.stun > 0
      || kicker.frozen > 0 || kicker.kickCooldown > 0) return null;
  if (suggestion.kind === 'pass') {
    if (match.setPiece?.kind === SET_PIECES.PENALTY) return null;
    const target = match.rankPassTargets(kicker, null, { setPiece: match.setPiece?.kind })
      .find((r) => r.player.id === suggestion.playerId)?.player;
    return target && target.stun <= 0 && target.frozen <= 0 ? { kicker, target, aimY: 0 } : null;
  }
  const goal = match.goalTargetFor(kicker);
  if (suggestion.playerId !== null || dist(suggestion.point, goal) > 1e-6) return null;
  if (match.setPiece?.kind !== SET_PIECES.PENALTY
      && (dist(kicker.pos, goal) >= 18 + kicker.stats.shotPower || !match.laneIsClear(kicker, goal))) return null;
  return { kicker, target: null, aimY: 0 };
}

// Drop near-duplicates and keep the real release point. Resample long strokes
// instead of truncating them: the endpoint, not a midway loop, names the kick.
function sanitisePath(points) {
  const out = [];
  let last = null;
  for (const p of points) {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    const q = {
      x: clamp(p.x, -AIM.pathMargin, PITCH.length + AIM.pathMargin),
      y: clamp(p.y, -AIM.pathMargin, PITCH.width + AIM.pathMargin),
    };
    last = q;
    if (out.length && dist(out[out.length - 1], q) < AIM.pathMinSpacing) continue;
    out.push(q);
  }
  if (out.length > 1) out[out.length - 1] = last;
  if (out.length > AIM.pathMaxPoints) {
    return Array.from({ length: AIM.pathMaxPoints }, (_, i) => out[Math.round(i * (out.length - 1) / (AIM.pathMaxPoints - 1))]);
  }
  return out;
}

// Slide a drawn path so it begins at the ball: the shape is what was drawn,
// the position is wherever the ball happens to be.
function anchorPath(points, start) {
  const dx = start.x - points[0].x;
  const dy = start.y - points[0].y;
  return points.map((p) => ({
    x: clamp(p.x + dx, -AIM.pathMargin, PITCH.length + AIM.pathMargin),
    y: clamp(p.y + dy, -AIM.pathMargin, PITCH.width + AIM.pathMargin),
  }));
}

function pathLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += dist(points[i - 1], points[i]);
  return total;
}

// Only a simple, mostly forward, single-sided arc suggests curl. Loops,
// zigzags and backtracking still name their endpoint, but do not add spin.
function drawnCurl(points) {
  if (points.length < 3) return 0;
  const a = points[0];
  const b = points[points.length - 1];
  const chord = sub(b, a);
  const l = len(chord);
  if (l < 2) return 0;
  if (pathLength(points) > l * 1.8) return 0;
  const dir = scale(chord, 1 / l);
  let positive = 0;
  let negative = 0;
  let previousProgress = 0;
  let backtrack = 0;
  for (const p of points) {
    const rel = sub(p, a);
    const progress = dot(rel, dir);
    if (progress < -l * 0.03 || progress > l * 1.03) return 0;
    backtrack += Math.max(0, previousProgress - progress);
    previousProgress = progress;
    // Signed perpendicular distance from the chord.
    const off = rel.x * dir.y - rel.y * dir.x;
    positive = Math.max(positive, off);
    negative = Math.max(negative, -off);
  }
  if (backtrack > l * 0.08 || Math.min(positive, negative) > Math.max(0.75, Math.max(positive, negative) * 0.2)) return 0;
  const worst = positive >= negative ? positive : -negative;
  return clamp(worst * AIM.curlPerMetre, -AIM.curlMax, AIM.curlMax);
}
