// Application shell: owns the screen state machine, the canvas, the fixed
// -timestep game loop and the wiring between input, match and renderer.

import { Match } from '../game/match.js';
import { normalizeConfig, defaultConfig, humanCount, MODES, CONTROL, VIEW } from '../game/config.js';
import { PHYSICS, STATES } from '../game/constants.js';
import { computeLayout, computeAimLayout } from './layout.js';
import { isInShootingRange } from './camera.js';
import { Renderer } from './renderer.js';
import { Renderer3D } from './renderer3d.js';
import { InputManager } from './input.js';
import { AimInput } from './aiminput.js';
import { drawHud } from './hud.js';
import { loadThree } from './three-loader.js';
import { RendererWebGL } from './renderer_webgl.js';
import { showMenu, showHowTo, showSetup, showPause, showHalftime, showFullTime, showDecision } from './screens.js';

const SCREEN = { MENU: 'menu', HOWTO: 'howto', SETUP: 'setup', MATCH: 'match', DECISION: 'decision', PAUSE: 'pause', HALFTIME: 'halftime', FULLTIME: 'fulltime' };
const STORE_KEY = 'gorilla-football/setup';

export class App {
  constructor({ canvas, gl, hud, overlay }) {
    this.canvas = canvas;
    // WebGL needs a canvas of its own: an element can only ever hand out one
    // kind of drawing context, and the 2D renderers claim this one.
    this.glCanvas = gl || null;
    // The HUD canvas sits on top and receives the touches, so that the 3D
    // canvas underneath can be either a 2D context or a WebGL one.
    this.hudCanvas = hud || canvas;
    this.overlay = overlay;
    this.renderer = new Renderer(canvas);
    this.renderer3d = new Renderer3D(canvas);
    this.webgl = null; // set once three.js has loaded
    this.input = new InputManager(this.hudCanvas);
    this.aimInput = new AimInput(this.hudCanvas);
    this.match = null;
    this.setupState = loadSetup();
    this.screen = SCREEN.MENU;
    this.accumulator = 0;
    this.lastTs = 0;
    this.layout = null;
    this.resize();
    this.initWebGL();
    window.addEventListener('resize', () => this.resize());
    window.addEventListener('orientationchange', () => setTimeout(() => this.resize(), 250));
    this.goMenu();
    requestAnimationFrame((t) => this.frame(t));
  }

  // Load three.js in the background. If it is not reachable, for instance on
  // a machine with no internet, the canvas renderer carries on unchanged.
  async initWebGL() {
    const THREE = await loadThree();
    if (!THREE) {
      this.webglStatus = 'unavailable';
      return;
    }
    if (!this.glCanvas) {
      this.webglStatus = 'no canvas';
      return;
    }
    try {
      this.webgl = new RendererWebGL(this.glCanvas, THREE);
      this.webglStatus = 'ready';
      this.resize();
      if (this.match) this.webgl.resetCamera(this.match, this.layout);
    } catch (err) {
      this.webgl = null;
      this.webglStatus = `failed: ${err && err.message}`;
    }
    this.updateLayerVisibility();
  }

  get pitchRenderer() {
    return this.useWebGL ? this.webgl : this.renderer3d;
  }

  // WebGL only draws the whole-team stadium view; the two top-down control
  // styles keep the flat renderer.
  get useWebGL() {
    return Boolean(this.webgl && this.isAim);
  }

  updateLayerVisibility() {
    if (!this.glCanvas) return;
    const gl = this.useWebGL;
    this.glCanvas.hidden = !gl;
    this.canvas.hidden = gl;
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.floor(window.innerWidth);
    const h = Math.floor(window.innerHeight);
    this.cssSize = { w, h };
    // The HUD canvas is always 2D, whatever the pitch is being drawn with.
    if (this.hudCanvas !== this.canvas) {
      this.hudCanvas.width = Math.floor(w * dpr);
      this.hudCanvas.height = Math.floor(h * dpr);
      this.hudCanvas.style.width = `${w}px`;
      this.hudCanvas.style.height = `${h}px`;
      this.hudCanvas.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    this.canvas.width = Math.floor(w * dpr);
    this.canvas.height = Math.floor(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.canvas.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.webgl) {
      this.glCanvas.style.width = `${w}px`;
      this.glCanvas.style.height = `${h}px`;
      this.webgl.setSize(w, h);
    }
    this.updateLayerVisibility();
    this.updateLayout();
  }

  updateLayout() {
    const mode = this.match ? this.match.config.mode : this.setupState.mode;
    const control = this.match ? this.match.config.control : this.setupState.control;
    const humans = this.match ? this.match.humanInputs.length : humanCount(mode);
    if (control === CONTROL.AIM) {
      const first = (this.match ? this.match.config.view : this.setupState.view) === VIEW.FIRST;
      this.layout = computeAimLayout(this.cssSize.w, this.cssSize.h, humans, this.viewAttackDir(), first);
      this.updateEye();
      const pitch = this.pitchRenderer;
      pitch.camera.setViewport(this.layout.w, this.layout.h);
      if (this.match) pitch.updateCamera(this.match, this.layout, 1);
      this.aimInput.configure({ zones: this.layout.zones, pauseButton: this.layout.pauseBtn, camera: pitch.camera });
      return;
    }
    this.layout = computeLayout(this.cssSize.w, this.cssSize.h, humans, mode === MODES.COOP);
    this.input.setLayout(this.layout);
  }

  // The camera looks towards the goal the first human's team is attacking.
  viewAttackDir() {
    if (!this.match) return 1;
    const team = this.match.config.humans[0]?.team ?? 0;
    return this.match.teams[team].attackDir;
  }

  get isAim() {
    return Boolean(this.match && this.match.aimControl);
  }

  // The camera goes close when your player has the ball within range of goal.
  updateShooter(player) {
    const m = this.match;
    const carrier = m.ball.owner !== null ? m.getPlayer(m.ball.owner) : null;
    const mine = carrier && player && carrier.id === player.id && !carrier.isGK;
    if (!mine || m.state !== STATES.PLAY) {
      this.layout.shooter = false;
      return;
    }
    const goal = m.goalTargetFor(carrier);
    this.layout.shooter = isInShootingRange(carrier, goal);
    if (this.layout.shooter) this.layout.shotAnchor = { carrier, goal };
  }

  // Whose eyes the first-person camera is looking through, and at what.
  // Also decides whether the broadcast camera should drop in behind a player
  // who has carried the ball into range of goal.
  updateEye() {
    if (!this.layout || !this.match) return;
    const player = this.match.activePlayerFor(0);
    this.layout.eyePlayer = player || null;
    this.updateShooter(player);
    if (!player) {
      this.layout.lookAt = { ...this.match.ball.pos };
      return;
    }
    const ball = this.match.ball;
    const haveIt = ball.owner === player.id;
    if (!haveIt) {
      // Watch the ball.
      this.layout.lookAt = { ...ball.pos };
      return;
    }
    // On the ball, look where you are going: up the pitch, nudged towards goal.
    const team = this.match.teams[player.team];
    const goal = this.match.goalTargetFor(player);
    this.layout.lookAt = {
      x: player.pos.x + team.attackDir * 18 + (goal.x - player.pos.x) * 0.15,
      y: player.pos.y + (goal.y - player.pos.y) * 0.35,
    };
  }

  // --------------------------------------------------------- screens

  goMenu() {
    this.screen = SCREEN.MENU;
    this.match = null;
    this.overlay.hidden = false;
    showMenu(this.overlay, {
      onPlay: () => this.goSetup(),
      onHowTo: () => {
        this.screen = SCREEN.HOWTO;
        showHowTo(this.overlay, () => this.goMenu());
      },
    });
  }

  goSetup() {
    this.screen = SCREEN.SETUP;
    showSetup(this.overlay, this.setupState, {
      onBack: () => this.goMenu(),
      onStart: (state) => {
        this.setupState = state;
        saveSetup(state);
        this.startMatch();
      },
    });
  }

  startMatch() {
    const cfg = normalizeConfig({ ...this.setupState, seed: (Date.now() % 2147483647) | 0 });
    this.match = new Match(cfg);
    this.updateLayout();
    this.input.reset();
    this.aimInput.reset();
    this.renderer.floats = [];
    this.renderer3d.floats = [];
    this.renderer3d.resetCamera(this.match, this.layout);
    if (this.webgl) this.webgl.resetCamera(this.match, this.layout);
    this.updateLayerVisibility();
    this.overlay.hidden = true;
    this.overlay.innerHTML = '';
    this.screen = SCREEN.MATCH;
    this.accumulator = 0;
    this.lastTs = 0;
  }

  // The match is frozen by the simulation; show the choices.
  openDecision() {
    const d = this.match.pendingDecision;
    if (!d) return;
    this.screen = SCREEN.DECISION;
    // In portrait versus the second player sits at the far end of the device.
    const flip = d.humanIndex === 1 && this.layout.portrait && !this.layout.sameSide;
    showDecision(this.overlay, this.match, d, {
      flip,
      onChoose: (choice) => {
        if (!this.match.resolveDecision(choice)) return;
        this.handleEvents(this.match.drainEvents());
        this.closeDecision();
      },
    });
  }

  closeDecision() {
    this.overlay.hidden = true;
    this.overlay.innerHTML = '';
    this.screen = SCREEN.MATCH;
    this.input.reset();
    this.lastTs = 0;
    this.accumulator = 0;
  }

  pause() {
    if (this.screen !== SCREEN.MATCH && this.screen !== SCREEN.DECISION) return;
    this.screen = SCREEN.PAUSE;
    showPause(this.overlay, this.match, {
      onResume: () => this.resumeMatch(),
      onRestart: () => this.startMatch(),
      onQuit: () => this.goMenu(),
    });
  }

  resumeMatch() {
    this.overlay.hidden = true;
    this.overlay.innerHTML = '';
    this.screen = SCREEN.MATCH;
    this.input.reset();
    this.lastTs = 0;
    if (this.match && this.match.pendingDecision) this.openDecision();
  }

  // ------------------------------------------------------------ loop

  frame(ts) {
    requestAnimationFrame((t) => this.frame(t));
    const dtReal = this.lastTs ? Math.min(0.25, (ts - this.lastTs) / 1000) : 0;
    this.lastTs = ts;

    if (this.screen === SCREEN.MATCH) {
      if (this.takePause()) {
        this.pause();
      } else {
        if (this.isAim) this.feedAimInput();
        this.tickMatch(dtReal);
        if (this.match && this.match.pendingDecision) this.openDecision();
      }
    } else if (this.screen === SCREEN.DECISION) {
      if (this.input.takePause()) this.pause();
      // If the decision went away by any route other than the panel, do not
      // strand the player on a frozen screen.
      else if (!this.match || !this.match.pendingDecision) this.closeDecision();
    }
    if (this.match) this.render(dtReal);
  }

  takePause() {
    return this.isAim ? this.aimInput.takePause() : this.input.takePause();
  }

  // Turn finished drags into kicks and taps into presses.
  feedAimInput() {
    const m = this.match;
    this.aimInput.configure({ camera: this.pitchRenderer.camera });
    for (const r of this.aimInput.drainReleases()) {
      if (r.tap) {
        // Where on the grass did they tap?
        const cam = this.pitchRenderer.camera;
        const spot = r.screen ? cam.screenToGround(r.screen.x, r.screen.y) : null;
        m.tap(r.human, spot);
        continue;
      }
      // Prefer the drawn line; fall back to a straight kick if the stroke
      // could not be resolved onto the grass.
      if (r.path && m.aimPath(r.human, anchorToBall(r.path, m.ball.pos))) continue;
      if (!m.aimKick(r.human, r.dir, r.power)) m.tap(r.human);
    }
  }

  tickMatch(dtReal) {
    const m = this.match;
    if (this.isAim) {
      this.stepMatch(dtReal);
      return;
    }
    // Feed input
    for (let i = 0; i < m.humanInputs.length; i++) {
      const r = this.input.readHuman(i);
      m.setHumanInput(i, r);
    }
    this.input.endFrame();

    this.stepMatch(dtReal);
  }

  stepMatch(dtReal) {
    const m = this.match;
    this.accumulator += dtReal;
    let steps = 0;
    while (this.accumulator >= PHYSICS.dt && steps < 6) {
      m.step(PHYSICS.dt);
      this.accumulator -= PHYSICS.dt;
      steps++;
      this.handleEvents(m.drainEvents());
      if (m.state === STATES.HALFTIME || m.state === STATES.FULLTIME) break;
    }
    if (m.state === STATES.HALFTIME && this.screen === SCREEN.MATCH) {
      this.screen = SCREEN.HALFTIME;
      showHalftime(this.overlay, m, () => {
        m.resumeSecondHalf();
        this.resumeMatch();
      });
    } else if (m.state === STATES.FULLTIME && this.screen === SCREEN.MATCH) {
      this.screen = SCREEN.FULLTIME;
      showFullTime(this.overlay, m, {
        onRematch: () => this.startMatch(),
        onMenu: () => this.goMenu(),
      });
    }
  }

  get activeRenderer() {
    return this.isAim ? this.renderer3d : this.renderer;
  }

  handleEvents(events) {
    const m = this.match;
    for (const e of events) {
      switch (e.type) {
        case 'goal': {
          const t = m.teams[e.team];
          this.activeRenderer.addFloat('GOAL!', m.ball.pos, t.jersey.primary);
          vibrate([40, 60, 120]);
          break;
        }
        case 'special':
          this.activeRenderer.addFloat(e.text, m.getPlayer(e.playerId).pos, '#ffd54f');
          vibrate(30);
          break;
        case 'card':
          this.activeRenderer.addFloat(e.card === 'red' ? 'RED CARD' : 'YELLOW', m.getPlayer(e.playerId).pos, e.card === 'red' ? '#ff5252' : '#ffd600');
          vibrate(e.card === 'red' ? [30, 40, 30] : 20);
          break;
        case 'offside':
          this.activeRenderer.addFloat('OFFSIDE', m.getPlayer(e.playerId).pos, '#fff');
          break;
        case 'foul':
          this.activeRenderer.addFloat('FOUL', m.getPlayer(e.victimId).pos, '#ffab91');
          break;
        case 'save':
          this.activeRenderer.addFloat('SAVE', m.getPlayer(e.playerId).pos, '#b3e5fc');
          break;
        case 'tackle':
          if (e.result === 'won') vibrate(12);
          break;
        default:
          break;
      }
    }
  }

  render(dtReal) {
    if (this.isAim) {
      this.layout.viewAttackDir = this.viewAttackDir();
      const controlledIds = new Set();
      const aims = [];
      for (let i = 0; i < this.match.humanInputs.length; i++) {
        const active = this.match.activePlayerFor(i);
        if (active) controlledIds.add(active.id);
        const state = this.aimInput.aimState(i);
        if (state && state.active && this.match.canKick(i)) {
          aims.push({
            ...state,
            from: this.match.ball.pos,
            path: state.path ? anchorToBall(state.path, this.match.ball.pos) : null,
            colour: i === 0 ? '#ffe600' : '#00e5ff',
          });
        }
      }
      this.updateEye();
      const pitch = this.pitchRenderer;
      const dt = this.screen === SCREEN.MATCH ? dtReal : 0;
      pitch.draw(this.match, this.layout, {
        dt,
        controlledIds,
        controlColours: ['#ffe600', '#00e5ff'],
        aim: this.useWebGL ? null : aims[0] || null,
      });
      // The line you draw and the scoreboard are painted on the overlay so
      // they look identical whichever pitch renderer is running.
      const hud = this.hudContext();
      if (hud) {
        hud.clearRect(0, 0, this.layout.w, this.layout.h);
        if (this.useWebGL) {
          // Reuse the canvas renderer's overlay drawing, pointed at the same
          // camera the WebGL scene is using so the two line up exactly.
          this.renderer3d.camera = this.webgl.camera;
          this.renderer3d.drawSuggestion(hud, this.match.suggestedTarget(0), dt);
          if (aims[0]) this.renderer3d.drawAim(hud, this.match, this.layout, { aim: aims[0] });
          this.renderer3d.drawFloats(hud, this.layout, dt);
        } else {
          this.renderer3d.drawSuggestion(hud, this.match.suggestedTarget(0), dt);
        }
        drawHud(hud, this.match, this.layout, { hint: this.aimHint() });
      }
      return;
    }
    const hud = this.hudCanvas !== this.canvas ? this.hudCanvas.getContext('2d') : null;
    if (hud) hud.clearRect(0, 0, this.layout.w, this.layout.h);
    this.renderer.draw(this.match, this.layout, {
      dt: this.screen === SCREEN.DECISION ? 0 : dtReal,
      sticks: this.input.sticks,
      pressed: this.input.pressed,
      decision: this.screen === SCREEN.DECISION ? this.match.pendingDecision : null,
    });
  }

  hudContext() {
    if (this.hudCanvas === this.canvas) return this.useWebGL ? null : this.renderer3d.ctx;
    return this.hudCanvas.getContext('2d');
  }

  // One short line telling the player what their touch will do right now.
  aimHint() {
    const m = this.match;
    if (m.state === STATES.GOAL) return null;
    if (m.canKick(0)) {
      if (m.state !== STATES.PLAY) return 'Draw to take the restart';
      return this.layout.shooter ? 'In range · draw your shot' : 'Tap to move · draw to pass or shoot';
    }
    const owner = m.ball.owner !== null ? m.getPlayer(m.ball.owner) : null;
    if (owner && owner.team !== (m.config.humans[0]?.team ?? 0)) return 'Tap where to run · tap them to tackle';
    return 'Tap where to run';
  }
}

function vibrate(pattern) {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* unsupported */
  }
}

function loadSetup() {
  const base = defaultConfig();
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      return { ...base, ...saved, teams: saved.teams || base.teams, humans: saved.humans || base.humans };
    }
  } catch {
    /* ignore corrupt storage */
  }
  return base;
}

function saveSetup(state) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch {
    /* private mode */
  }
}

// Slide a drawn path so it starts at the ball. The shape is what was drawn;
// where on the pitch it was drawn does not matter.
function anchorToBall(path, ballPos) {
  if (!path || path.length < 2) return path;
  const dx = ballPos.x - path[0].x;
  const dy = ballPos.y - path[0].y;
  return path.map((p) => ({ x: p.x + dx, y: p.y + dy }));
}
