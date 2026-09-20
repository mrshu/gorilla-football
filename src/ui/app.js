// Application shell: owns the screen state machine, the canvas, the fixed
// -timestep game loop and the wiring between input, match and renderer.

import { Match } from '../game/match.js';
import { normalizeConfig, defaultConfig, humanCount, MODES } from '../game/config.js';
import { PHYSICS, STATES } from '../game/constants.js';
import { computeLayout } from './layout.js';
import { Renderer } from './renderer.js';
import { InputManager } from './input.js';
import { showMenu, showHowTo, showSetup, showPause, showHalftime, showFullTime } from './screens.js';

const SCREEN = { MENU: 'menu', HOWTO: 'howto', SETUP: 'setup', MATCH: 'match', PAUSE: 'pause', HALFTIME: 'halftime', FULLTIME: 'fulltime' };
const STORE_KEY = 'gorilla-football/setup';

export class App {
  constructor({ canvas, overlay }) {
    this.canvas = canvas;
    this.overlay = overlay;
    this.renderer = new Renderer(canvas);
    this.input = new InputManager(canvas);
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
    const humans = this.match ? this.match.humanInputs.length : humanCount(mode);
    this.layout = computeLayout(this.cssSize.w, this.cssSize.h, humans, mode === MODES.COOP);
    this.input.setLayout(this.layout);
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
    this.renderer.floats = [];
    this.overlay.hidden = true;
    this.overlay.innerHTML = '';
    this.screen = SCREEN.MATCH;
    this.accumulator = 0;
    this.lastTs = 0;
  }

  pause() {
    if (this.screen !== SCREEN.MATCH) return;
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
  }

  // ------------------------------------------------------------ loop

  frame(ts) {
    requestAnimationFrame((t) => this.frame(t));
    const dtReal = this.lastTs ? Math.min(0.25, (ts - this.lastTs) / 1000) : 0;
    this.lastTs = ts;

    if (this.screen === SCREEN.MATCH) {
      if (this.input.takePause()) {
        this.pause();
      } else {
        this.tickMatch(dtReal);
      }
    }
    if (this.match) this.render(dtReal);
  }

  tickMatch(dtReal) {
    const m = this.match;
    // Feed input
    for (let i = 0; i < m.humanInputs.length; i++) {
      const r = this.input.readHuman(i);
      m.setHumanInput(i, r);
    }
    this.input.endFrame();

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

  handleEvents(events) {
    const m = this.match;
    for (const e of events) {
      switch (e.type) {
        case 'goal': {
          const t = m.teams[e.team];
          this.renderer.addFloat('GOAL!', m.ball.pos, t.jersey.primary);
          vibrate([40, 60, 120]);
          break;
        }
        case 'special':
          this.renderer.addFloat(e.text, m.getPlayer(e.playerId).pos, '#ffd54f');
          vibrate(30);
          break;
        case 'card':
          this.renderer.addFloat(e.card === 'red' ? 'RED CARD' : 'YELLOW', m.getPlayer(e.playerId).pos, e.card === 'red' ? '#ff5252' : '#ffd600');
          vibrate(e.card === 'red' ? [30, 40, 30] : 20);
          break;
        case 'offside':
          this.renderer.addFloat('OFFSIDE', m.getPlayer(e.playerId).pos, '#fff');
          break;
        case 'foul':
          this.renderer.addFloat('FOUL', m.getPlayer(e.victimId).pos, '#ffab91');
          break;
        case 'save':
          this.renderer.addFloat('SAVE', m.getPlayer(e.playerId).pos, '#b3e5fc');
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
    this.renderer.draw(this.match, this.layout, {
      dt: dtReal,
      sticks: this.input.sticks,
      pressed: this.input.pressed,
    });
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
