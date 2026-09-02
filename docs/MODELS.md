# Supplying a rigged Niulai

The characters you see today are **heads on placeholder bodies**. The heads are
the real models — the same `.glb` files the Critter Cam filter ships, because a
face filter only ever needed a head. The bodies are capsules and cylinders built
in `src/game/actor.js` and animated by rotating them, which is enough to read as
punching and walking but is not the character.

This is the contract for replacing them.

## What the game asks of an actor

Everything outside `actor.js` talks to a character through two calls:

```js
actor.play('walk');        // one of the states below
actor.update(dt, speed);   // advance whatever is animating
```

So a rigged model does not need the game to change. It needs to answer those
two calls, and `createActor` already knows how to do that with an
`AnimationMixer` when the model brings clips.

## Turning it on

In `assets/models/index.json`, for the character concerned:

```json
{
  "id": "niulai",
  "file": "niulai.glb",
  "animated": true,
  "clips": {
    "idle": "Idle",
    "walk": "Walk",
    "punch": "Punch",
    "kick": "Kick",
    "hit": "Hit",
    "down": "KnockDown"
  }
}
```

`clips` maps the game's state names onto whatever the animations are called in
your file. Leave it out and the state names are used as clip names directly. A
state with no matching clip simply does not play — nothing throws, so a model
that only has idle and walk still works while the rest is being made.

## The six states

| State | When it plays | Length |
| --- | --- | --- |
| `idle` | standing | looping |
| `walk` | moving in any direction | looping |
| `punch` | light attack | **0.26 s** |
| `kick` | heavy attack | **0.34 s** |
| `hit` | took a hit and stayed up | 0.22 s |
| `down` | knocked down or defeated | 1.1 s, ends on the ground |

The two attack lengths are not decoration. The game treats the middle of each —
from 25% to 70% through — as the frames that can connect, so the contact pose
needs to fall inside that window or the punch will look like it lands after it
has already hit. Those numbers live in `Fighter` and can move if your animation
wants a different rhythm, but the animation and the number have to agree.

## Geometry

Same conventions as the filter's models, plus a body:

- **glTF 2.0 `.glb`**, textures embedded, no Draco or Meshopt compression.
- **Facing +Z, +Y up**, origin at the feet, standing on the ground plane.
- **About 1 unit tall.** One world unit is roughly one character height, and
  the belt is about 3 units deep. A model twice that size will fight from
  outside its own reach.
- Under 8 MB, ideally under 2. The game loads every character before the first
  frame.

If the origin is not at the feet the character will float or sink; that is the
first thing to check if something looks wrong.

## What happens to the placeholder

Nothing, and that is deliberate. `animated: false` keeps the built body, so
wolves can stay as they are while Niulai gets a real rig, and a half-finished
model can be dropped in and compared against the placeholder by flipping one
flag.
