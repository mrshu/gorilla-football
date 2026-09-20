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

In assisted play the AI is also nudged to keep the human involved: a human
receiver scores a bonus in `rankPassTargets()`, and `looseBall()` lets them
contest one more loose ball than a teammate would. Without that the person
holding the phone saw the ball for about a tenth of the match.

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

## The stadium view

`src/ui/camera.js` is a perspective camera with no matrices: a look-at basis
(`forward`, `right`, `up`), a focal length from the field of view, and a divide
by depth. `project()` turns a world point into canvas pixels plus a
`scale` in pixels per metre at that depth, which is all the renderer needs to
size a player or a ball. `screenToGround()` casts the inverse ray and
intersects the grass, which is how a finger position becomes a point on the
pitch.

`frameBall()` places the camera behind the ball looking towards the goal that
team is attacking. It tracks the ball sideways only partially, and its eye and
target track by similar amounts, which keeps the camera's axis nearly parallel
to the touchlines: the pitch slides rather than swinging. The constants were
chosen by a search over the parameter space that required the ball to project
inside the canvas from every point on the pitch at four screen sizes, and
`test/camera.test.js` re-checks that on every run.

There are two renderers behind the same interface. `RendererWebGL` builds a
three.js scene: a textured pitch plane, a stadium of boxes carrying a generated
crowd texture, goal frames with translucent nets, a group of meshes per player
and a shadowed ball. It does not own a camera of its own; it copies the `Camera`
above into a `THREE.PerspectiveCamera` each frame, mapping world (x, y, z) to
three (x, z, -y), which preserves handedness and keeps world up as three up.
Because both cameras agree, the HUD and the drawn line, painted on a separate 2D
canvas stacked above, line up exactly with the rendered scene.

`Renderer3D` is the fallback used when three.js cannot be fetched. It paints
back to front: sky, surrounding ground, the four
terraces, the grass and its lines, both goals, then players and the ball sorted
by depth. Straight pitch lines are drawn as a chain of short segments so
perspective bends them correctly. Quads whose corners fall behind the camera are
skipped, so the long terraces are drawn in segments and only the part actually
behind the lens disappears. Crowds are a fixed hash per seat, so they never
shimmer between frames.

Nothing here is a dependency: it is arithmetic on the same 2D canvas context the
top-down renderer uses.

## Whole-team control

The default control style gives the human no player to steer. Everyone,
including the human's nominal footballer, is driven by the outfield AI. The
human's entire input is the ball:

- `aimPath(human, points)` queues a drawn line, and `applyAimInputs()` plays it
  at the top of the next step so a release lands on the frame the finger lifted.
  `aimKick(human, dir, power)` is the straight-line fallback for a stroke that
  could not be projected onto the grass.
- `playBallAlongPath()` anchors the drawn shape to the ball, derives power from
  the stroke's length on the grass, and hands the ball a `path`.
  `followPath()` then walks the ball point to point each frame, spending a
  distance budget rather than steering, so the ball traces exactly the line that
  was drawn. When the points run out the path is dropped and the ball rolls on
  under ordinary friction. It is never marked unstoppable, so it can be
  intercepted anywhere along the route.
- `playBall()` turns direction and power into one kick. There is no pass/shoot
  distinction: speed runs from `AIM.minSpeed` to the kicker's shot speed, aim
  error grows with power and shrinks with the kicker's accuracy, and power above
  `AIM.loftPower` lifts the ball. A kick aimed at goal from range is recorded as
  a shot for the statistics, nothing more.
- `tap(human)` is the no-drag gesture: `pushBallOn()` when you have the ball,
  knocking it ahead and giving the carrier a short burst to chase it, and
  `pressWithNearest()` when you do not.
- `canKick(human)` gates all of it on that human's team actually having the
  ball, or being the taker at a restart.

`aiMayActFor(p)` is the hinge. For a carrier on a human's team the AI is not
allowed to shoot or pass, so the ball waits for the person holding the phone.
After `AIM.holdGrace` seconds it is allowed again, so an unattended match still
flows. The opposition is never restrained.

`src/ui/aiminput.js` converts pointers into that input. A drag is measured in
pixels and converted to a ground direction through the camera, so dragging
towards the top of the screen always sends the ball away from you. Each human
owns a screen zone, so two people can share one device.

## Assisted control and decision pauses

Manual control is the default: the human drives their footballer with the
joystick and buttons, and nothing pauses. Assisted control is the opt-in
alternative, where a human's footballer is driven by the same AI as everyone
else and the match freezes when they have a choice to make. Three pieces make
that work.

**Movement.** `controlAssistedHuman()` runs the normal AI to set the player's
desired velocity, then lets the joystick override it while it is pushed. The
buttons stay live, so a confident player never has to wait for the panel.

**Suppressed auto-action.** `carryBall()` in the AI checks `match.isAssisted()`
and, for a human's player, skips the block that decides to shoot or pass. The
player still dribbles, steers around opponents and avoids the touchlines; only
the decision is withheld.

**The freeze.** `step()` returns immediately while `match.pendingDecision` is
set, so the clock, the ball and every player stop dead. `maybeOpenDecision()`
runs at the end of each played frame and opens the panel on one of four
triggers:

| Trigger | Fires when |
| --- | --- |
| `possession` | the human's player becomes the ball owner |
| `shooting_range` | they carry it inside their shooting range, once per possession |
| `pressure` | an opponent comes within `DECISION.pressureDistance`, at most every `pressureGap` seconds |
| `carrying` | `carryGap` seconds pass without any other trigger |

Restarts use the same panel: `stepSetPiece()` calls `openDecision()` with the
set-piece kind instead of waiting for a button, and the restart stays staged
until the choice comes back.

`buildDecisionOptions()` produces the options as plain data — an id, a label, a
detail line and a `quality` hint — so the UI renders them without knowing any
football. `resolveDecision()` validates the choice against that list, rejecting
anything disabled or unknown, applies it and unfreezes.

The thresholds live in `DECISION` in `constants.js`. They are tuned so a
five-minute match produces roughly one decision every five seconds of play.

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
