import { PITCH, PHYSICS } from '../game/constants.js';

// Use the gesture's captured camera: the goal is a vertical plane, whereas
// a pass stroke is projected onto the grass. A small tolerance makes posts
// and the crossbar touchable; the returned ball centre clears their edges.
export function shotTargetAt(camera, screenPoint, goal, options = {}) {
  const margin = options?.margin === undefined ? 0.4 : options.margin;
  const viewport = camera?.viewport;
  if (typeof camera?.ray !== 'function' || !viewport
      || !Number.isFinite(viewport.w) || !Number.isFinite(viewport.h)
      || viewport.w <= 0 || viewport.h <= 0
      || !Number.isFinite(screenPoint?.x) || !Number.isFinite(screenPoint?.y)
      || screenPoint.x < 0 || screenPoint.x > viewport.w
      || screenPoint.y < 0 || screenPoint.y > viewport.h
      || !Number.isFinite(goal?.x) || !Number.isFinite(goal?.y)
      || !Number.isFinite(margin) || margin < 0) return null;

  let ray;
  try { ray = camera.ray(screenPoint.x, screenPoint.y); } catch { return null; }
  const { origin, dir } = ray || {};
  if (![origin?.x, origin?.y, origin?.z, dir?.x, dir?.y, dir?.z].every(Number.isFinite)
      || Math.abs(dir.x) < 1e-6) return null;
  const distance = (goal.x - origin.x) / dir.x;
  if (!Number.isFinite(distance) || distance <= 0.6) return null;

  const y = origin.y + dir.y * distance;
  const z = origin.z + dir.z * distance;
  const halfWidth = PITCH.goalWidth / 2;
  if (!Number.isFinite(y) || !Number.isFinite(z)
      || y < goal.y - halfWidth - margin || y > goal.y + halfWidth + margin
      || z < -margin || z > PITCH.goalHeight + margin) return null;

  const radius = PHYSICS.ballRadius;
  return {
    x: goal.x,
    y: Math.max(goal.y - halfWidth + radius, Math.min(goal.y + halfWidth - radius, y)),
    z: Math.max(radius, Math.min(PITCH.goalHeight - radius - 0.1, z)),
  };
}
