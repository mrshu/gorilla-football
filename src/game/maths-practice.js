import Maths from './maths.js';
import { createRng } from './rng.js';
import { PITCH, STATES, SET_PIECES } from './constants.js';

export const MATHS_STORAGE_KEY = 'gorilla-football/maths/v1';
const MATHS_SEED_SALT = 0x4d415448;
const bandValue = (value) => Number.isInteger(value) && value >= 0 && value <= Maths.MAX_BAND ? value : 0;
const finite = (value, fallback, lo, hi) => typeof value === 'number' && Number.isFinite(value)
  ? Math.max(lo, Math.min(hi, value)) : fallback;
const count = (value) => Math.floor(finite(value, 0, 0, Number.MAX_SAFE_INTEGER));

function freshProfile(band = 0) {
  return { band, state: Maths.newState(band || 1), stats: { answered: 0, correct: 0, streak: 0, bestStreak: 0 } };
}

function repairProfile(raw) {
  const profile = freshProfile(bandValue(raw?.band));
  const state = raw?.state;
  if (state && typeof state === 'object') {
    profile.state.difficulty = finite(state.difficulty, profile.state.difficulty, 1, Maths.MAX_BAND);
    profile.state.home = finite(state.home, profile.state.home, 1, Maths.MAX_BAND);
    profile.state.fastStreak = finite(state.fastStreak, 0, 0, Number.MAX_SAFE_INTEGER);
    profile.state.wrongStreak = count(state.wrongStreak);
    if (state.mastery && typeof state.mastery === 'object' && !Array.isArray(state.mastery)) {
      for (const [skill, value] of Object.entries(state.mastery)) {
        if (skill === '__proto__' || skill === 'constructor' || skill === 'prototype') continue;
        if (typeof value === 'number' && Number.isFinite(value)) profile.state.mastery[skill] = Math.max(0, Math.min(1, value));
      }
    }
  }
  const answered = count(raw?.stats?.answered);
  const correct = Math.min(answered, count(raw?.stats?.correct));
  const streak = Math.min(correct, count(raw?.stats?.streak));
  profile.stats = { answered, correct, streak,
    bestStreak: Math.max(streak, Math.min(correct, count(raw?.stats?.bestStreak))) };
  return profile;
}

// Educational practice owns its own randomness and persistence. It reads
// possession without stepping, pausing, or granting any reward to the match.
export class MathsPractice {
  constructor({ storage } = {}) {
    try { this.storage = storage === undefined ? globalThis.localStorage : storage; }
    catch { this.storage = null; }
    this.profiles = [freshProfile(), freshProfile()];
    try {
      const saved = JSON.parse(this.storage?.getItem(MATHS_STORAGE_KEY) || 'null');
      if (saved?.schema === 1 && Array.isArray(saved.profiles)) {
        this.profiles = [repairProfile(saved.profiles[0]), repairProfile(saved.profiles[1])];
      }
    } catch { /* Broken or unavailable storage leaves clean in-memory profiles. */ }
    this.configure({ humans: [], seed: 1 });
  }

  configure(config) {
    this.config = config;
    this.enabledBands = [0, 0];
    for (let i = 0; i < config.humans.length && i < 2; i++) {
      const band = bandValue(config.humans[i].mathsBand);
      this.enabledBands[i] = band;
      // Off is a match preference, not a request to erase the learner.
      if (band > 0 && this.profiles[i].band !== band) this.profiles[i] = freshProfile(band);
    }
    this.rand = createRng((config.seed | 0) ^ MATHS_SEED_SALT).next;
    this.possession = null;
    this.accounted = false;
    this.eligibleCounts = [0, 0];
    this.nextHuman = 0;
    this.opportunities = new WeakMap();
    this.persist();
  }

  persist() {
    try { this.storage?.setItem(MATHS_STORAGE_KEY, JSON.stringify({ schema: 1, profiles: this.profiles })); }
    catch { /* Memory remains authoritative when saving is unavailable. */ }
  }

  nextQuestion(match) {
    const restart = [STATES.KICKOFF, STATES.SET_PIECE].includes(match.state) ? match.setPiece : null;
    const ownerId = restart ? restart.takerId : match.state === STATES.PLAY ? match.ball.owner : null;
    // A loose-ball interval or a new restart is a distinct possession even
    // when the same player collects or takes it afterwards.
    const identity = restart || (ownerId != null ? `player:${ownerId}` : null);
    if (identity !== this.possession) {
      this.possession = identity;
      this.accounted = false;
    }
    if (!identity || this.accounted || (restart && (restart.lerp < 1 || restart.taken))) return null;
    const carrier = match.getPlayer(ownerId);
    if (!carrier || carrier.isGK || carrier.sentOff || carrier.stun > 0
        || carrier.frozen > 0 || carrier.kickCooldown > 0) return null;
    const aim = this.config.aimControl ?? this.config.control === 'aim';
    const candidates = this.config.humans.map((human, humanIndex) => ({ human, humanIndex }))
      .filter(({ human, humanIndex }) => this.enabledBands[humanIndex] > 0 && !match.hasMathsFocus(humanIndex)
        && carrier.team === human.team && (aim || carrier.human === humanIndex)
        && ((carrier.pos.x - PITCH.length / 2) * match.teams[carrier.team].attackDir >= 0
          || (restart?.kind === SET_PIECES.KICKOFF && this.eligibleCounts[humanIndex] === 0)));
    if (!candidates.length) return null;
    // Co-op assigns the entire possession to one learner, including turns
    // without a question. The other profile cannot ask again on the same ball.
    const selected = candidates.find(({ humanIndex }) => humanIndex >= this.nextHuman) || candidates[0];
    const humanIndex = selected.humanIndex;
    this.nextHuman = (humanIndex + 1) % 2;
    this.accounted = true;
    const number = ++this.eligibleCounts[humanIndex];
    if ((number - 1) % 3 !== 0) return null;
    const profile = this.profiles[humanIndex];
    try {
      const question = Maths.make(profile.state.difficulty, profile.state, this.rand);
      const opportunity = { humanIndex, kickerId: carrier.id, question };
      this.opportunities.set(opportunity, { humanIndex, profile, band: question.band, skill: question.skill, done: false });
      return opportunity;
    } catch { return null; }
  }

  answer(opportunity, correct, elapsedMs) {
    const entry = opportunity && typeof opportunity === 'object' ? this.opportunities.get(opportunity) : null;
    if (!entry) return null;
    const profile = this.profiles[entry.humanIndex];
    if (entry.done || profile !== entry.profile) return profile;
    entry.done = true;
    const success = correct === true;
    const streak = success ? profile.stats.streak + 1 : 0;
    const updated = {
      band: profile.band,
      state: Maths.update(profile.state, { correct: success,
        elapsedMs: finite(elapsedMs, Number.MAX_SAFE_INTEGER, 0, Number.MAX_SAFE_INTEGER),
        band: entry.band, skill: entry.skill }),
      stats: { answered: profile.stats.answered + 1, correct: profile.stats.correct + (success ? 1 : 0),
        streak, bestStreak: Math.max(profile.stats.bestStreak, streak) },
    };
    this.profiles[entry.humanIndex] = updated;
    this.persist();
    return updated;
  }

  skip(opportunity) {
    const entry = opportunity && typeof opportunity === 'object' ? this.opportunities.get(opportunity) : null;
    if (!entry) return null;
    entry.done = true;
    return this.profiles[entry.humanIndex];
  }
}

export default MathsPractice;
