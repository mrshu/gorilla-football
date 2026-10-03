import { test } from 'node:test';
import assert from 'node:assert/strict';
import { App } from '../src/ui/app.js';
import { AimInput } from '../src/ui/aiminput.js';
import { Camera } from '../src/ui/camera.js';
import { RenderState } from '../src/ui/render-state.js';
import { Match } from '../src/game/match.js';
import { normalizeConfig, CONTROL, MODES } from '../src/game/config.js';
import { STATES, PITCH } from '../src/game/constants.js';

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
