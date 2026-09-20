# Architecture

## Layers

```
 src/data/     content (characters, jerseys, formations, team presets)
      |
 src/game/     simulation: no DOM, no rendering, deterministic
      |
 src/ui/       canvas rendering, touch input, DOM screens, game loop
```

The simulation never imports from `src/ui`, so it runs unchanged under Node for
tests (`npm test`) and headless balance runs (`npm run sim`). The UI reads match
state and drains an event queue; it never mutates simulation state directly
except through `Match.setHumanInput()`.

## The simulation

`Match` owns a fixed-timestep world. `step(dt)` advances one tick and moves
through a small state machine:

```
KICKOFF ──takes restart──> PLAY ──goal──> GOAL ──> KICKOFF
   ^                        |  \                        |
   |                        |   \--out/foul--> SET_PIECE┘
   |                        |
   └── HALFTIME <──half ends┘──second half ends──> FULLTIME
```

`PLAY` runs, in order: controllers (human input, outfield AI, goalkeeper AI),
player integration and separation, possession resolution, ball integration, and
out-of-play checks. Restarts freeze the world, interpolate every player to a
legal position over one second, then wait for the taker.

### Determinism

All randomness comes from a seeded mulberry32 PRNG (`src/game/rng.js`). A given
seed plus a given input sequence always produces the same match, which is what
makes the rules tests meaningful.

### Coordinates

World units are metres on a 105 × 68 m pitch. `x` runs along the length with
`x = 0` at the left goal line; `y` runs across the width. A team's `attackDir`
is `+1` when it attacks the right-hand goal. Everything else — formations,
offside, goalkeeper positioning, AI shifting — is written in terms of
`attackDir`, so switching ends at half time is a single sign flip.

Formation slots are stored team-relative (`x` from own goal line to opponents'
goal line, both in 0..1) and converted with `relToWorld()`.

## Rules

`src/game/rules.js` contains pure functions: out-of-play classification, goal
detection, penalty-area tests, offside evaluation, tackle resolution and card
application. They take plain data and return plain data, which keeps them
independently testable and makes rule variants cheap.

`Match` calls them and owns the consequences (starting restarts, emitting
events, mutating players).

## AI

Deterministic utility scoring over a handful of situations, as specified — no
learning, no pathfinding graphs.

**Outfield** (`src/game/ai.js`) — each frame a player is in exactly one of four
situations:

| Situation | Behaviour |
| --- | --- |
| Carrying the ball | Periodically re-decide shoot / pass / dribble by scoring the options; steer around the nearest opponent; avoid the touchlines |
| Team in possession | Move to a ball-shifted formation slot, drift away from close markers, hold the offside line |
| Opponents in possession | The two nearest players press the carrier and tackle; the rest mark goal-side of the nearest opponent in their zone |
| Loose ball | The two nearest chase the predicted interception point; the rest reposition |

**Goalkeeper** (`src/game/goalkeeper.js`) — positions on the ball-to-goal line
at a depth that increases as the ball approaches, projects incoming shots to its
own line and moves to intercept after a reaction delay, collects loose balls
inside its box, holds briefly, then distributes to the best-scoring open
teammate or clears long.

## Abilities

`src/game/abilities.js` is a registry keyed by id. An ability declares its
cooldown, optional `maxUses`, whether it needs the ball, and two functions that
receive the `Match`. Abilities act only through public `Match` helpers
(`launchHoming`, `releaseBall`, `snapBallToOwner`, `emit`, …), so adding one
touches no other file.

The Gorilla's guaranteed goal uses `launchHoming()` with `unstoppable: true`.
An unstoppable ball ignores interception, goalkeeper catches and deflections; a
homing pass additionally carries `assistFinish`, which makes the receiver fire
an unstoppable shot the moment they collect it.

## UI

- `layout.js` computes, for the current size, orientation and human count,
  where the pitch and every control lives. It also exposes `worldToScreen` and
  `screenDirToWorld`, which is where the portrait-mode 90° rotation lives. In
  portrait the pitch runs down the screen so it still fills the display.
- `input.js` tracks pointers by id, so two people touching simultaneously never
  interfere. Each human owns one joystick zone (floating: the stick centres
  wherever the thumb lands) and one button cluster.
- `renderer.js` draws everything procedurally from each character's `look`
  block. No image assets exist, by design.
- `app.js` owns the screen state machine and the accumulator loop, capped at six
  simulation steps per frame so a slow device degrades in speed rather than
  spiralling.
