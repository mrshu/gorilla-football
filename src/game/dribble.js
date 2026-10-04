import { DECISION, PHYSICS, PITCH, STATES } from './constants.js';
import { clamp, dist, pointSegmentDistance } from './vec.js';

const TOUCHLINE_MARGIN = 1.5;
const GOAL_MARGIN = 6;
// Leave room for a defender's slide and the carrier's body. This is a
// suggestion about current space, not protection from a subsequent tackle.
const LANE_CLEARANCE = PHYSICS.slideRange + PHYSICS.playerRadius;
const RUN_LENGTHS = [12, 10, 8];

// A short, genuinely forward carry through current open space. The caller
// owns the movement order and must revalidate possession before committing.
// All distances are to a finite segment, so opponents well behind the
// carrier (or beyond the destination) don't close an otherwise useful lane.
export function findOpenRun(match, carrier) {
  if (!carrier || match.state !== STATES.PLAY || match.ball.owner !== carrier.id
      || carrier.sentOff || carrier.isGK || carrier.stun > 0 || carrier.frozen > 0
      || carrier.sliding > 0) return null;
  const start = carrier.pos;
  const attackDir = match.teams[carrier.team]?.attackDir;
  if (![1, -1].includes(attackDir) || !Number.isFinite(start?.x) || !Number.isFinite(start?.y)
      || start.x < 0 || start.x > PITCH.length || start.y < 0 || start.y > PITCH.width) return null;

  const opponents = match.teams[1 - carrier.team].players.filter((p) => !p.sentOff);
  if (opponents.some((p) => dist(start, p.pos) <= DECISION.pressureDistance)) return null;

  const goal = { x: attackDir > 0 ? PITCH.length : 0, y: PITCH.width / 2 };
  const goalDistance = dist(start, goal);
  // Bias toward the centre from a wing, but keep every candidate within
  // 33 degrees of forward. No sideways or backwards escape suggestions.
  const goalSlope = clamp((goal.y - start.y) / Math.max(1, Math.abs(goal.x - start.x)), -0.35, 0.35);
  const slopes = [...new Set([goalSlope, 0, goalSlope - 0.25, goalSlope + 0.25, -0.65, 0.65])]
    .filter((slope) => Math.abs(slope) <= 0.65);
  let best = null;
  let bestScore = -Infinity;
  for (const length of RUN_LENGTHS) {
    for (const slope of slopes) {
      const forward = length / Math.hypot(1, slope);
      const point = { x: start.x + attackDir * forward, y: start.y + slope * forward };
      const goalLineGap = attackDir > 0 ? PITCH.length - point.x : point.x;
      if (point.x < 0 || point.x > PITCH.length || goalLineGap < GOAL_MARGIN
          || point.y < TOUCHLINE_MARGIN || point.y > PITCH.width - TOUCHLINE_MARGIN) continue;
      const progress = goalDistance - dist(point, goal);
      if (progress <= 0) continue;

      let clearance = Infinity;
      for (const opponent of opponents) {
        clearance = Math.min(clearance, pointSegmentDistance(opponent.pos, start, point));
      }
      if (clearance < LANE_CLEARANCE) continue;
      // Prefer meaningful goalward progress, then a little breathing room.
      // Capping the clearance term prevents a short detour winning merely
      // because an opponent on the far side of the pitch is farther away.
      const score = progress + forward * 0.1 + Math.min(clearance, 8) * 0.15;
      if (score > bestScore) {
        best = point;
        bestScore = score;
      }
    }
  }
  return best;
}
