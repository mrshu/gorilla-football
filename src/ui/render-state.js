// Keep the deterministic physics step while drawing the interval between its
// two latest states. Render views are isolated snapshots, never engine input.
const TELEPORT_METRES = 3;

export class RenderState {
  constructor() {
    this.reset();
  }

  reset() {
    this.previous = null;
  }

  // Call immediately before each fixed simulation step, including when a
  // frame runs several steps. Only the latest interval is rendered.
  capture(match) {
    this.previous = {
      match,
      time: match.time,
      state: match.state,
      half: match.clock.half,
      attackDirs: match.teams.map((team) => team.attackDir),
      setPiece: match.setPiece,
      players: new Map(match.players.map((player) => [player.id, {
        pos: { ...player.pos }, facing: { ...player.facing },
      }])),
      ball: { pos: { ...match.ball.pos }, z: match.ball.z },
    };
  }

  // alpha = remaining simulation accumulator / fixed timestep. Keeping alpha
  // unchanged also keeps a frozen drawing gesture's rendered positions fixed.
  view(match, alpha = 1) {
    const t = Number.isNaN(alpha) ? 1 : Math.max(0, Math.min(1, alpha));
    const previous = this.previous;
    const interpolate = previous && previous.match === match
      && previous.time <= match.time && previous.state === match.state
      && previous.half === match.clock.half && previous.setPiece === match.setPiece
      && previous.attackDirs.every((dir, i) => dir === match.teams[i]?.attackDir);
    // Copy all current data so non-spatial properties (owner, cards, ability
    // cooldowns, etc.) never come from the previous physics snapshot. Preserve
    // aliases: teams.players, players and getPlayer must agree on each entity.
    const view = cloneData(match, new Map(), true);
    if (interpolate) {
      for (const player of view.players) {
        const before = previous.players.get(player.id);
        if (!before || jumped(before.pos, player.pos)) continue;
        player.pos = mixPoint(before.pos, player.pos, t);
        player.facing = mixFacing(before.facing, player.facing, t);
      }
      const before = previous.ball;
      if (!jumped(before.pos, view.ball.pos, before.z, view.ball.z)) {
        view.ball.pos = mixPoint(before.pos, view.ball.pos, t);
        view.ball.z = mix(before.z, view.ball.z, t);
      }
    }
    return freezeData(view);
  }
}

function mix(a, b, t) {
  return a + (b - a) * t;
}

function mixPoint(a, b, t) {
  return { x: mix(a.x, b.x, t), y: mix(a.y, b.y, t) };
}

function jumped(a, b, az = 0, bz = 0) {
  return Math.hypot(b.x - a.x, b.y - a.y, bz - az) > TELEPORT_METRES;
}

function mixFacing(a, b, t) {
  if (t === 0) return { ...a };
  if (t === 1 || !Math.hypot(a.x, a.y) || !Math.hypot(b.x, b.y)) return { ...b };
  const from = Math.atan2(a.y, a.x);
  const to = Math.atan2(b.y, b.x);
  const delta = Math.atan2(Math.sin(to - from), Math.cos(to - from));
  const angle = from + delta * t;
  return { x: Math.cos(angle), y: Math.sin(angle) };
}

// Match data consists of records, arrays and restart Maps. Copying the graph
// with a memo keeps its shared references without retaining mutable live data.
function cloneData(value, copies, isMatch = false) {
  if (!value || typeof value !== 'object') return value;
  if (copies.has(value)) return copies.get(value);
  const copy = value instanceof Map ? new Map()
    : Array.isArray(value) ? [] : Object.create(Object.getPrototypeOf(value));
  copies.set(value, copy);
  if (value instanceof Map) {
    for (const [key, item] of value) copy.set(cloneData(key, copies), cloneData(item, copies));
  } else {
    for (const key of Object.keys(value)) {
      // The RNG contains closures into the live simulation. Rendering never
      // needs it; omit it so a render view cannot consume the engine's rolls.
      if (isMatch && key === 'rng') continue;
      copy[key] = cloneData(value[key], copies);
    }
  }
  return copy;
}

function freezeData(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  if (value instanceof Map) {
    for (const [key, item] of value) {
      freezeData(key, seen);
      freezeData(item, seen);
    }
    for (const method of ['set', 'delete', 'clear']) {
      Object.defineProperty(value, method, { value() { throw new TypeError('Render state is read-only'); } });
    }
  } else {
    for (const item of Object.values(value)) freezeData(item, seen);
  }
  return Object.freeze(value);
}
