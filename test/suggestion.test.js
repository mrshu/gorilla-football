import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Match } from '../src/game/match.js';
import { normalizeConfig } from '../src/game/config.js';
import { PITCH, STATES, SET_PIECES } from '../src/game/constants.js';

function openMatch() {
  const m = new Match(normalizeConfig({ control: 'aim', seed: 43 }));
  m.state = STATES.PLAY;
  m.setPiece = null;
  for (const p of m.players) {
    p.pos = { x: 15 + p.team * 2, y: 3 + p.slot * 3 };
    p.vel = { x: 0, y: 0 };
  }
  const kicker = m.teams[0].players[9];
  const receiver = m.teams[0].players[6];
  kicker.pos = { x: 40, y: 34 };
  receiver.pos = { x: 58, y: 34 };
  receiver.vel = { x: 0, y: 3 };
  m.ball.owner = kicker.id;
  m.snapBallToOwner(kicker);
  m.drainEvents();
  return { m, kicker, receiver };
}

function passMarker(m, kicker, receiver) {
  return { kind: 'pass', point: { ...receiver.pos }, playerId: receiver.id, kickerId: kicker.id, setPieceKind: m.setPiece?.kind ?? null };
}

function stageRestart(kind) {
  const state = openMatch();
  const { m } = state;
  m.beginSetPiece({ kind, team: 0, pos: kind === SET_PIECES.PENALTY ? { x: PITCH.length - PITCH.penaltySpot, y: 34 } : { x: 50, y: 0 } });
  m.snapToSetPiece();
  m.setPiece.lerp = 1;
  state.kicker = m.getPlayer(m.setPiece.takerId);
  state.receiver = m.teams[0].players.find((p) => !p.isGK && p.id !== state.kicker.id);
  state.receiver.pos = { x: Math.min(100, state.kicker.pos.x + 18), y: state.kicker.pos.y + 10 };
  m.ball.owner = state.kicker.id;
  m.drainEvents();
  return state;
}

test('playing a pass suggestion names the displayed receiver and uses normal pass lead and accuracy', () => {
  const { m, kicker, receiver } = openMatch();
  const expected = openMatch();
  const suggestion = m.suggestedTarget(0);
  assert.equal(suggestion.kind, 'pass');
  assert.equal(suggestion.playerId, receiver.id);
  assert.equal(suggestion.kickerId, kicker.id);
  assert.ok(m.playSuggestion(0, suggestion));
  assert.equal(m.ball.owner, kicker.id, 'the action waits for the next simulation frame');
  // The receiver moves after the marker was displayed; passTo should lead
  // that same receiver, rather than strike a ground kick at their old point.
  receiver.pos.y += 2;
  expected.receiver.pos.y += 2;
  expected.m.passTo(expected.kicker, expected.receiver);
  m.applyAimInputs();
  assert.deepEqual(m.ball.vel, expected.m.ball.vel);
  assert.equal(m.ball.vz, expected.m.ball.vz);
  assert.equal(m.stats.shots[0], 0);
  assert.equal(m.ball.owner, null);
  assert.ok(m.ball.vel.y > 0, 'the pass leads the moving receiver');
  assert.ok(m.drainEvents().some((e) => e.type === 'kick' && e.kind === 'pass'));
});

test('playing a shot suggestion strikes its displayed corner with normal accuracy and stats', () => {
  const { m, kicker } = openMatch();
  const expected = openMatch();
  kicker.pos = { x: 93, y: 34 };
  expected.kicker.pos = { ...kicker.pos };
  m.snapBallToOwner(kicker);
  expected.m.snapBallToOwner(expected.kicker);
  const suggestion = m.suggestedTarget(0);
  assert.equal(suggestion.kind, 'shot');
  assert.ok(m.playSuggestion(0, suggestion));
  expected.m.shootAt(expected.kicker, suggestion.point, 0.8);
  m.applyAimInputs();
  assert.deepEqual(m.ball.vel, expected.m.ball.vel);
  assert.equal(m.ball.vz, expected.m.ball.vz);
  assert.equal(m.stats.shots[0], 1);
  assert.ok(m.drainEvents().some((e) => e.type === 'shot' && e.playerId === kicker.id));
});

test('stale suggestion carriers are rejected both before queuing and before application', () => {
  for (const changeAfterQueue of [false, true]) {
    const { m, kicker, receiver } = openMatch();
    const suggestion = passMarker(m, kicker, receiver);
    if (changeAfterQueue) assert.ok(m.playSuggestion(0, suggestion));
    m.ball.owner = m.teams[0].players[8].id;
    if (!changeAfterQueue) assert.equal(m.playSuggestion(0, suggestion), false);
    m.applyAimInputs();
    assert.equal(m.ball.owner, m.teams[0].players[8].id);
    assert.deepEqual(m.drainEvents(), [], 'a stale marker must not become any other kick');
  }
});

test('invalid suggestion receivers, inputs and recovering kickers produce no fallback', () => {
  for (const invalidate of [
    (m, p, r, s) => { s.playerId = m.teams[1].players[6].id; },
    (m, p, r, s) => { s.playerId = p.id; },
    (m, p, r) => { r.sentOff = true; },
    (m, p, r) => { r.offsideFlag = true; },
    (m, p, r) => { r.frozen = 1; },
    (m, p, r) => { r.pos.x = 100; },
    (m, p) => { p.stun = 1; },
    (m, p) => { p.frozen = 1; },
    (m, p) => { p.kickCooldown = 1; },
    (m, p, r, s) => { s.kind = 'dribble'; },
    (m, p, r, s) => { s.point.x = NaN; },
    (m, p, r, s) => { delete s.kickerId; },
  ]) {
    const { m, kicker, receiver } = openMatch();
    const suggestion = passMarker(m, kicker, receiver);
    invalidate(m, kicker, receiver, suggestion);
    assert.equal(m.playSuggestion(0, suggestion), false);
    assert.equal(m.aimKicks[0], null);
    assert.equal(m.ball.owner, kicker.id);
    assert.deepEqual(m.drainEvents(), []);
  }
  const { m } = openMatch();
  assert.equal(m.playSuggestion(0, null), false);
  assert.equal(m.playSuggestion(99, m.suggestedTarget(0)), false);
});

test('queued suggestions revalidate a sent-off receiver and snapshot caller input', () => {
  const { m, kicker, receiver } = openMatch();
  const suggestion = passMarker(m, kicker, receiver);
  assert.ok(m.playSuggestion(0, suggestion));
  suggestion.kind = 'shot';
  suggestion.point.x = NaN;
  assert.equal(m.aimKicks[0].suggestion.kind, 'pass');
  assert.ok(Number.isFinite(m.aimKicks[0].suggestion.point.x));
  receiver.sentOff = true;
  m.applyAimInputs();
  assert.equal(m.ball.owner, kicker.id);
  assert.deepEqual(m.drainEvents(), []);
});

test('a suggested throw-in passes to its named receiver and preserves the offside exemption', () => {
  const { m, kicker, receiver } = stageRestart(SET_PIECES.THROW_IN);
  kicker.pos = { x: 60, y: 0 };
  receiver.pos = { x: 80, y: 20 };
  for (const p of m.teams[1].players) p.pos.x = p.isGK ? 104 : 50;
  const suggestion = passMarker(m, kicker, receiver);
  assert.ok(m.playSuggestion(0, suggestion));
  m.applyAimInputs();
  assert.equal(m.state, STATES.PLAY);
  assert.equal(m.setPiece, null);
  assert.equal(m.ball.owner, null);
  assert.equal(receiver.offsideFlag, false, 'direct throw-ins are exempt');
  assert.ok(m.drainEvents().some((e) => e.type === 'kick' && e.kind === 'pass'));
});

test('suggested open-play passes retain offside evaluation at the moment of the kick', () => {
  const { m, kicker, receiver } = openMatch();
  kicker.pos = { x: 62, y: 34 };
  receiver.pos = { x: 80, y: 34 };
  for (const p of m.teams[1].players) p.pos.x = p.isGK ? 104 : 60;
  assert.ok(m.playSuggestion(0, passMarker(m, kicker, receiver)));
  m.applyAimInputs();
  assert.equal(receiver.offsideFlag, true);
});

test('penalty suggestions take a real penalty shot and stale restart phases are rejected', () => {
  const { m, kicker } = stageRestart(SET_PIECES.PENALTY);
  const suggestion = m.suggestedTarget(0);
  assert.equal(suggestion.kind, 'shot');
  assert.equal(suggestion.setPieceKind, SET_PIECES.PENALTY);
  assert.ok(m.playSuggestion(0, suggestion));
  m.applyAimInputs();
  assert.equal(m.state, STATES.PLAY);
  assert.equal(m.stats.shots[0], 1);
  assert.ok(m.drainEvents().some((e) => e.type === 'shot' && e.playerId === kicker.id));

  const next = stageRestart(SET_PIECES.THROW_IN);
  const old = passMarker(next.m, next.kicker, next.receiver);
  assert.ok(next.m.playSuggestion(0, old));
  next.m.beginSetPiece({ kind: SET_PIECES.THROW_IN, team: 0, pos: { x: 50, y: 0 } });
  next.m.setPiece.lerp = 1;
  next.m.ball.owner = next.m.setPiece.takerId;
  next.m.drainEvents();
  next.m.applyAimInputs();
  assert.equal(next.m.state, STATES.SET_PIECE, 'a new restart must not consume the old queued marker');
  assert.deepEqual(next.m.drainEvents(), []);
});
