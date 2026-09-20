// Application shell: owns the screen state machine, the canvas, the fixed
// -timestep game loop and the wiring between input, match and renderer.

import { Match } from '../game/match.js';
import { normalizeConfig, defaultConfig, humanCount, MODES, CONTROL } from '../game/config.js';
import { PHYSICS, STATES } from '../game/constants.js';
import { computeLayout, computeAimLayout } from './layout.js';
import { Renderer } from './renderer.js';
import { Renderer3D } from './renderer3d.js';
import { InputManager } from './input.js';
import { AimInput } from './aiminput.js';
import { drawHud } from './hud.js';
import { showMenu, showHowTo, showSetup, showPause, showHalftime, showFullTime, showDecision } from './screens.js';

const SCREEN = { MENU: 'menu', HOWTO: 'howto', SETUP: 'setup', MATCH: 'match', DECISION: 'decision', PAUSE: 'pause', HALFTIME: 'halftime', FULLTIME: 'fulltime' };
const STORE_KEY = 'gorilla-football/setup';

export class App {
  constructor({ canvas, overlay }) {
    this.canvas = canvas;
    this.overlay = overlay;
    this.renderer = new Renderer(canvas);
    this.renderer3d = new Renderer3D(canvas);
    this.input = new InputManager(canvas);
    this.aimInput = new AimInput(canvas);
    this.match = null;
    this.setupState = loadSetup();
    this.screen = SCREEN.MENU;
    this.accumulator = 0;
    this.lastTs = 0;
    this.layout = null;
    this.resize();
    window.addEventListener('resize', () => this.resize());
    window.addEventListener('orientationchange', () => setTimeout(() => this.resize(), 250));
    this.goMenu();
    requestAnimationFrame((t) => this.frame(t));
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.floor(window.innerWidth);
    const h = Math.floor(window.innerHeight);
    this.canvas.width = Math.floor(w * dpr);
    this.canvas.height = Math.floor(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.canvas.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
    this.cssSize = { w, h };
    this.updateLayout();
  }

  updateLayout() {
    const mode = this.match ? this.match.config.mode : this.setupState.mode;
    const control = this.match ? this.match.config.control : this.setupState.control;
    const humans = this.match ? this.match.humanInputs.length : humanCount(mode);
    if (control === CONTROL.AIM) {
      this.layout = computeAimLayout(this.cssSize.w, this.cssSize.h, humans, this.viewAttackDir());
      this.renderer3d.camera.setViewport(this.layout.w, this.layout.h);
      if (this.match) this.renderer3d.updateCamera(this.match, this.layout, 1);
      this.aimInput.configure({ zones: this.layout.zones, pauseButton: this.layout.pauseBtn, camera: this.renderer3d.camera });
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
    this.aimInput.configure({ camera: this.renderer3d.camera });
    for (const r of this.aimInput.drainReleases()) {
      if (r.tap) {
        m.tap(r.human);
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
      this.renderer3d.draw(this.match, this.layout, {
        dt: this.screen === SCREEN.MATCH ? dtReal : 0,
        controlledIds,
        controlColours: ['#ffe600', '#00e5ff'],
        aim: aims[0] || null,
      });
      drawHud(this.renderer3d.ctx, this.match, this.layout, { hint: this.aimHint() });
      return;
    }
    this.renderer.draw(this.match, this.layout, {
      dt: this.screen === SCREEN.DECISION ? 0 : dtReal,
      sticks: this.input.sticks,
      pressed: this.input.pressed,
      decision: this.screen === SCREEN.DECISION ? this.match.pendingDecision : null,
    });
  }

  // One short line telling the player what their touch will do right now.
  aimHint() {
    const m = this.match;
    if (m.state === STATES.GOAL) return null;
    if (m.canKick(0)) {
      return m.state === STATES.PLAY ? 'Tap to dribble · slide to pass or shoot' : 'Slide to aim the restart';
    }
    const owner = m.ball.owner !== null ? m.getPlayer(m.ball.owner) : null;
    if (owner && owner.team !== (m.config.humans[0]?.team ?? 0)) return 'Tap to close them down';
    return null;
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
