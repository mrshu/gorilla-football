// Application shell: owns the screen state machine, the canvas, the fixed
// -timestep game loop and the wiring between input, match and renderer.

import { Match } from '../game/match.js';
import { MathsPractice } from '../game/maths-practice.js';
import { normalizeConfig, defaultConfig, humanCount, MODES, CONTROL, VIEW } from '../game/config.js';
import { PHYSICS, STATES, SET_PIECES, AIM } from '../game/constants.js';
import { computeLayout, computeAimLayout } from './layout.js';
import { computeDecisionLayout } from './decision-layout.js';
import { isInShootingRange } from './camera.js';
import { Renderer } from './renderer.js';
import { Renderer3D } from './renderer3d.js';
import { InputManager } from './input.js';
import { AimInput } from './aiminput.js';
import { RenderState } from './render-state.js';
import { drawHud, getSpecialState } from './hud.js';
import { showMathsQuiz } from './maths-quiz.js';
import { loadThree } from './three-loader.js';
import { RendererWebGL } from './renderer_webgl.js';
import { showMenu, showHowTo, showSetup, showPause, showHalftime, showFullTime, showDecision } from './screens.js';

const SCREEN = { MENU: 'menu', HOWTO: 'howto', SETUP: 'setup', MATCH: 'match', DECISION: 'decision', MATHS: 'maths', PAUSE: 'pause', HALFTIME: 'halftime', FULLTIME: 'fulltime' };
const STORE_KEY = 'gorilla-football/setup';
const CAMERA_TRANSITION_SECONDS = 0.72;
const CAMERA_TRANSITION_HOLD = 0.12;
const POSSESSION_TIME_SCALE = 0.08;

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
    this.cameraTransition = null;
    this.directKickCamera = null;
    this.possessionNotices = [];
    this.lastPossession = null;
    this.commandCues = [];
    this.suggestionMarkers = [];
    this.renderState = new RenderState();
    this.frameSimulationDt = 0;
    this.mathsPractice = new MathsPractice({ storage: safeStorage() });
    this.mathsQuiz = null;
    this.mathsOpportunity = null;
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
    this.suggestionMarkers = [];
    // A screen rotation invalidates the pixels a held stroke was drawn in.
    this.aimInput.reset();
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
    if (this.screen === SCREEN.DECISION) this.showCurrentDecision();
    if (this.screen === SCREEN.MATHS && this.mathsOpportunity) {
      const flip = this.mathsOpportunity.humanIndex === 1 && h > w && this.match.config.mode === MODES.VERSUS;
      this.overlay.classList.toggle('maths-quiz-flip', flip);
    }
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
      this.aimInput.configure({
        zones: this.layout.zones,
        pauseButton: this.layout.pauseBtn,
        camera: pitch.camera,
        specialButtons: this.layout.specialButtons,
        getKickOwner: (human) => this.kickOwnerFor(human),
        getSuggestionAt: (point, human) => this.suggestionAt(point, human),
        getShootingGoal: (human) => this.match?.shootingGoal(human),
      });
      return;
    }
    const decision = this.screen === SCREEN.DECISION ? this.match?.pendingDecision : null;
    const flip = Boolean(decision && decision.humanIndex === 1 && this.cssSize.h > this.cssSize.w && mode !== MODES.COOP);
    const dock = decision ? computeDecisionLayout(this.cssSize.w, this.cssSize.h, decision.options.length, { flip }) : null;
    this.layout = computeLayout(this.cssSize.w, this.cssSize.h, humans, mode === MODES.COOP, dock);
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
    if (this.isHoldingKick()) return;
    const m = this.match;
    const carrier = m.ball.owner !== null ? m.getPlayer(m.ball.owner) : null;
    const mine = carrier && player && carrier.id === player.id && !carrier.isGK;
    const wasShooter = Boolean(this.layout.shooter);
    if (!mine || m.state !== STATES.PLAY) {
      this.layout.shooter = false;
      if (wasShooter && m.state === STATES.PLAY) this.beginCameraTransition(false);
      return;
    }
    const goal = m.goalTargetFor(carrier);
    this.layout.shooter = isInShootingRange(carrier, goal);
    if (this.layout.shooter) this.layout.shotAnchor = { carrier, goal };
    if (wasShooter !== this.layout.shooter) this.beginCameraTransition(this.layout.shooter);
  }

  // A camera move is a gameplay beat: briefly hold the action, then let it
  // continue in slow motion while the shot framing settles.
  beginCameraTransition(toShot) {
    this.cameraTransition = {
      remaining: CAMERA_TRANSITION_SECONDS,
      total: CAMERA_TRANSITION_SECONDS,
      hold: CAMERA_TRANSITION_HOLD,
      toShot,
    };
  }

  simulationDelta(dtReal) {
    // Slow immediately on possession, before the player starts drawing.
    // A held kick freezes play; a released kick must advance immediately.
    const released = this.match.aimKicks.some(Boolean);
    const drawing = this.isDrawingKick();
    const choosing = this.isChoosingKick();
    const running = this.match.humanInputs.some((_, human) => this.match.isCarryingRun(human));
    // Possession pacing replaces the automatic camera beat, so an old camera
    // hold cannot unexpectedly pause the ball after the kick is released.
    if (released || drawing || choosing || running) this.cameraTransition = null;
    if (released) return dtReal;
    if (drawing) return 0;
    if (choosing) return dtReal * POSSESSION_TIME_SCALE;
    const transition = this.cameraTransition;
    if (!transition || dtReal <= 0) return dtReal;
    const elapsed = transition.total - transition.remaining;
    transition.remaining = Math.max(0, transition.remaining - dtReal);
    if (transition.remaining <= 0) this.cameraTransition = null;
    if (elapsed < transition.hold) return 0;
    const ramp = Math.min(1, (elapsed - transition.hold) / (transition.total - transition.hold));
    return dtReal * (0.18 + ramp * 0.32);
  }

  // Whose eyes the first-person camera is looking through, and at what.
  // Also decides whether the broadcast camera should drop in behind a player
  // who has carried the ball into range of goal.
  updateEye(m = this.match, updateFraming = true) {
    if (!this.layout || !this.match) return;
    const directKicker = this.directKickPlayer(m);
    this.layout.firstPerson = this.match.config.view === VIEW.FIRST || Boolean(directKicker);
    const player = directKicker || m.activePlayerFor(0);
    this.layout.eyePlayer = player || null;
    if (updateFraming) this.updateShooter(player);
    if (!player) {
      this.layout.lookAt = { ...m.ball.pos };
      return;
    }
    const ball = m.ball;
    const haveIt = ball.owner === player.id || (directKicker && this.match.setPiece);
    if (!haveIt) {
      // Watch the ball.
      this.layout.lookAt = { ...ball.pos };
      return;
    }
    // On the ball, look where you are going: up the pitch, nudged towards goal.
    const team = m.teams[player.team];
    const goal = m.goalTargetFor(player);
    this.layout.lookAt = {
      x: player.pos.x + team.attackDir * 18 + (goal.x - player.pos.x) * 0.15,
      y: player.pos.y + (goal.y - player.pos.y) * 0.35,
    };
  }

  directKickPlayer(view = this.match) {
    const m = this.match;
    const restart = m.setPiece;
    const direct = m.state === STATES.SET_PIECE && restart
      && [SET_PIECES.FREE_KICK, SET_PIECES.PENALTY].includes(restart.kind)
      && m.config.humans.some((human) => human.team === restart.team);
    if (direct) {
      this.directKickCamera = { match: m, playerId: restart.takerId };
    } else if (this.directKickCamera) {
      // Follow the released kick from its taker until the next possession or
      // stoppage. A different restart must never reuse an old kicker's eyes.
      const context = this.directKickCamera;
      if (context.match !== m || m.state !== STATES.PLAY || restart || m.ball.owner !== null) {
        this.directKickCamera = null;
      }
    }
    return this.directKickCamera ? view.getPlayer(this.directKickCamera.playerId) : null;
  }

  // --------------------------------------------------------- screens

  goMenu() {
    this.directKickCamera = null;
    this.mathsQuiz?.cleanup();
    this.mathsQuiz = null;
    this.mathsOpportunity = null;
    this.suggestionMarkers = [];
    this.aimInput.reset();
    this.aimInput.configure({ specialButtons: [] });
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
    this.directKickCamera = null;
    this.mathsQuiz?.cleanup();
    this.mathsQuiz = null;
    this.mathsOpportunity = null;
    const cfg = normalizeConfig({ ...this.setupState, seed: (Date.now() % 2147483647) | 0 });
    this.match = new Match(cfg);
    this.mathsPractice?.configure(cfg);
    this.screen = SCREEN.MATCH;
    this.aimInput.reset();
    this.possessionNotices = [];
    this.lastPossession = null;
    this.commandCues = [];
    this.suggestionMarkers = [];
    this.renderState?.reset();
    this.frameSimulationDt = 0;
    this.updateLayout();
    this.input.reset();
    this.aimInput.reset();
    this.renderer.floats = [];
    this.renderer3d.floats = [];
    this.renderer3d.resetCamera(this.match, this.layout);
    if (this.webgl) this.webgl.resetCamera(this.match, this.layout);
    this.cameraTransition = null;
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
    this.input.reset();
    this.updateLayout();
    this.showCurrentDecision();
  }

  showCurrentDecision() {
    const d = this.match?.pendingDecision;
    if (!d) return;
    // In portrait versus the second player sits at the far end of the device.
    const flip = d.humanIndex === 1 && this.layout.portrait && !this.layout.sameSide;
    showDecision(this.overlay, this.match, d, {
      flip,
      layout: this.layout.decision,
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
    this.updateLayout();
    this.input.reset();
    this.lastTs = 0;
    this.accumulator = 0;
  }

  pause() {
    if (this.screen !== SCREEN.MATCH && this.screen !== SCREEN.DECISION) return;
    this.screen = SCREEN.PAUSE;
    this.suggestionMarkers = [];
    this.aimInput.reset();
    this.aimInput.configure({ specialButtons: [] });
    this.input.reset();
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
    this.aimInput.reset();
    this.updateLayout();
    this.lastTs = 0;
    if (this.match && this.match.pendingDecision) this.openDecision();
  }

  offerMathsQuestion() {
    if (![SCREEN.MATCH, SCREEN.DECISION].includes(this.screen) || !this.mathsPractice) return;
    if (this.match.humanInputs.some((_, human) => this.match.isCarryingRun(human))) return;
    if (this.aimInput.hasGesture || this.match.aimKicks.some(Boolean)) return;
    const opportunity = this.mathsPractice.nextQuestion(this.match);
    if (!opportunity) return;
    this.mathsOpportunity = opportunity;
    this.screen = SCREEN.MATHS;
    this.input.reset();
    this.aimInput.reset();
    this.aimInput.configure({ specialButtons: [] });
    this.suggestionMarkers = [];
    this.frameSimulationDt = 0;
    const flip = opportunity.humanIndex === 1 && this.layout.portrait && this.match.config.mode === MODES.VERSUS;
    this.mathsQuiz = showMathsQuiz(this.overlay, opportunity.question, {
      humanIndex: opportunity.humanIndex,
      flip,
      onAnswer: (correct, elapsedMs) => {
        if (this.mathsOpportunity !== opportunity) return;
        this.mathsPractice.answer(opportunity, correct, elapsedMs);
        if (correct) this.match.grantMathsFocus(opportunity.humanIndex, opportunity.kickerId);
      },
      onSkip: () => {
        this.mathsPractice.skip(opportunity);
        this.finishMathsQuestion();
      },
      onContinue: () => this.finishMathsQuestion(),
    });
  }

  finishMathsQuestion() {
    this.mathsQuiz?.cleanup();
    this.mathsQuiz = null;
    this.mathsOpportunity = null;
    this.resumeMatch();
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
        // Detect a new shot framing before advancing the simulation so the
        // first frame of a camera move gets the slow-motion treatment.
        if (this.isAim) this.updateEye();
        if (this.isAim) this.feedAimInput();
        this.tickMatch(dtReal);
        if (this.match && this.match.pendingDecision) this.openDecision();
        this.offerMathsQuestion();
      }
    } else if (this.screen === SCREEN.DECISION) {
      if (this.input.takePause()) this.pause();
      // If the decision went away by any route other than the panel, do not
      // strand the player on a frozen screen.
      else if (!this.match || !this.match.pendingDecision) this.closeDecision();
      // A held joystick can defer the first offer on the opening frame.
      // Retry once the touch ends while the decision still freezes play.
      else this.offerMathsQuestion();
    }
    if (this.match) this.render(dtReal);
  }

  takePause() {
    return this.isAim ? this.aimInput.takePause() : this.input.takePause();
  }

  // Turn finished drags into kicks and taps into presses.
  feedAimInput() {
    const m = this.match;
    this.aimInput.configure({ camera: this.pitchRenderer.camera,
      specialButtons: this.layout.specialButtons.map((button) => ({ ...button, enabled: getSpecialState(m, button.human).enabled })),
    });
    for (const human of this.aimInput.drainSpecials()) {
      const state = getSpecialState(m, human);
      if (state.enabled) m.tryActivateAbility(m.getPlayer(state.playerId));
    }
    for (const r of this.aimInput.drainReleases()) {
      if (r.tap) {
        if (r.suggestion) {
          if (r.kickerId !== this.kickOwnerFor(r.human)) {
            this.possessionNotices[r.human] = { human: r.human, text: 'Ball changed · choose again', remaining: 1.4 };
          } else if (r.suggestion.kind === 'run') {
            if (m.playRun(r.human, r.suggestion)) {
              this.commandCues[r.human] = { point: { ...m.moveOrders[r.human].point }, text: 'RUN', remaining: 1.2 };
            } else this.possessionNotices[r.human] = { human: r.human, text: 'Run blocked · choose again', remaining: 1.4 };
          } else if (!m.playSuggestion(r.human, r.suggestion)) {
            this.possessionNotices[r.human] = { human: r.human, text: 'Suggestion no longer available', remaining: 1.4 };
          }
          continue;
        }
        // Where on the grass did they tap?
        const cam = this.pitchRenderer.camera;
        const spot = r.ground !== undefined ? r.ground : r.screen ? cam.screenToGround(r.screen.x, r.screen.y) : null;
        if (m.tap(r.human, spot) && spot) {
          const owner = m.ball.owner === null ? null : m.getPlayer(m.ball.owner);
          const active = m.activePlayerFor(r.human);
          const press = owner && active && owner.team !== active.team && Math.hypot(spot.x - owner.pos.x, spot.y - owner.pos.y) < AIM.moveOrderRadius * 2;
          const point = press ? owner.pos : m.moveOrders[r.human]?.point ?? spot;
          this.commandCues[r.human] = { point: { ...point }, text: press ? 'PRESS' : 'RUN', remaining: 1.2 };
        }
        continue;
      }
      if (r.kickerId === null || r.kickerId !== this.kickOwnerFor(r.human)) {
        this.possessionNotices[r.human] = { human: r.human, text: 'Ball changed · draw again', remaining: 1.4 };
        continue;
      }
      if (r.cancelledShot) {
        this.possessionNotices[r.human] = { human: r.human, text: 'Shot cancelled · aim inside the net', remaining: 1.4 };
        continue;
      }
      if (r.shot) {
        if (!m.aimShot(r.human, r.shot.target, r.shot.power)) {
          this.possessionNotices[r.human] = { human: r.human, text: 'Shot no longer available', remaining: 1.4 };
        }
        continue;
      }
      // A rejected scribble must not become an unrelated straight kick.
      if (r.path) {
        if (!m.aimPath(r.human, anchorToBall(r.path, m.ball.pos))) {
          this.possessionNotices[r.human] = { human: r.human, text: 'Draw a clear direction', remaining: 1.4 };
        }
        continue;
      }
      m.aimKick(r.human, r.dir, r.power);
    }
  }

  kickOwnerFor(human) {
    if (!this.match?.canKick(human)) return null;
    return this.match.setPiece?.takerId ?? this.match.ball.owner;
  }

  suggestionAt(point, human) {
    const hits = (this.suggestionMarkers || []).filter(marker =>
      Math.hypot(point.x - marker.x, point.y - marker.y) <= marker.radius);
    const marker = hits.find(m => m.human === human) || hits[0];
    return marker ? { ...marker.suggestion, point: { ...marker.suggestion.point }, human: marker.human } : null;
  }

  isDrawingKick() {
    for (let human = 0; human < this.match.humanInputs.length; human++) {
      const aim = this.aimInput.aimState(human);
      if (aim?.active && aim.kickerId !== null && aim.kickerId === this.kickOwnerFor(human)) return true;
    }
    return false;
  }

  isHoldingKick() {
    for (const [human, drag] of this.aimInput.drags) {
      if (drag.kickerId !== null && drag.kickerId === this.kickOwnerFor(human)) return true;
    }
    return false;
  }

  isChoosingKick() {
    const m = this.match;
    if (m.state !== STATES.PLAY || m.ball.owner === null) return false;
    const owner = m.getPlayer(m.ball.owner);
    if (owner.isGK) return false;
    let canChoose = false;
    let running = false;
    for (let human = 0; human < m.humanInputs.length; human++) {
      if (!m.canKick(human)) continue;
      canChoose = true;
      const touch = this.aimInput.aimState(human);
      if (touch?.kickerId === owner.id) return true;
      running ||= m.isCarryingRun(human);
    }
    return canChoose && !running;
  }

  updatePossessionFeedback(dt) {
    for (const notice of this.possessionNotices) if (notice) notice.remaining -= dt;
    for (const cue of this.commandCues) if (cue) cue.remaining -= dt;
    const m = this.match;
    const team = m.ball.owner === null ? null : m.getPlayer(m.ball.owner).team;
    if (team !== null && team !== this.lastPossession) {
      if (this.lastPossession !== null) {
        for (let human = 0; human < m.config.humans.length; human++) {
          const mine = m.config.humans[human].team === team;
          this.possessionNotices[human] = { human, text: mine ? 'WON THE BALL' : 'LOST THE BALL', remaining: 1.5 };
        }
      }
      this.lastPossession = team;
    }
  }

  tickMatch(dtReal) {
    const m = this.match;
    const simDt = this.isAim ? this.simulationDelta(dtReal) : dtReal;
    this.frameSimulationDt = simDt;
    if (this.isAim) {
      this.stepMatch(simDt);
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
      if (this.isAim) (this.renderState ??= new RenderState()).capture(m);
      m.step(PHYSICS.dt);
      this.accumulator -= PHYSICS.dt;
      steps++;
      this.handleEvents(m.drainEvents());
      if (m.state === STATES.HALFTIME || m.state === STATES.FULLTIME) break;
    }
    if (m.state === STATES.HALFTIME && this.screen === SCREEN.MATCH) {
      this.screen = SCREEN.HALFTIME;
      this.aimInput.reset();
      this.aimInput.configure({ specialButtons: [] });
      showHalftime(this.overlay, m, () => {
        m.resumeSecondHalf();
        this.resumeMatch();
      });
    } else if (m.state === STATES.FULLTIME && this.screen === SCREEN.MATCH) {
      this.screen = SCREEN.FULLTIME;
      this.aimInput.reset();
      this.aimInput.configure({ specialButtons: [] });
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
        case 'mathsfocusused':
          if (this.isAim) {
            this.possessionNotices[e.humanIndex] = {
              human: e.humanIndex, text: 'Focused kick used', remaining: 1.8,
            };
          } else {
            this.activeRenderer.addFloat('Focused kick used', m.getPlayer(e.playerId).pos,
              e.humanIndex === 0 ? '#ffe600' : '#00e5ff');
          }
          break;
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
      const liveDt = this.screen === SCREEN.MATCH ? dtReal : 0;
      this.updatePossessionFeedback(liveDt);
      this.layout.aiming = this.isHoldingKick();
      this.layout.viewAttackDir = this.viewAttackDir();
      const view = (this.renderState ??= new RenderState()).view(this.match, this.accumulator / PHYSICS.dt);
      const controlledIds = new Set();
      const controlledColours = new Map();
      const aims = [];
      for (let i = 0; i < this.match.humanInputs.length; i++) {
        const active = this.match.activePlayerFor(i);
        if (active) {
          controlledIds.add(active.id);
          if (!controlledColours.has(active.id)) controlledColours.set(active.id, i === 0 ? '#ffe600' : '#00e5ff');
        }
        const state = this.aimInput.aimState(i);
        if (state && state.active && state.kickerId === this.kickOwnerFor(i) && this.match.canKick(i)) {
          const path = state.path ? anchorToBall(state.path, view.ball.pos) : null;
          const target = path && this.match.shotTargetFromPath(this.match.getPlayer(state.kickerId), path, this.match.setPiece?.kind);
          const shot = state.shot || (target ? { target, power: 0.8 } : null);
          aims.push({
            ...state,
            kicker: view.getPlayer(state.kickerId),
            from: view.ball.pos,
            path,
            shot,
            power: shot?.power ?? state.power,
            colour: i === 0 ? '#ffe600' : '#00e5ff',
          });
        }
      }
      this.updateEye(view, false);
      if (this.layout.shotAnchor) this.layout.shotAnchor = {
        ...this.layout.shotAnchor, carrier: view.getPlayer(this.layout.shotAnchor.carrier.id),
      };
      const pitch = this.pitchRenderer;
      const dt = this.screen === SCREEN.MATCH ? dtReal : 0;
      pitch.draw(view, this.layout, {
        dt,
        animationDt: this.screen === SCREEN.MATCH ? this.frameSimulationDt : 0,
        controlledIds,
        controlledColours,
        controlColours: ['#ffe600', '#00e5ff'],
        aim: null,
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
          this.renderer3d.drawFloats(hud, this.layout, dt);
        }
        this.suggestionMarkers = [];
        const highlightedGoals = new Set();
        for (let human = 0; human < this.match.humanInputs.length; human++) {
          const goal = this.match.shootingGoal(human);
          if (goal && !highlightedGoals.has(goal.x)) {
            this.renderer3d.drawShootingGoal(hud, goal);
            highlightedGoals.add(goal.x);
          }
        }
        for (let human = 0; human < this.match.humanInputs.length; human++) {
          const suggestion = this.match.suggestedTarget(human);
          if (suggestion) {
            const point = suggestion.playerId === null ? suggestion.point : view.getPlayer(suggestion.playerId).pos;
            const displayed = { ...suggestion, point: { ...point } };
            const marker = this.renderer3d.drawSuggestion(hud, displayed, human === 0 ? dt : 0, this.layout, human);
            if (marker) this.suggestionMarkers.push({ ...marker, human, suggestion: displayed });
          }
          const run = this.match.suggestedRun(human);
          if (run) {
            const marker = this.renderer3d.drawSuggestion(hud, run, 0, this.layout, human,
              { avoid: this.suggestionMarkers.filter((m) => m.human === human) });
            if (marker) this.suggestionMarkers.push({ ...marker, human, suggestion: run });
          }
        }
        for (const aim of aims) this.renderer3d.drawAim(hud, this.match, this.layout, { aim });
        this.renderer3d.drawControlCues(hud, view, this.layout, this.commandCues);
        drawHud(hud, this.match, this.layout, { hint: this.aimHint(), possessionNotices: this.possessionNotices.filter((n) => n && n.remaining > 0) });
      }
      return;
    }
    const hud = this.hudCanvas !== this.canvas ? this.hudCanvas.getContext('2d') : null;
    if (hud) hud.clearRect(0, 0, this.layout.w, this.layout.h);
    this.renderer.draw(this.match, this.layout, {
      dt: [SCREEN.DECISION, SCREEN.MATHS].includes(this.screen) ? 0 : dtReal,
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
      if (m.shootingGoal(0)) return 'Tap the net to shoot · drag to place your shot';
      if (m.state !== STATES.PLAY) return 'Draw or tap the tick';
      if (m.isCarryingRun(0)) return 'Running · draw to pass or shoot';
      if (m.suggestedRun(0)) return 'Tap green RUN · draw or tap ✓ to kick';
      const suggestion = m.suggestedTarget(0);
      return suggestion ? `Draw a kick · tap the tick to ${suggestion.kind === 'shot' ? 'shoot' : 'pass'}`
        : 'Tap to move · draw to pass or shoot';
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

function safeStorage() {
  try { return globalThis.localStorage; } catch { return null; }
}

export function loadSetup(storage = safeStorage()) {
  const base = { ...defaultConfig(), mathsDefaultVersion: 1 };
  try {
    const raw = storage?.getItem(STORE_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      const humans = base.humans.map((human, index) => {
        const restored = { ...human, ...saved.humans?.[index] };
        // Enable the former default once; later explicit Off choices survive.
        if (saved.mathsDefaultVersion !== base.mathsDefaultVersion
            && Number(restored.mathsBand) === 0) restored.mathsBand = human.mathsBand;
        return restored;
      });
      return { ...base, ...saved, teams: saved.teams || base.teams, humans,
        mathsDefaultVersion: base.mathsDefaultVersion };
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
