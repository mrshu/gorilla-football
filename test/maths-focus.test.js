import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Match } from '../src/game/match.js';
import { normalizeConfig } from '../src/game/config.js';
import { STATES, SET_PIECES } from '../src/game/constants.js';
import { angle, len } from '../src/game/vec.js';

function readyMatch(control = 'aim', characterId = 'gorilla', mode = 'solo') {
  const m = new Match(normalizeConfig({ control, mode, seed: 43, humans: [{ characterId }] }));
  m.state = STATES.PLAY;
  m.setPiece = null;
  for (const p of m.players) {
    p.pos = { x: 15 + p.team * 2, y: 3 + p.slot * 3 };
    p.vel = { x: 0, y: 0 };
  }
  const kicker = m.humanPlayer(0);
  const receiver = m.teams[0].players[6];
  kicker.pos = { x: 60, y: 34 };
  kicker.facing = { x: 1, y: 0 };
  receiver.pos = { x: 78, y: 36 };
  receiver.vel = { x: 0, y: 2 };
  m.ball.owner = kicker.id;
  m.snapBallToOwner(kicker);
  m.rng.gaussian = () => 1;
  m.rng.range = (a, b) => (a + b) / 2;
  return { m, kicker, receiver };
}

function snapshot(m) {
  return { dir: angle(m.ball.vel), speed: len(m.ball.vel), vz: m.ball.vz, spin: m.ball.spin };
}

function signedAngle(a, b) {
  return Math.atan2(Math.sin(a - b), Math.cos(a - b));
}

function verifyPrecision(make, kick) {
  const plain = make();
  const focused = make();
  const perfect = make();
  assert.ok(focused.m.grantMathsFocus(0, focused.kicker.id));
  perfect.m.rng.gaussian = () => 0;
  kick(plain);
  kick(focused);
  kick(perfect);
  const a = snapshot(plain.m);
  const b = snapshot(focused.m);
  const center = snapshot(perfect.m);
  const normalError = signedAngle(a.dir, center.dir);
  const focusedError = signedAngle(b.dir, center.dir);
  assert.ok(Math.abs(normalError) > 1e-4);
  assert.ok(Math.abs(focusedError / normalError - 0.4) < 1e-8, 'focus reduces aiming error to 40%');
  assert.ok(Math.abs(a.speed - b.speed) < 1e-8, 'focus does not add speed');
  assert.equal(a.vz, b.vz, 'focus does not alter loft');
  assert.equal(a.spin, b.spin, 'focus does not alter curl');
  assert.equal(focused.m.hasMathsFocus(0), false, 'one actual kick consumes the focus');
  assert.equal(focused.m.ball.unstoppable, false);
  assert.equal(focused.m.ball.homing, null);
}

test('focused normal passes and shots use existing physics in manual and paced controls', () => {
  for (const control of ['manual', 'assisted']) {
    verifyPrecision(() => readyMatch(control), ({ m, kicker, receiver }) => m.passTo(kicker, receiver));
    verifyPrecision(() => readyMatch(control), ({ m, kicker }) => m.shoot(kicker, 0.7));
  }
});

test('focused direction kicks, drawn kicks and named suggestions reduce only their aiming error', () => {
  verifyPrecision(() => readyMatch(), ({ m }) => {
    assert.ok(m.aimKick(0, { x: 1, y: 0 }, 0.85));
    m.applyAimInputs();
  });
  verifyPrecision(() => readyMatch(), ({ m }) => {
    assert.ok(m.aimPath(0, [{ x: 60, y: 34 }, { x: 72, y: 25 }, { x: 84, y: 34 }]));
    m.applyAimInputs();
  });
  verifyPrecision(() => readyMatch(), ({ m }) => {
    const suggestion = m.suggestedTarget(0);
    assert.equal(suggestion.kind, 'pass');
    assert.ok(m.playSuggestion(0, suggestion));
    m.applyAimInputs();
  });
});

test('focus supports ready restart takers and carries through the normal restart shot', () => {
  function staged(control = 'aim') {
    const state = readyMatch(control);
    const { m } = state;
    m.beginSetPiece({ kind: SET_PIECES.PENALTY, team: 0, pos: { x: 94, y: 34 } });
    m.snapToSetPiece();
    m.setPiece.lerp = 1;
    state.kicker = m.getPlayer(m.setPiece.takerId);
    m.ball.owner = state.kicker.id;
    return state;
  }
  for (const control of ['aim', 'manual', 'assisted']) verifyPrecision(() => staged(control), ({ m, kicker }) => {
    if (control === 'aim') {
      assert.ok(m.playSuggestion(0, m.suggestedTarget(0)));
      m.applyAimInputs();
    } else m.takeSetPiece(kicker, 'shoot', { x: 0, y: 0 });
    assert.equal(m.state, STATES.PLAY);
    assert.equal(m.stats.shots[0], 1);
  });
  verifyPrecision(staged, ({ m }) => {
    assert.ok(m.aimKick(0, { x: 1, y: 0 }, 0.8));
    m.applyAimInputs();
  });
  verifyPrecision(staged, ({ m }) => {
    assert.ok(m.aimPath(0, [{ x: 94, y: 34 }, { x: 99, y: 32 }, { x: 105, y: 34 }]));
    m.applyAimInputs();
  });
});

test('granting focus validates carrier identity, human control and readiness', () => {
  for (const invalidate of [
    (m, p) => { m.ball.owner = m.teams[0].players[8].id; },
    (m, p) => { m.ball.owner = m.teams[1].players[8].id; },
    (m, p) => { p.kickCooldown = 1; },
    (m, p) => { p.stun = 1; },
    (m, p) => { p.frozen = 1; },
    (m, p) => { p.sentOff = true; },
    (m) => { m.state = STATES.GOAL; },
  ]) {
    const { m, kicker } = readyMatch();
    invalidate(m, kicker);
    assert.equal(m.grantMathsFocus(0, kicker.id), false);
    assert.ok(!m.hasMathsFocus(0));
  }
  const { m, kicker } = readyMatch();
  assert.equal(m.grantMathsFocus(99, kicker.id), false);
  assert.equal(m.grantMathsFocus(0, 999), false);
  for (const control of ['manual', 'assisted']) {
    const { m, receiver } = readyMatch(control);
    m.ball.owner = receiver.id;
    assert.equal(m.grantMathsFocus(0, receiver.id), false, 'fixed-player control cannot reward an AI teammate');
  }
  const whole = readyMatch();
  whole.m.ball.owner = whole.receiver.id;
  assert.ok(whole.m.grantMathsFocus(0, whole.receiver.id), 'whole-team mode can reward any ready human-team carrier');
  const early = readyMatch();
  early.m.beginSetPiece({ kind: SET_PIECES.KICKOFF, team: 0, pos: { x: 52.5, y: 34 } });
  assert.equal(early.m.grantMathsFocus(0, early.m.setPiece.takerId), false, 'a walking-in restart taker is not ready');
});

test('invalid queued suggestions and rejected strokes do not consume a valid focus', () => {
  const { m, kicker, receiver } = readyMatch();
  assert.ok(m.grantMathsFocus(0, kicker.id));
  assert.equal(m.aimPath(0, [{ x: 60, y: 34 }, { x: 70, y: 25 }, { x: 60, y: 34 }]), false);
  assert.equal(m.hasMathsFocus(0), true);
  assert.equal(m.aimKick(0, { x: 1, y: 0 }, NaN), false);
  assert.equal(m.hasMathsFocus(0), true);
  const marker = { kind: 'pass', playerId: receiver.id, point: { ...receiver.pos }, kickerId: kicker.id, setPieceKind: null };
  assert.ok(m.playSuggestion(0, marker));
  receiver.sentOff = true;
  m.applyAimInputs();
  assert.equal(m.ball.owner, kicker.id);
  assert.equal(m.hasMathsFocus(0), true);
});

test('a queued aimed kick invalidated by recovery does not consume focus or fire', () => {
  for (const recovery of ['stun', 'frozen']) {
    const { m, kicker } = readyMatch();
    assert.ok(m.grantMathsFocus(0, kicker.id));
    assert.ok(m.aimKick(0, { x: 1, y: 0 }, 0.5));
    kicker[recovery] = 1;
    m.applyAimInputs();
    assert.equal(m.ball.owner, kicker.id);
    assert.equal(m.hasMathsFocus(0), true);
    assert.equal(m.aimKicks[0], null);
  }
});

test('focus is consumed once and does not carry into the same player’s next possession', () => {
  const { m, kicker, receiver } = readyMatch();
  const baseline = readyMatch();
  assert.ok(m.grantMathsFocus(0, kicker.id));
  m.passTo(kicker, receiver, { humanIndex: 0 });
  assert.equal(m.hasMathsFocus(0), false);
  m.ball.owner = kicker.id;
  m.passTo(kicker, receiver, { humanIndex: 0 });
  baseline.m.passTo(baseline.kicker, baseline.receiver, { humanIndex: 0 });
  assert.deepEqual(m.ball.vel, baseline.m.ball.vel);
});

test('a banked charge survives loose balls, turnovers, teammate handoffs and restarts', () => {
  for (const lose of [
    (m) => m.releaseBall(),
    (m, p, r) => m.collectBall(r),
    (m) => m.collectBall(m.teams[1].players[6]),
    (m) => m.beginSetPiece({ kind: SET_PIECES.FREE_KICK, team: 0, pos: { x: 60, y: 34 } }),
    (m, p, r) => { m.ball.owner = r.id; m.step(0); },
    (m) => m.endHalf(),
    (m) => m.scoreGoal(1),
  ]) {
    const { m, kicker, receiver } = readyMatch();
    assert.ok(m.grantMathsFocus(0, kicker.id));
    lose(m, kicker, receiver);
    assert.equal(m.hasMathsFocus(0), true);
  }
});

test('non-kicking abilities preserve precision while intentional homing shots remain unchanged', () => {
  const { m, kicker } = readyMatch('aim', 'plumber');
  assert.ok(m.grantMathsFocus(0, kicker.id));
  assert.ok(m.tryActivateAbility(kicker));
  assert.equal(m.hasMathsFocus(0), true, 'Turbo Hop uses no aiming accuracy');
  assert.equal(m.ball.owner, kicker.id);

  const slam = readyMatch();
  assert.ok(slam.m.grantMathsFocus(0, slam.kicker.id));
  assert.ok(slam.m.tryActivateAbility(slam.kicker));
  assert.equal(slam.m.ball.unstoppable, true, 'Gorilla’s existing intentional special is unchanged');
  assert.equal(slam.m.hasMathsFocus(0), true, 'special shots preserve the saved normal kick');
});

test('whole-team rewards follow the learner across carriers and co-op input ownership', () => {
  const { m, kicker, receiver } = readyMatch('aim', 'gorilla', 'coop');
  assert.ok(m.grantMathsFocus(0, kicker.id));
  assert.equal(m.grantMathsFocus(0, kicker.id), false, 'only one charge can be banked');
  assert.ok(m.grantMathsFocus(1, kicker.id));
  m.ball.owner = receiver.id;
  receiver.kickCooldown = 0;
  assert.ok(m.aimKick(1, { x: 1, y: 0 }, 0.5));
  m.applyAimInputs();
  assert.equal(m.hasMathsFocus(1), false, 'the human issuing the kick spends their charge');
  assert.equal(m.hasMathsFocus(0), true, 'their partner keeps a separate charge');
  const uses = m.drainEvents().filter(e => e.type === 'mathsfocusused');
  assert.equal(uses.length, 1);
  assert.equal(uses[0].humanIndex, 1);
  assert.equal(uses[0].playerId, receiver.id, 'feedback identifies the actual kicker');
});

test('a co-op partner without a reward cannot spend the other learner’s charge', () => {
  const { m, kicker } = readyMatch('aim', 'gorilla', 'coop');
  assert.ok(m.grantMathsFocus(0, kicker.id));
  assert.ok(m.aimKick(1, { x: 1, y: 0 }, 0.5));
  m.applyAimInputs();
  assert.equal(m.hasMathsFocus(0), true);
  assert.equal(m.drainEvents().some(e => e.type === 'mathsfocusused'), false);
});

test('AI kicks and automatic restarts leave a banked reward available', () => {
  for (const control of ['aim', 'manual', 'assisted']) {
    const { m, kicker, receiver } = readyMatch(control);
    assert.ok(m.grantMathsFocus(0, kicker.id));
    m.ball.owner = receiver.id;
    m.passTo(receiver, kicker);
    assert.equal(m.hasMathsFocus(0), true, `${control}: an AI teammate cannot spend the charge`);
    m.beginSetPiece({ kind: SET_PIECES.PENALTY, team: 0, pos: { x: 94, y: 34 } });
    m.snapToSetPiece();
    m.setPiece.lerp = 1;
    m.takeSetPiece(m.getPlayer(m.setPiece.takerId), 'auto', null);
    assert.equal(m.hasMathsFocus(0), true, `${control}: the restart timeout cannot spend the charge`);
    assert.equal(m.drainEvents().some(e => e.type === 'mathsfocusused'), false);
  }
});

test('simultaneous manual or paced buttons cannot overwrite the kick that spends focus', () => {
  for (const control of ['manual', 'assisted']) {
    const one = readyMatch(control);
    const both = readyMatch(control);
    const controller = control === 'manual' ? 'controlHuman' : 'controlAssistedHuman';
    for (const { m, kicker, receiver } of [one, both]) {
      assert.ok(m.grantMathsFocus(0, kicker.id));
      m.choosePassTarget = () => receiver;
    }
    const input = { move: { x: 0, y: 0 }, pass: true, shoot: false, special: false };
    one.m[controller](one.kicker, input, 1 / 60);
    both.m[controller](both.kicker, { ...input, shoot: true }, 1 / 60);
    assert.deepEqual(both.m.ball.vel, one.m.ball.vel);
    assert.equal(both.m.hasMathsFocus(0), false);
    const events = both.m.drainEvents();
    assert.equal(events.filter(e => e.type === 'mathsfocusused').length, 1);
    assert.equal(events.filter(e => e.type === 'kick').length, 1);
  }
});
