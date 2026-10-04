import { test } from 'node:test';
import assert from 'node:assert/strict';
import { App } from '../src/ui/app.js';
import { AimInput } from '../src/ui/aiminput.js';
import { Camera } from '../src/ui/camera.js';
import { RenderState } from '../src/ui/render-state.js';
import { Match } from '../src/game/match.js';
import { normalizeConfig, CONTROL, MODES, VIEW } from '../src/game/config.js';
import { STATES, SET_PIECES, PITCH } from '../src/game/constants.js';
import { Renderer3D } from '../src/ui/renderer3d.js';

function harness({ control = CONTROL.AIM, mode = MODES.SOLO } = {}) {
  const app = Object.create(App.prototype);
  const ctx = { setTransform() {} };
  const canvas = {
    style: {}, addEventListener() {}, setPointerCapture() {}, releasePointerCapture() {},
    getBoundingClientRect: () => ({ left: 0, top: 0 }), getContext: () => ctx,
  };
  const config = normalizeConfig({ control, mode, humans: [{ characterId: 'plumber' }, { characterId: 'wizard' }] });
  const match = new Match(config);
  match.state = STATES.PLAY;
  match.setPiece = null;
  const player = match.humanPlayer(0);
  match.ball.owner = player.id;
  match.snapBallToOwner(player);
  const camera = new Camera();
  camera.setViewport(390, 844);
  camera.setView({ x: 0, y: PITCH.width / 2, z: 24 }, { x: 60, y: PITCH.width / 2, z: 0 }, 50);
  Object.assign(app, {
    canvas, hudCanvas: canvas, glCanvas: null, webgl: null,
    aimInput: new AimInput(canvas),
    input: { reset() {}, setLayout(layout) { this.layout = layout; } },
    match, screen: 'match', cssSize: { w: 390, h: 844 },
    renderer3d: { camera, updateCamera() {} },
    overlay: { hidden: true, innerHTML: '' },
    cameraTransition: null, possessionNotices: [], lastPossession: null,
    commandCues: [], lastTs: 100, accumulator: 0,
    renderState: new RenderState(),
    render() {},
  });
  app.updateLayout();
  return app;
}

const pointer = (pointerId, x, y) => ({ pointerId, clientX: x, clientY: y, preventDefault() {} });

function withAnimationFrame(fn) {
  const prior = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = () => {};
  try { fn(); } finally {
    if (prior === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = prior;
  }
}

test('special dispatch uses the actual whole-team carrier and only activates once', () => {
  const app = harness();
  const carrier = app.match.teams[0].players.find((p) => p.character.id === 'gorilla' && p.id !== app.match.humanPlayer(0).id);
  assert.ok(carrier);
  carrier.pos = { x: 45, y: 30 };
  app.match.ball.owner = carrier.id;
  app.match.snapBallToOwner(carrier);
  app.aimInput.onKey({ key: 'l' });
  app.feedAimInput();
  assert.ok(carrier.ability.cooldown > 0);
  assert.equal(app.match.stats.specials[0], 1);
  app.match.ball.owner = carrier.id;
  app.aimInput.onKey({ key: 'l' });
  app.feedAimInput();
  assert.equal(app.match.stats.specials[0], 1, 'cooldown prevents repeated activation');
});

test('a queued special cannot dispatch on a paused frame or escape into resume', () => {
  const app = harness();
  app.tickMatch = () => assert.fail('paused frame must not tick simulation');
  app.aimInput.onKey({ key: 'l' });
  app.screen = 'pause';
  withAnimationFrame(() => app.frame(200));
  assert.equal(app.match.stats.specials[0], 0);
  app.resumeMatch();
  app.feedAimInput();
  assert.equal(app.match.stats.specials[0], 0);
  assert.deepEqual(app.aimInput.drainSpecials(), []);
});

test('releasing a held kick after the carrier changes does not kick or issue a run command', () => {
  const app = harness();
  const original = app.match.ball.owner;
  app.aimInput.onDown(pointer(1, 200, 700));
  app.aimInput.onMove(pointer(1, 200, 500));
  assert.equal(app.aimInput.aimState(0).kickerId, original);
  app.match.ball.owner = app.match.teams[0].players.find((p) => p.id !== original && !p.isGK).id;
  app.aimInput.onUp(pointer(1, 200, 500));
  app.match.aimPath = () => assert.fail('stale stroke must not pass');
  app.match.aimKick = () => assert.fail('stale stroke must not shoot');
  app.match.tap = () => assert.fail('stale stroke must not issue movement');
  app.feedAimInput();
  assert.equal(app.possessionNotices[0].text, 'Ball changed · draw again');
  assert.equal(app.aimInput.hasGesture, false);
});

test('drawing a kick freezes simulation and shot-framing transitions', () => {
  const app = harness();
  app.aimInput.onDown(pointer(1, 200, 700));
  app.aimInput.onMove(pointer(1, 200, 500));
  const previous = app.layout.shooter;
  const player = app.match.activePlayerFor(0);
  player.pos = { x: 96, y: PITCH.width / 2 };
  app.updateShooter(player);
  assert.equal(app.layout.shooter, previous);
  assert.equal(app.simulationDelta(0.1), 0);
  app.aimInput.onCancel(pointer(1, 200, 500));
  app.cameraTransition = null;
  assert.equal(app.simulationDelta(0.1), 0.008);
  app.updateShooter(player);
  assert.equal(app.layout.shooter, true);
});

test('a defensive drag cannot pause the match and a held tap retains possession pacing', () => {
  const app = harness();
  app.aimInput.onDown(pointer(1, 200, 700));
  assert.equal(app.simulationDelta(0.1), 0.008, 'possession slows before drawing');
  app.aimInput.onCancel(pointer(1, 200, 700));
  app.match.ball.owner = app.match.teams[1].players[6].id;
  app.aimInput.onDown(pointer(2, 200, 700));
  app.aimInput.onMove(pointer(2, 200, 500));
  assert.equal(app.simulationDelta(0.1), 0.1, 'defending does not use kick slow motion');
});

test('possession slows immediately, while released kicks, loose balls and AI possession run normally', () => {
  const app = harness();
  assert.equal(app.aimInput.hasGesture, false);
  app.cameraTransition = {remaining: 0.72, total: 0.72, hold: 0.12};
  assert.equal(app.simulationDelta(0.1), 0.008);
  assert.equal(app.cameraTransition, null, 'camera hold must not be deferred until after the pass');
  app.match.aimPath(0, [{ x: 40, y: 34 }, { x: 50, y: 34 }]);
  assert.equal(app.simulationDelta(0.1), 0.1, 'release processes without a slow-motion delay');
  app.match.aimKicks.fill(null);
  app.match.ball.owner = null;
  assert.equal(app.simulationDelta(0.1), 0.1);
  app.match.ball.owner = app.match.teams[1].players[6].id;
  assert.equal(app.simulationDelta(0.1), 0.1);
  app.match.ball.owner = app.match.teams[0].players.find(p => p.isGK).id;
  assert.equal(app.simulationDelta(0.1), 0.1, 'AI keeper can clear normally');
});

test('either human gaining possession slows versus and shared-team play', () => {
  for (const mode of [MODES.VERSUS, MODES.COOP]) {
    const app = harness({ mode });
    const player = app.match.humanPlayer(1);
    app.match.ball.owner = player.id;
    assert.equal(app.simulationDelta(0.1), 0.008);
  }
});

test('drawing holds players and the ball still, then a released pass advances', () => {
  const app = harness();
  app.handleEvents = () => {};
  app.aimInput.onDown(pointer(1, 200, 700));
  app.aimInput.onMove(pointer(1, 240, 550));
  const ball = structuredClone(app.match.ball);
  const positions = app.match.players.map(p => ({ ...p.pos }));
  for (let i = 0; i < 120; i++) app.tickMatch(1 / 60);
  assert.deepEqual(app.match.ball, ball);
  assert.deepEqual(app.match.players.map(p => p.pos), positions);
  app.aimInput.onUp(pointer(1, 240, 550));
  app.feedAimInput();
  app.tickMatch(1 / 60);
  assert.equal(app.match.ball.owner, null);
  assert.ok(Math.hypot(app.match.ball.vel.x, app.match.ball.vel.y) > 0);
});

test('a rejected projected stroke does not fall back to a different kick', () => {
  const app = harness();
  app.aimInput.released.push({human: 0, kickerId: app.match.ball.owner, tap: false,
    path: [{x: 40, y: 34}, {x: 40.1, y: 34}], dir: {x: 1, y: 0}, power: 1});
  app.match.aimPath = () => false;
  app.match.aimKick = () => assert.fail('rejected scribble must not fire another kick');
  app.feedAimInput();
  assert.equal(app.possessionNotices[0].text, 'Draw a clear direction');
  assert.ok(app.match.ball.owner !== null);
});

test('slow-motion rendering moves on intervening frames without changing fixed physics steps', () => {
  const app = harness();
  app.handleEvents = () => {};
  const carrier = app.match.getPlayer(app.match.ball.owner);
  app.match.step = dt => {
    assert.equal(dt, 1 / 60);
    carrier.pos.x += 6 * dt;
    app.match.snapBallToOwner(carrier);
  };
  const live = [], drawn = [];
  for (let i = 0; i < 60; i++) {
    app.tickMatch(1 / 60);
    live.push(carrier.pos.x);
    drawn.push(app.renderState.view(app.match, app.accumulator / (1 / 60)).getPlayer(carrier.id).pos.x);
  }
  assert.ok(new Set(live).size <= 6, 'physics retains its slow fixed steps');
  assert.ok(new Set(drawn).size > 40, 'visible movement updates between physics steps');
  for (let i = 1; i < drawn.length; i++) {
    assert.ok(drawn[i] >= drawn[i - 1] - 1e-8);
    assert.ok(drawn[i] - drawn[i - 1] < 0.02, 'no large visible jumps');
  }
});

test('tapping the tick submits its captured suggestion and never issues a run command', () => {
  const app = harness();
  const suggestion = {kind: 'pass', playerId: 3, kickerId: app.match.ball.owner, point: {x: 35, y: 30}};
  app.suggestionMarkers = [{x: 200, y: 600, radius: 24, human: 0, suggestion}];
  app.aimInput.onDown(pointer(1, 200, 600));
  app.suggestionMarkers[0].suggestion = {...suggestion, playerId: 4};
  app.aimInput.onUp(pointer(1, 200, 600));
  let submitted;
  app.match.playSuggestion = (human, target) => { submitted = {human, target}; return true; };
  app.match.tap = () => assert.fail('tick must not turn into a run command');
  app.feedAimInput();
  assert.equal(submitted.human, 0);
  assert.equal(submitted.target.playerId, 3, 'plays the suggestion touched, not a newly ranked player');
});

test('a tick click after losing its carrier does nothing and gives feedback', () => {
  const app = harness();
  const suggestion = {kind: 'shot', playerId: null, kickerId: app.match.ball.owner, point: {x: 105, y: 34}};
  app.suggestionMarkers = [{x: 200, y: 600, radius: 24, human: 0, suggestion}];
  app.aimInput.onDown(pointer(1, 200, 600));
  app.match.ball.owner = app.match.teams[1].players[6].id;
  app.aimInput.onUp(pointer(1, 200, 600));
  app.match.playSuggestion = () => assert.fail('stale marker must not kick');
  app.match.tap = () => assert.fail('stale marker must not move');
  app.feedAimInput();
  assert.equal(app.possessionNotices[0].text, 'Ball changed · choose again');
});

test('the tick routes to the human who can play it even across a screen split', () => {
  const app = harness({mode: MODES.VERSUS});
  const carrier = app.match.humanPlayer(1);
  app.match.ball.owner = carrier.id;
  const suggestion = {kind: 'pass', playerId: 14, kickerId: carrier.id, point: {x: 70, y: 30}};
  app.suggestionMarkers = [{x: 200, y: 600, radius: 24, human: 1, suggestion}];
  app.aimInput.onDown(pointer(1, 200, 600));
  app.aimInput.onUp(pointer(1, 200, 600));
  let submitted;
  app.match.playSuggestion = (human, target) => { submitted = {human, target}; return true; };
  app.feedAimInput();
  assert.equal(submitted.human, 1);
  assert.equal(submitted.target.kickerId, carrier.id);
});

test('resize discards held kicks and queued specials before replacing the viewport', () => {
  const app = harness();
  app.aimInput.onDown(pointer(1, 200, 700));
  app.aimInput.onMove(pointer(1, 200, 500));
  app.aimInput.onKey({ key: 'l' });
  const prior = globalThis.window;
  globalThis.window = { innerWidth: 844, innerHeight: 390, devicePixelRatio: 2 };
  try { app.resize(); } finally {
    if (prior === undefined) delete globalThis.window;
    else globalThis.window = prior;
  }
  app.aimInput.onUp(pointer(1, 200, 500));
  assert.equal(app.aimInput.hasGesture, false);
  assert.deepEqual(app.aimInput.drainSpecials(), []);
  assert.deepEqual(app.aimInput.drainReleases(), []);
  assert.deepEqual(app.cssSize, { w: 844, h: 390 });
  assert.equal(app.canvas.width, 1688);
  assert.equal(app.layout.portrait, false);
});

test('decision opening reserves pitch space; closing restores normal controls', () => {
  const app = harness({ control: CONTROL.ASSISTED, mode: MODES.VERSUS });
  app.match.pendingDecision = { humanIndex: 1, options: new Array(6).fill({ id: 'pass' }) };
  app.showCurrentDecision = () => {};
  app.openDecision();
  assert.equal(app.screen, 'decision');
  assert.equal(app.layout.controls.length, 0);
  const panel = app.layout.decision.panel;
  assert.equal(panel.y, 0, 'portrait P2 dock is at the top');
  assert.ok(app.layout.pitch.y >= panel.y + panel.h);
  app.match.pendingDecision = null;
  app.closeDecision();
  assert.equal(app.screen, 'match');
  assert.equal(app.layout.decision, undefined);
  assert.equal(app.layout.controls.length, 2);
  assert.equal(app.accumulator, 0);
});

test('possession changes across a loose-ball interval notify both versus humans', () => {
  const app = harness({ mode: MODES.VERSUS });
  app.updatePossessionFeedback(0);
  assert.equal(app.possessionNotices.length, 0);
  app.match.ball.owner = null;
  app.updatePossessionFeedback(0.1);
  app.match.ball.owner = app.match.teams[1].players[6].id;
  app.updatePossessionFeedback(0.1);
  assert.equal(app.possessionNotices[0].text, 'LOST THE BALL');
  assert.equal(app.possessionNotices[1].text, 'WON THE BALL');
  app.updatePossessionFeedback(1.6);
  assert.ok(app.possessionNotices.every((n) => n.remaining <= 0));
});

test('rotating during a decision rebuilds the pitch dock and refreshes choices', () => {
  const app = harness({ control: CONTROL.ASSISTED, mode: MODES.VERSUS });
  app.match.pendingDecision = { humanIndex: 1, options: new Array(6).fill({ id: 'pass' }) };
  let shown = 0;
  app.showCurrentDecision = () => { shown++; };
  app.openDecision();
  assert.equal(app.layout.decision.panel.y, 0);
  const prior = globalThis.window;
  globalThis.window = { innerWidth: 844, innerHeight: 390, devicePixelRatio: 1 };
  try { app.resize(); } finally {
    if (prior === undefined) delete globalThis.window;
    else globalThis.window = prior;
  }
  assert.equal(shown, 2);
  assert.equal(app.layout.portrait, false);
  const panel = app.layout.decision.panel;
  assert.ok(panel.y > 0, 'landscape choices dock at bottom');
  assert.ok(app.layout.pitch.y + app.layout.pitch.h <= panel.y);
  assert.equal(app.layout.controls.length, 0);
  assert.equal(app.input.layout, app.layout);
});

test('paced decisions retry deferred maths opportunities after a held touch ends', () => {
  const app = harness({ control: CONTROL.ASSISTED });
  app.screen = 'decision';
  app.match.pendingDecision = { humanIndex: 0, options: [] };
  app.input.takePause = () => false;
  let checks = 0;
  app.mathsPractice = { nextQuestion() { checks++; return null; } };
  app.aimInput.onDown(pointer(1, 200, 700));
  withAnimationFrame(() => app.frame(116));
  assert.equal(checks, 0, 'held touch defers the maths question');
  app.aimInput.onCancel(pointer(1, 200, 700));
  withAnimationFrame(() => app.frame(132));
  assert.equal(checks, 1, 'pending decision retries when gesture ends');
  assert.equal(app.screen, 'decision');
});

test('paced maths retry yields to pause and decision closure', () => {
  for (const pause of [true, false]) {
    const app = harness({ control: CONTROL.ASSISTED });
    app.screen = 'decision';
    app.match.pendingDecision = pause ? { humanIndex: 0, options: [] } : null;
    app.input.takePause = () => pause;
    app.pause = () => { app.screen = 'pause'; };
    app.offerMathsQuestion = () => assert.fail('pause or closed decision must not offer maths');
    withAnimationFrame(() => app.frame(116));
    assert.equal(app.screen, pause ? 'pause' : 'match');
  }
});

function stageDirectKick(app, kind = SET_PIECES.FREE_KICK, team = 0) {
  const dir = app.match.teams[team].attackDir;
  const pos = { x: dir > 0 ? PITCH.length - 20 : 20, y: PITCH.width / 2 };
  app.match.beginSetPiece({ kind, team, pos });
  app.updateEye();
  return app.match.getPlayer(app.match.setPiece.takerId);
}

test('human free kicks and penalties use the taker first-person viewpoint while staging', () => {
  for (const kind of [SET_PIECES.FREE_KICK, SET_PIECES.PENALTY]) {
    for (const team of [0, 1]) {
      const app = harness({ mode: MODES.VERSUS });
      const taker = stageDirectKick(app, kind, team);
      assert.equal(app.match.ball.owner, null, 'restart is still staging');
      assert.equal(app.layout.firstPerson, true);
      assert.equal(app.layout.eyePlayer, taker, 'P2 restarts also use their taker');
      assert.equal(app.match.config.view, VIEW.BROADCAST, 'camera preference remains unchanged');
      assert.ok((app.layout.lookAt.x - taker.pos.x) * app.match.teams[team].attackDir > 0);
    }
  }
});

test('direct kick first-person viewpoint follows released ball then restores camera on possession', () => {
  for (const kind of [SET_PIECES.FREE_KICK, SET_PIECES.PENALTY]) {
    const app = harness();
    const taker = stageDirectKick(app, kind);
    app.match.snapToSetPiece();
    app.match.setPiece.lerp = 1;
    taker.kickCooldown = taker.stun = taker.frozen = 0;
    assert.equal(app.match.aimKick(0, { x: 1, y: 0 }, 0.8), true);
    app.match.applyAimInputs();
    assert.equal(app.match.setPiece, null);
    assert.equal(app.match.ball.owner, null);
    assert.equal(app.match.state, STATES.PLAY);
    app.updateEye();
    assert.equal(app.layout.firstPerson, true);
    assert.equal(app.layout.eyePlayer.id, taker.id);
    assert.deepEqual(app.layout.lookAt, app.match.ball.pos);
    app.match.ball.owner = app.match.teams[1].players[6].id;
    app.updateEye();
    assert.equal(app.layout.firstPerson, false);
    assert.equal(app.directKickCamera, null);
  }
});

test('direct kick drawing retains the first-person camera and exact gesture projection', () => {
  const app = harness();
  app.renderer3d = Object.assign(Object.create(Renderer3D.prototype), {
    camera: app.renderer3d.camera, smoothBall: null, smoothedLook: null, pose: null, shotBlend: 0,
  });
  stageDirectKick(app, SET_PIECES.PENALTY);
  app.match.snapToSetPiece();
  app.match.setPiece.lerp = 1;
  app.updateEye();
  app.renderer3d.updateCamera(app.match, app.layout, 1);
  app.aimInput.onDown(pointer(1, 200, 700));
  app.aimInput.onMove(pointer(1, 230, 500));
  const pose = { eye: { ...app.renderer3d.camera.eye }, target: { ...app.renderer3d.camera.target } };
  const path = app.aimInput.aimState(0).path;
  app.layout.aiming = app.aimInput.hasGesture;
  for (let frame = 0; frame < 30; frame++) {
    app.updateEye();
    app.renderer3d.updateCamera(app.match, app.layout, 1 / 60);
  }
  assert.equal(app.layout.firstPerson, true);
  assert.deepEqual(app.renderer3d.camera.eye, pose.eye);
  assert.deepEqual(app.renderer3d.camera.target, pose.target);
  assert.deepEqual(app.aimInput.aimState(0).path, path);
  app.aimInput.onCancel(pointer(1, 230, 500));
});

test('AI and other restarts keep the chosen camera; stoppages end the temporary viewpoint', () => {
  const app = harness();
  for (const kind of [SET_PIECES.KICKOFF, SET_PIECES.CORNER, SET_PIECES.THROW_IN]) {
    stageDirectKick(app, kind);
    assert.equal(app.layout.firstPerson, false);
  }
  stageDirectKick(app, SET_PIECES.FREE_KICK, 1);
  assert.equal(app.layout.firstPerson, false, 'solo opponent free kick stays broadcast');
  stageDirectKick(app, SET_PIECES.PENALTY);
  assert.equal(app.layout.firstPerson, true);
  app.match.setPiece = null;
  app.match.state = STATES.GOAL;
  app.updateEye();
  assert.equal(app.layout.firstPerson, false);
  assert.equal(app.directKickCamera, null);
});

test('explicit first-person preference survives the end of a direct kick viewpoint', () => {
  const app = harness();
  app.match.config.view = VIEW.FIRST;
  stageDirectKick(app);
  app.match.setPiece = null;
  app.match.state = STATES.PLAY;
  app.match.ball.owner = app.match.teams[1].players[6].id;
  app.updateEye();
  assert.equal(app.directKickCamera, null);
  assert.equal(app.layout.firstPerson, true);
});

test('entering a direct kick eases from the existing camera rather than cutting', () => {
  const app = harness();
  app.renderer3d = Object.assign(Object.create(Renderer3D.prototype), {
    camera: app.renderer3d.camera, smoothBall: null, smoothedLook: null, pose: null, shotBlend: 0,
  });
  app.renderer3d.updateCamera(app.match, app.layout, 1);
  const before = { ...app.renderer3d.camera.eye };
  stageDirectKick(app);
  app.renderer3d.updateCamera(app.match, app.layout, 1 / 60);
  const after = app.renderer3d.camera.eye;
  const moved = Math.hypot(after.x - before.x, after.y - before.y, after.z - before.z);
  assert.ok(moved > 0 && moved < 3, `first frame must ease, moved ${moved}m`);
  assert.ok(after.z > 10, 'first frame must not cut directly to head height');
});

test('spending a maths charge shows feedback in each control mode', () => {
  for (const control of [CONTROL.AIM, CONTROL.MANUAL, CONTROL.ASSISTED]) {
    const app = harness({ control });
    const floats = [];
    const renderer = { addFloat: (...args) => floats.push(args) };
    if (control === CONTROL.AIM) app.renderer3d = renderer;
    else app.renderer = renderer;
    const kicker = app.match.humanPlayer(0);
    app.handleEvents([{ type: 'mathsfocusused', humanIndex: 0, playerId: kicker.id }]);
    if (control === CONTROL.AIM) {
      assert.deepEqual(app.possessionNotices[0], {
        human: 0, text: 'Focused kick used', remaining: 1.8,
      });
      app.updatePossessionFeedback(2);
      assert.ok(app.possessionNotices[0].remaining <= 0, 'feedback expires in real time');
      assert.deepEqual(floats, []);
    } else assert.deepEqual(floats, [['Focused kick used', kicker.pos, '#ffe600']]);
  }
});
