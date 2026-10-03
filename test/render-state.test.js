import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RenderState } from '../src/ui/render-state.js';
import { Match } from '../src/game/match.js';
import { normalizeConfig } from '../src/game/config.js';
import { PHYSICS, STATES } from '../src/game/constants.js';

function playingMatch() {
  const match = new Match(normalizeConfig({ seed: 12 }));
  match.state = STATES.PLAY;
  match.setPiece = null;
  match.ball.owner = match.humanPlayer(0).id;
  return match;
}

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

function interval() {
  const match = playingMatch();
  const player = match.humanPlayer(0);
  player.pos = { x: 40, y: 30 };
  player.facing = { x: 1, y: 0 };
  match.ball.pos = { x: 41, y: 30 };
  match.ball.z = 0;
  const state = new RenderState();
  state.capture(match);
  player.pos.x += 0.2;
  player.pos.y += 0.4;
  player.facing = { x: 0, y: 1 };
  match.ball.pos.x += 0.8;
  match.ball.pos.y += 0.2;
  match.ball.z = 0.6;
  match.time += PHYSICS.dt;
  return { match, player, state };
}

test('player, facing and airborne ball interpolate between captured and live transforms', () => {
  const { match, player, state } = interval();
  const view = state.view(match, 0.25);
  close(view.getPlayer(player.id).pos.x, 40.05);
  close(view.getPlayer(player.id).pos.y, 30.1);
  close(view.getPlayer(player.id).facing.x, Math.cos(Math.PI / 8));
  close(view.getPlayer(player.id).facing.y, Math.sin(Math.PI / 8));
  close(view.ball.pos.x, 41.2);
  close(view.ball.pos.y, 30.05);
  close(view.ball.z, 0.15);
  close(player.pos.x, 40.2);
  close(match.ball.z, 0.6);
});

test('render players agree across arrays and Match read queries while current metadata stays current', () => {
  const { match, player, state } = interval();
  player.ability.cooldown = 7;
  player.stamina = 0.3;
  match.teams[0].score = 2;
  const view = state.view(match, 0.5);
  assert.ok(view instanceof Match);
  const rendered = view.getPlayer(player.id);
  assert.equal(view.players[player.id], rendered);
  assert.equal(view.teams[player.team].players[player.slot], rendered);
  assert.equal(view.humanPlayer(0), rendered);
  assert.equal(view.activePlayerFor(0), rendered);
  assert.equal(view.possessionTeam(), player.team);
  assert.equal(rendered.ability.cooldown, 7);
  assert.equal(rendered.stamina, 0.3);
  assert.equal(view.teams[0].score, 2);
  assert.equal(view.ball.owner, match.ball.owner);
  assert.equal(view.clockLabel(), match.clockLabel());
});

test('render data is read-only and isolated, including nested state and restart Maps', () => {
  const match = new Match(normalizeConfig());
  const state = new RenderState();
  const view = state.view(match, 0.5);
  const player = view.players[0];
  assert.throws(() => { player.pos.x = 123; }, TypeError);
  assert.throws(() => { player.ability.cooldown = 123; }, TypeError);
  assert.throws(() => { view.stats.shots[0] = 123; }, TypeError);
  assert.throws(() => { view.teams[0].players.push(player); }, TypeError);
  assert.throws(() => { view.setPiece.targets.set(0, { x: 1, y: 1 }); }, TypeError);
  assert.throws(() => { view.setPiece.starts.clear(); }, TypeError);
  assert.equal(view.rng, undefined, 'render view cannot consume live RNG closures');
  const oldX = player.pos.x;
  match.players[0].pos.x += 1;
  assert.equal(player.pos.x, oldX, 'an existing view remains isolated');
  assert.equal(Object.isFrozen(match.players[0].pos), false);
  assert.equal(Object.isFrozen(match.stats.shots), false);
});

test('alpha clamps at both endpoints and NaN falls back to the live transform', () => {
  const { match, player, state } = interval();
  for (const alpha of [-Infinity, -1, 0]) close(state.view(match, alpha).getPlayer(player.id).pos.x, 40);
  for (const alpha of [1, 5, Infinity, NaN]) close(state.view(match, alpha).getPlayer(player.id).pos.x, 40.2);
});

test('heading wraps across pi using the shortest arc and stays normalized', () => {
  const match = playingMatch();
  const player = match.humanPlayer(0);
  const heading = (degrees) => ({ x: Math.cos(degrees * Math.PI / 180), y: Math.sin(degrees * Math.PI / 180) });
  player.facing = heading(179);
  const state = new RenderState();
  state.capture(match);
  player.facing = heading(-179);
  const facing = state.view(match, 0.5).getPlayer(player.id).facing;
  close(facing.x, -1);
  close(facing.y, 0);
  close(Math.hypot(facing.x, facing.y), 1);
});

test('teleporting one player snaps that player while ordinary teammates keep interpolating', () => {
  const { match, player, state } = interval();
  const other = match.players.find((p) => p.id !== player.id);
  const before = { ...other.pos };
  other.pos.x += 0.2;
  player.pos.x += 12;
  player.facing = { x: -1, y: 0 };
  match.ball.pos.x += 12;
  const view = state.view(match, 0.1);
  assert.deepEqual(view.getPlayer(player.id).pos, player.pos);
  assert.deepEqual(view.getPlayer(player.id).facing, player.facing);
  assert.deepEqual(view.ball.pos, match.ball.pos);
  close(view.getPlayer(other.id).pos.x, before.x + 0.02);
});

test('state, half, restart replacement and attack direction changes snap the complete scene', () => {
  for (const change of [
    (m) => { m.state = STATES.GOAL; },
    (m) => { m.clock.half++; },
    (m) => { m.setPiece = { kind: 'kickoff' }; },
    (m) => { m.teams[0].attackDir *= -1; },
    (m) => { m.time = -1; },
  ]) {
    const { match, player, state } = interval();
    change(match);
    const view = state.view(match, 0.1);
    assert.deepEqual(view.getPlayer(player.id).pos, player.pos);
    assert.deepEqual(view.ball.pos, match.ball.pos);
    assert.equal(view.ball.z, match.ball.z);
  }
});

test('first frame, replacement match and reset never reuse stale positions', () => {
  const { match, player, state } = interval();
  const fresh = new RenderState();
  assert.deepEqual(fresh.view(match, 0).getPlayer(player.id).pos, player.pos);
  const replacement = playingMatch();
  replacement.players[player.id].pos = { x: 18, y: 19 };
  assert.deepEqual(state.view(replacement, 0).getPlayer(player.id).pos, { x: 18, y: 19 });
  state.reset();
  assert.deepEqual(state.view(match, 0).getPlayer(player.id).pos, player.pos);
});

test('several physics steps retain only the latest interval; repeated alpha is stable', () => {
  const { match, player, state } = interval();
  state.capture(match);
  player.pos.x += 0.2;
  match.time += PHYSICS.dt;
  const a = state.view(match, 0.5);
  const b = state.view(match, 0.5);
  close(a.getPlayer(player.id).pos.x, 40.3);
  assert.deepEqual(a.getPlayer(player.id).pos, b.getPlayer(player.id).pos);
});

test('8 percent simulation speed produces smooth render updates between sparse fixed steps', () => {
  const match = playingMatch();
  const player = match.humanPlayer(0);
  const state = new RenderState();
  let accumulator = 0;
  const raw = new Set();
  const rendered = new Set();
  for (let frame = 0; frame < 60; frame++) {
    accumulator += PHYSICS.dt * 0.08;
    while (accumulator >= PHYSICS.dt) {
      state.capture(match);
      player.pos.x += 6 * PHYSICS.dt;
      match.time += PHYSICS.dt;
      accumulator -= PHYSICS.dt;
    }
    raw.add(player.pos.x.toFixed(6));
    rendered.add(state.view(match, accumulator / PHYSICS.dt).getPlayer(player.id).pos.x.toFixed(6));
  }
  assert.equal(raw.size, 5, 'only four physics updates over one wall-clock second');
  assert.ok(rendered.size > 40, `render must move between physics steps: ${rendered.size} distinct positions`);
});

test('creating many render views leaves simulation data and seeded random sequence unchanged', () => {
  const match = playingMatch();
  const control = playingMatch();
  const state = new RenderState();
  state.capture(match);
  match.step(PHYSICS.dt);
  control.step(PHYSICS.dt);
  const before = JSON.stringify(match);
  for (let frame = 0; frame < 30; frame++) {
    const view = state.view(match, frame / 30);
    view.activePlayerFor(0);
    view.goalTargetFor(view.humanPlayer(0));
    view.suggestedTarget(0);
  }
  assert.equal(JSON.stringify(match), before);
  close(match.rng.next(), control.rng.next());
});
