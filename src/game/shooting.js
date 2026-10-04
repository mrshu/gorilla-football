import { PHYSICS, PITCH } from './constants.js';
import { clamp, norm, sub, dist } from './vec.js';

const LAUNCH_OFFSET = PHYSICS.playerRadius + PHYSICS.ballRadius + 0.1;
const LAUNCH_HEIGHT = 0.05;
const DEFAULT_HEIGHT = 0.65;
const MAX_TARGET_HEIGHT = PITCH.goalHeight - PHYSICS.ballRadius - 0.1;

// Plan a driven shot through the goal plane, rather than a pass that stops
// there. Accuracy error and earned precision are applied by the caller.
// Target y deliberately stays unclamped: the caller can aim wide of goal.
export function planShot(kicker, target, power = 0.8) {
  if (!Number.isFinite(kicker?.pos?.x) || !Number.isFinite(kicker?.pos?.y)
      || !Number.isFinite(kicker?.phys?.shotSpeed) || kicker.phys.shotSpeed <= 0
      || !Number.isFinite(target?.x) || !Number.isFinite(target?.y)
      || !Number.isFinite(power)) return null;

  const point = {
    x: target.x < PITCH.length / 2 ? 0 : PITCH.length,
    y: target.y,
    z: clamp(Number.isFinite(target.z) ? target.z : DEFAULT_HEIGHT, PHYSICS.ballRadius, MAX_TARGET_HEIGHT),
  };
  const distance = dist(kicker.pos, point) - LAUNCH_OFFSET;
  if (distance <= 0) return null;
  const dir = norm(sub(point, kicker.pos));
  const speed = Math.min(kicker.phys.shotSpeed, PHYSICS.maxBallSpeed) * (0.7 + 0.3 * clamp(power, 0, 1));
  const dt = PHYSICS.dt;
  const retention = 1 - PHYSICS.ballAirDrag * dt;

  // integrateBall reduces horizontal speed before advancing each frame.
  // Invert that geometric series, then locate the fractional final frame
  // where the ball crosses the plane. This matches the fixed-step physics
  // rather than assuming a constant horizontal speed or continuous drag.
  const remainingFraction = 1 - distance * (1 - retention) / (speed * dt * retention);
  if (remainingFraction <= 0) return null;
  const steps = Math.log(remainingFraction) / Math.log(retention);
  const fullSteps = Math.floor(steps);
  const covered = speed * dt * retention * (1 - retention ** fullSteps) / (1 - retention);
  const finalStepDistance = speed * dt * retention ** (fullSteps + 1);
  const fraction = clamp((distance - covered) / finalStepDistance, 0, 1);
  const travelTime = (fullSteps + fraction) * dt;
  // Vertical velocity also loses gravity before the frame advances.
  const gravityDrop = PHYSICS.gravity * dt * dt
    * (fullSteps * (fullSteps + 1) / 2 + fraction * (fullSteps + 1));
  const vz = (point.z - LAUNCH_HEIGHT + gravityDrop) / travelTime;
  return { dir, speed, vz, target: point, travelTime };
}
