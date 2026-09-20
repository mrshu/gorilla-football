// Pitch geometry in metres. World coordinates: x runs along the pitch
// length (0 = left goal line, PITCH.length = right goal line), y runs
// across the pitch width (0 = top touchline). Team `attackDir` is +1 when
// a team attacks the right-hand goal, -1 for the left-hand goal.

export const PITCH = Object.freeze({
  length: 105,
  width: 68,
  goalWidth: 7.32,
  goalHeight: 2.44,
  goalDepth: 2.2,
  penaltyAreaDepth: 16.5,
  penaltyAreaWidth: 40.32,
  goalAreaDepth: 5.5,
  goalAreaWidth: 18.32,
  penaltySpot: 11,
  centreCircleRadius: 9.15,
  cornerArcRadius: 1,
  freeKickDistance: 9.15,
});

export const PHYSICS = Object.freeze({
  dt: 1 / 60,
  playerRadius: 0.55,
  ballRadius: 0.22,
  ballRollFriction: 4.5, // m/s^2 deceleration while rolling
  ballAirDrag: 0.15, // proportional drag while airborne
  gravity: 9.81,
  ballBounce: 0.55,
  controlRadius: 1.35, // distance at which a player can take the ball
  dribbleOffset: 0.75, // ball sits this far in front of dribbler
  tackleRange: 2.0,
  slideRange: 3.2,
  kickCooldown: 0.45,
  tackleCooldown: 1.6,
  stunAfterTackled: 0.8,
  maxBallSpeed: 42,
});

export const TIMING = Object.freeze({
  goalCelebration: 2.6,
  setPieceAiDelay: 1.3,
  setPieceHumanTimeout: 8,
  kickoffDelay: 1.0,
  goalkeeperHold: 1.6,
  whistlePause: 0.8,
});

export const STATES = Object.freeze({
  KICKOFF: 'KICKOFF',
  PLAY: 'PLAY',
  SET_PIECE: 'SET_PIECE',
  GOAL: 'GOAL',
  HALFTIME: 'HALFTIME',
  FULLTIME: 'FULLTIME',
});

export const SET_PIECES = Object.freeze({
  KICKOFF: 'kickoff',
  THROW_IN: 'throw_in',
  CORNER: 'corner',
  GOAL_KICK: 'goal_kick',
  FREE_KICK: 'free_kick',
  PENALTY: 'penalty',
});

export const ROLES = Object.freeze({ GK: 'GK', DF: 'DF', MF: 'MF', FW: 'FW' });
