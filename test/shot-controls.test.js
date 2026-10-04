import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Match } from '../src/game/match.js';
import { normalizeConfig } from '../src/game/config.js';
import { PHYSICS, PITCH, STATES, SET_PIECES } from '../src/game/constants.js';
import { angle, len } from '../src/game/vec.js';

function readyMatch(direction = 1, distance = 20) {
  const m = new Match(normalizeConfig({ control: 'aim', seed: 43,
    humans: [{ characterId: 'plumber' }] }));
  m.state = STATES.PLAY;
  m.setPiece = null;
  m.teams[0].attackDir = direction;
  m.teams[1].attackDir = -direction;
  // Keep the trajectory test independent of tackles and keeper decisions;
  // it still uses Match's real kick, integrator, and goal-line rules.
  for (const player of m.players) {
    player.pos = { x: 15 + player.team * 2, y: 5 };
    player.vel = { x: 0, y: 0 };
  }
  const kicker = m.humanPlayer(0);
  kicker.pos = { x: direction > 0 ? PITCH.length - distance : distance, y: PITCH.width / 2 };
  kicker.facing = { x: direction, y: 0 };
  kicker.kickCooldown = kicker.stun = kicker.frozen = 0;
  m.ball.owner = kicker.id;
  m.snapBallToOwner(kicker);
  m.rng.gaussian = () => 0;
  m.drainEvents();
  return { m, kicker, goal: { x: direction > 0 ? PITCH.length : 0, y: PITCH.width / 2 } };
}

function restart(kind = SET_PIECES.PENALTY, direction = 1) {
  const state = readyMatch(direction);
  state.m.beginSetPiece({ kind, team: 0,
    pos: { x: state.goal.x - direction * PITCH.penaltySpot, y: 34 } });
  state.m.snapToSetPiece();
  state.m.setPiece.lerp = 1;
  state.kicker = state.m.getPlayer(state.m.setPiece.takerId);
  state.m.ball.owner = state.kicker.id;
  state.m.drainEvents();
  return state;
}

function goalCrossing(m, goal) {
  const direction = Math.sign(goal.x - m.ball.pos.x);
  for (let frame = 0; frame < 600; frame++) {
    const previous = { ...m.ball.pos, z: m.ball.z };
    m.integrateBall(PHYSICS.dt);
    if ((m.ball.pos.x - goal.x) * direction >= 0) {
      const fraction = (goal.x - previous.x) / (m.ball.pos.x - previous.x);
      return { y: previous.y + (m.ball.pos.y - previous.y) * fraction,
        z: previous.z + (m.ball.z - previous.z) * fraction, speed: len(m.ball.vel) };
    }
  }
  assert.fail('placed shot did not cross the front goal plane');
}

function close(actual, expected, tolerance = 1e-8) {
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} should be near ${expected}`);
}

test('shooting controls use the front goal plane within range and only supported ready restarts', () => {
  for (const direction of [1, -1]) {
    const { m, kicker, goal } = readyMatch(direction, 38);
    assert.deepEqual(m.shootingGoal(0), goal);
    kicker.pos.x -= direction * 0.01;
    assert.equal(m.shootingGoal(0), null, 'outside 38 metres is passing control');
    kicker.pos.x = goal.x + direction;
    assert.equal(m.shootingGoal(0), null, 'the player cannot shoot back through the goal they passed');
  }
  for (const kind of Object.values(SET_PIECES)) {
    const { m } = restart(kind);
    const supported = [SET_PIECES.PENALTY, SET_PIECES.FREE_KICK].includes(kind);
    assert.equal(Boolean(m.shootingGoal(0)), supported, kind);
    m.setPiece.lerp = 0.5;
    assert.equal(m.shootingGoal(0), null, 'a walking-in taker cannot aim a shot');
  }
  const { m, kicker, goal } = readyMatch();
  for (const flag of ['stun', 'frozen', 'kickCooldown']) {
    kicker[flag] = 1;
    assert.equal(m.shootingGoal(0), null);
    kicker[flag] = 0;
  }
  for (const target of [{ ...goal, z: NaN }, { ...goal, z: -1 },
    { ...goal, z: PITCH.goalHeight + 0.1 }, { ...goal, y: 50, z: 1 },
    { ...goal, x: goal.x + 1, z: 1 }]) {
    assert.equal(m.aimShot(0, target), false);
  }
  assert.equal(m.aimShot(99, { ...goal, z: 1 }), false);
  assert.equal(m.aimKicks[0], null);
});

test('queued placed shots retain their target and score at speed in both attack directions', () => {
  for (const direction of [1, -1]) {
    for (const kind of [null, SET_PIECES.FREE_KICK, SET_PIECES.PENALTY]) {
      const { m, kicker, goal } = kind ? restart(kind, direction) : readyMatch(direction, 25);
      const requested = { ...goal, y: goal.y - 2.25, z: 1.25 };
      const target = { ...requested };
      assert.ok(m.aimShot(0, requested, 0.8));
      assert.equal(m.ball.owner, kicker.id, 'placement queues rather than kicking synchronously');
      requested.y = 60;
      requested.z = 9;
      m.applyAimInputs();
      assert.equal(m.ball.owner, null);
      assert.equal(m.setPiece, null, 'placed restart shots transition to open play');
      assert.equal(m.stats.shots[0], 1);
      const crossed = goalCrossing(m, goal);
      close(crossed.y, target.y);
      close(crossed.z, target.z, 0.01);
      assert.ok(crossed.speed > 8, 'the shot travels through the net instead of stopping at it');
      m.checkOutOfPlay();
      assert.equal(m.state, STATES.GOAL);
      assert.equal(m.teams[0].score, 1);
      assert.ok(m.drainEvents().some(e => e.type === 'shot' && e.playerId === kicker.id));
    }
  }
});

test('placed shots spend maths precision once and narrow error without adding speed or loft', () => {
  const plain = readyMatch();
  const focused = readyMatch();
  const perfect = readyMatch();
  plain.m.rng.gaussian = focused.m.rng.gaussian = () => 1;
  assert.ok(focused.m.grantMathsFocus(0, focused.kicker.id));
  for (const { m, goal } of [plain, focused, perfect]) {
    assert.ok(m.aimShot(0, { ...goal, y: goal.y + 2, z: 0.9 }, 0.8));
    m.applyAimInputs();
  }
  const error = state => Math.abs(angle(state.m.ball.vel) - angle(perfect.m.ball.vel));
  assert.ok(error(plain) > 1e-4);
  close(error(focused) / error(plain), 0.4);
  close(len(focused.m.ball.vel), len(plain.m.ball.vel));
  assert.equal(focused.m.ball.vz, plain.m.ball.vz);
  assert.equal(focused.m.hasMathsFocus(0), false);
  assert.equal(focused.m.ball.unstoppable, false);
  assert.equal(focused.m.ball.homing, null);
  assert.equal(focused.m.drainEvents().filter(e => e.type === 'mathsfocusused').length, 1);
  focused.m.applyAimInputs();
  assert.equal(focused.m.stats.shots[0], 1, 'draining the same input twice cannot fire twice');
  assert.deepEqual(focused.m.drainEvents(), []);
  for (const state of [plain, focused]) {
    state.kicker.kickCooldown = 0;
    state.m.ball.owner = state.kicker.id;
    state.m.snapBallToOwner(state.kicker);
    assert.ok(state.m.aimShot(0, { ...state.goal, y: 36, z: 0.9 }, 0.8));
    state.m.applyAimInputs();
  }
  assert.deepEqual(focused.m.ball.vel, plain.m.ball.vel, 'the next shot has normal accuracy');
});

test('stale carriers and replacement restarts drop queued shots without fallback or spending precision', () => {
  for (const scenario of ['carrier', 'restart']) {
    const { m, kicker, goal } = scenario === 'restart' ? restart() : readyMatch();
    assert.ok(m.grantMathsFocus(0, kicker.id));
    assert.ok(m.aimShot(0, { ...goal, z: 0.8 }));
    if (scenario === 'carrier') {
      const replacement = m.teams[0].players.find(p => !p.isGK && p.id !== kicker.id);
      replacement.pos = { x: 86, y: 34 };
      m.ball.owner = replacement.id;
      m.snapBallToOwner(replacement);
    } else {
      const oldRestart = m.setPiece;
      m.beginSetPiece({ kind: SET_PIECES.PENALTY, team: 0, pos: { x: 94, y: 34 } });
      m.snapToSetPiece();
      m.setPiece.lerp = 1;
      m.ball.owner = m.setPiece.takerId;
      assert.notEqual(m.setPiece, oldRestart);
    }
    m.drainEvents();
    const ballBefore = structuredClone(m.ball);
    m.applyAimInputs();
    assert.deepEqual(m.ball, ballBefore);
    assert.equal(m.stats.shots[0], 0);
    assert.ok(m.hasMathsFocus(0));
    assert.deepEqual(m.drainEvents(), []);
    assert.equal(m.aimKicks[0], null);
  }
});

test('drawing to the goal produces a driven shot while endpoints outside the net retain pass physics', () => {
  const shot = readyMatch();
  const toGoal = [{ ...shot.m.ball.pos }, { ...shot.goal }];
  const originalRoll = shot.m.planKick(shot.kicker, toGoal);
  assert.equal(originalRoll.vz, 0, 'this short drawn path previously planned a ground roll');
  assert.ok(shot.m.aimPath(0, toGoal));
  shot.m.applyAimInputs();
  assert.ok(shot.m.ball.vz > 0);
  assert.ok(len(shot.m.ball.vel) > originalRoll.speed);
  const crossed = goalCrossing(shot.m, shot.goal);
  close(crossed.y, shot.goal.y);
  close(crossed.z, 0.65, 0.01);
  assert.ok(crossed.speed > 8);
  assert.equal(shot.m.stats.shots[0], 1);

  const pass = readyMatch();
  const path = [{ ...pass.m.ball.pos }, { x: pass.goal.x, y: pass.goal.y + 14 }];
  const expected = pass.m.planKick(pass.kicker, path);
  assert.ok(pass.m.aimPath(0, path));
  pass.m.applyAimInputs();
  close(pass.m.ball.vel.x, expected.dir.x * expected.speed);
  close(pass.m.ball.vel.y, expected.dir.y * expected.speed);
  assert.equal(pass.m.ball.vz, expected.vz);
  assert.equal(pass.m.ball.spin, expected.spin);
  assert.equal(pass.m.stats.shots[0], 0);
  assert.ok(pass.m.drainEvents().some(e => e.type === 'kick' && e.kind === 'pass'));
});

test('shot suggestions select a clear corner away from the keeper and retain the displayed placement', () => {
  for (const keeperOffset of [-2, 2]) {
    const { m, kicker, goal } = readyMatch(1, 12);
    const keeper = m.teams[1].players.find(p => p.isGK);
    keeper.pos = { ...goal, y: goal.y + keeperOffset };
    const suggestion = m.suggestedTarget(0);
    assert.equal(suggestion.kind, 'shot');
    assert.equal(suggestion.point.y, goal.y - Math.sign(keeperOffset) * 2.25);
    assert.ok(m.laneIsClear(kicker, suggestion.point));
    const displayed = { ...suggestion.point };
    assert.ok(m.playSuggestion(0, suggestion));
    keeper.pos.y = goal.y - keeperOffset * 5;
    assert.notEqual(m.suggestedTarget(0).point.y, displayed.y, 'the keeper move would change a newly computed suggestion');
    suggestion.point.y = 60;
    suggestion.point.z = 9;
    assert.deepEqual(m.aimKicks[0].suggestion.point, displayed);
    m.applyAimInputs();
    const crossed = goalCrossing(m, goal);
    close(crossed.y, displayed.y);
    close(crossed.z, displayed.z, 0.01);
  }
  const { m, kicker, goal } = readyMatch(1, 12);
  const keeper = m.teams[1].players.find(p => p.isGK);
  keeper.pos = { ...goal, y: goal.y + 2 };
  const blocker = m.teams[1].players.find(p => !p.isGK);
  blocker.pos = { x: 101, y: 32.5 };
  const blockedCorner = { ...goal, y: goal.y - 2.25, z: 0.75 };
  assert.equal(m.laneIsClear(kicker, blockedCorner), false);
  const suggestion = m.suggestedTarget(0);
  assert.equal(suggestion.kind, 'shot');
  assert.notEqual(suggestion.point.y, blockedCorner.y);
  assert.ok(m.laneIsClear(kicker, suggestion.point), 'a clear lane outweighs distance from the keeper');
});

test('a drawn endpoint short of the goal line remains a ground pass while the exact line drives a shot', () => {
  for (const endpoint of [103.5, PITCH.length]) {
    const { m, kicker, goal } = readyMatch(1, 20);
    assert.equal(kicker.pos.x, 85);
    const path = [{ ...m.ball.pos }, { x: endpoint, y: goal.y }];
    const passPlan = m.planKick(kicker, path);
    assert.ok(m.aimPath(0, path));
    m.applyAimInputs();
    if (endpoint < PITCH.length) {
      assert.equal(m.stats.shots[0], 0, 'a pass in front of goal is not a shot');
      assert.equal(m.ball.vz, 0);
      close(m.ball.vel.x, passPlan.dir.x * passPlan.speed);
      close(m.ball.vel.y, passPlan.dir.y * passPlan.speed);
      for (let frame = 0; frame < 300 && len(m.ball.vel) > 0; frame++) m.integrateBall(PHYSICS.dt);
      assert.equal(len(m.ball.vel), 0);
      assert.ok(m.ball.pos.x < PITCH.length, 'a pass aimed before the goal stops without crossing it');
    } else {
      assert.ok(m.ball.vz > 0);
      assert.ok(len(m.ball.vel) > passPlan.speed);
      const crossed = goalCrossing(m, goal);
      close(crossed.z, 0.65, 0.01);
      assert.ok(crossed.speed > 8);
    }
  }
});

function looseKeeperBall({ z = 1, offset = 1.1, reacting = false, sawShot = true,
  lastTouchTeam = 0, speed = 20 } = {}) {
  const state = readyMatch();
  const { m } = state;
  const keeper = m.teams[1].players.find(player => player.isGK);
  keeper.pos = { x: 102, y: 34 };
  keeper.reactTimer = reacting ? 0.2 : 0;
  keeper.ai.sawShot = sawShot;
  keeper.kickCooldown = 0;
  m.ball.owner = null;
  m.ball.pos = { x: 102, y: 34 + offset };
  m.ball.z = z;
  m.ball.vz = 0;
  m.ball.vel = { x: speed, y: 0 };
  m.ball.lastTouchTeam = lastTouchTeam;
  // Isolate whether the keeper can reach the ball from catch/parry luck.
  m.rng.chance = () => true;
  return { ...state, keeper };
}

test('keepers reach a waist-high ball laterally but cannot claim that same ball at full stretch', () => {
  const low = looseKeeperBall({ z: 1, offset: 1.1 });
  low.m.updatePossession(PHYSICS.dt);
  assert.equal(low.m.ball.owner, low.keeper.id);
  assert.equal(low.m.stats.saves[1], 1);

  const high = looseKeeperBall({ z: 2.1, offset: 1.1 });
  const before = structuredClone(high.m.ball);
  high.m.updatePossession(PHYSICS.dt);
  assert.deepEqual(high.m.ball, before, 'high lateral shots remain live instead of teleporting into the hands');
  assert.equal(high.m.stats.saves[1], 0);
});

test('an unreacted incoming shot permits a body block but cannot trigger a lateral hand save', () => {
  const lateral = looseKeeperBall({ offset: 1.2, reacting: true });
  lateral.m.updatePossession(PHYSICS.dt);
  assert.equal(lateral.m.ball.owner, null);
  assert.equal(lateral.m.stats.saves[1], 0);

  const central = looseKeeperBall({ offset: 0.5, reacting: true });
  central.m.updatePossession(PHYSICS.dt);
  assert.equal(central.m.ball.owner, central.keeper.id, 'the ball can still strike the unreacted keeper centrally');
  assert.equal(central.m.stats.saves[1], 1);

  for (const exception of [{ lastTouchTeam: 1 }, { speed: 8 }, { sawShot: false }]) {
    const state = looseKeeperBall({ offset: 1.2, reacting: true, ...exception });
    state.m.updatePossession(PHYSICS.dt);
    assert.equal(state.m.ball.owner, state.keeper.id, 'ordinary loose balls retain hand reach');
  }
});

test('keeper reach changes preserve smothering an opponents owned dribble inside the box', () => {
  const { m, kicker } = readyMatch();
  const keeper = m.teams[1].players.find(player => player.isGK);
  kicker.pos = { x: 97, y: 34 };
  kicker.untackleable = 0;
  m.snapBallToOwner(kicker);
  keeper.pos = { x: m.ball.pos.x + 1.2, y: 34 };
  keeper.ai.sawShot = true;
  keeper.reactTimer = 0.2;
  keeper.kickCooldown = 0;
  m.rng.chance = () => assert.fail('a nearby controlled dribble is a reliable claim');
  m.updatePossession(PHYSICS.dt);
  assert.equal(m.ball.owner, keeper.id);
  assert.equal(m.stats.saves[1], 0, 'smothering a dribble is not counted as a shot save');
  assert.ok(m.drainEvents().some(event => event.type === 'claim' && event.victimId === kicker.id));
});

test('a high corner shot clears a keepers lateral full stretch while a lower shot is reachable', () => {
  for (const height of [1, 2.1]) {
    const { m, goal } = readyMatch();
    const keeper = m.teams[1].players.find(player => player.isGK);
    keeper.pos = { x: 104, y: goal.y + 1.15 };
    keeper.reactTimer = 0;
    keeper.ai.sawShot = true;
    m.rng.chance = () => true;
    assert.ok(m.aimShot(0, { ...goal, y: goal.y + 2.25, z: height }, 0.8));
    m.applyAimInputs();
    // Keep the keeper's position fixed to isolate physical hand reach; the
    // real integrator, possession resolver, and goal rules handle the ball.
    for (let frame = 0; frame < 300 && m.ball.owner === null && m.state === STATES.PLAY; frame++) {
      m.integrateBall(PHYSICS.dt);
      m.updatePossession(PHYSICS.dt);
      m.checkOutOfPlay();
    }
    if (height === 1) {
      assert.equal(m.ball.owner, keeper.id);
      assert.equal(m.teams[0].score, 0);
    } else {
      assert.equal(m.state, STATES.GOAL);
      assert.equal(m.teams[0].score, 1);
      assert.equal(m.stats.saves[1], 0);
    }
  }
});
