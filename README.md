# Niulai Fight 牛来大战

A belt-scrolling brawler in the shape of the Famicom ones: walk right, the
screen stops, wolves arrive, clear them, the screen lets you on. Two fighters
to pick from — Niulai 牛来 and Baola 豹拉 — against Wolfwolf, who comes in
packs, through woods and grassland, and the Cart 木车 waiting at the end of it.
When Niulai has taken enough and given enough, he calls his mother, and ten of
her come through the field.

Runs as a Chrome extension. Click the toolbar button and it opens in a tab.

![The character select: Niulai and Baola](docs/select.png)

![Baola between two wolves in the woods](docs/screenshot.png)

![The Cart rearing back to charge](docs/boss.png)

![Ten mamas stampeding through a line of wolves](docs/mama.png)

## Playing it

Pick a fighter first. **Niulai** is steady — more health, hits harder.
**Baola** is quick — faster on her feet and easier to hurt. Press **1** or
**2**, or click a card.

| | |
| --- | --- |
| **← →** | move |
| **↑ ↓** | step up and down the belt |
| **J** or **Space** | punch |
| **K** | kick |
| **L** or **Shift** (hold) | block |
| **M** or **U** | the super, when the rage bar is full — MAMA for Niulai, SUPER for Baola |
| **R** (when it ends) | play again |
| **C** (when it ends) | choose a different fighter |

Winning or losing does not send you back to the page reload button — the
banner tells you which key restarts, and a tap anywhere does it too.

Blocking works against what you are facing and not against what you are not,
which is what makes it a decision about where you are looking rather than a
button that turns damage off. A fifth of the damage still gets through, so
turtling cannot outlast a wave, and holding it costs your movement and your
offence.

Stepping up and down is not decoration. An attack only lands if you are close
in X *and* nearly level in Z, so a wolf standing a metre upstage cannot hit you
and you cannot hit it. Circling is how you fight three at once.

## The first two minutes

A new player gets a lesson, and gets it once. Six prompts, one at a time, each
naming a control and waiting until the thing it names has actually happened —
walk right, walk back, step off the line, punch, kick, hold a block — then a
send-off and the game proper. The switch on the roster screen turns it on and
off, it is on for anyone who has not played before, and finishing it (or
pressing SKIP, which counts the same) turns it off for good.

Two things make it work rather than being a wall of text with an OK button.

**It watches the world, not the keyboard.** A step is finished when the fighter
has moved, or is mid-swing, or has been behind a guard for half a second — never
when a key went down. That is what lets the same six lessons be driven from the
touch pad on a phone, where no key is pressed at all, and it is why the block
step cannot be satisfied by tapping: it is measured in seconds, because holding
is the thing being taught.

**The wolves cannot arrive during it.** The first wave triggers six units short
of its gate, so the lesson holds the player at `HOLD_AT` — nearer than that —
using the same boundary the gates use. Learning which key punches is not
something to be doing with two wolves already on you. The wall comes down on the
send-off, which is why that step exists at all.

Every prompt is written twice, for a keyboard and for a thumb: `Punch — J or
Space` against `Punch — tap P`. `src/game/tutorial.js` holds the table and the
state machine; the game only asks it to update and puts what it returns in the
snapshot.

## Difficulty

Three of them, under the roster, remembered between visits.

| | Stages | A wolf takes | The Cart |
| --- | --- | --- | --- |
| **Easy** | 5 | 34 | 220 |
| **Normal** | 7 | 46 | 308 |
| **Hard** | 9 | 60 | 396 |

Easy is the game exactly as it shipped before there was a choice, which is the
point: nobody's idea of what this game is should change underneath them.

Two knobs and no more — health and length. Faster wolves, or wolves that hit
harder, would change what the game *asks* of a player: a different reaction
time, a different amount of blocking. More health and more stages only ask for
more of what they are already doing, and that is the difference a difficulty
setting is supposed to make. The extra gates go in ahead of the Cart rather
than at the start, so the opening fights of a hard run are the opening fights
of an easy one and the ending is still the ending.

`src/game/difficulty.js` is the whole thing: the table, and the function that
builds a gate list from it. The level was a constant in `game.js` before this
and is now generated per run, which also means a run can no longer inherit the
gates another one left open.

## Where it is played

Seven painted backdrops, all of them out of Critter Cam — the same paintings
that project puts behind a webcam, which is what keeps the two looking like one
thing. They are chosen on the roster screen, as pictures: seven names in a row
would be a quiz.

Two numbers come off each painting rather than out of anybody's judgement, and
`npm run scenes` produces both (`tools/make-scenes.mjs`). The first is a thumbnail, because seven
full backdrops is most of a megabyte and that is a silly price for a menu. The
second is the sky colour, sampled from the top of the image, and it does more
work than it sounds like: it is what the game paints behind everything, what it
fogs the far trees into, and — scaled by its own brightness, with a floor so
the fight stays readable — how much light there is. A night valley behind a
field lit like noon is the sort of thing nobody can name but everybody sees.

Each painting also dresses the field in front of it. Grass, path, tufts,
bushes, trunks and four tree colours per scene, in the registry beside the
backdrop — because a fight in front of a violet wood at sunset, standing on
orchard green, is two pictures in one and no amount of matching the sky fixes
it. The seven schemes are authored rather than sampled: the tool proposes one
by taking the hue of the painting's land and of its foliage and running them
through the orchard's own ladder — how much lighter the path is than the grass,
how far under it the bushes sit — and then someone looks at it. An existing
scheme is never overwritten unless `--repalette` says so.

Lightness is deliberately *not* taken from the painting. The material colours
are albedo and the light is already scaled by how bright the sky is, so
darkening a night painting's grass as well would take it to mud. The ladder
holds the grass near where the orchard's sits and lets the lighting do the
rest, which is why Lantern Night reads as a dark field rather than a black one.

The paintings are 16:9 and the backdrop plane is 22 units tall, so one whole
painting is 39 units wide. That number now comes from the image. It used to be
27.7, which squeezed 16:9 into 5:4 and left every tree in the distance slightly
too narrow for its height — nothing in the game said so, it just looked wrong.

## The board

Every run ends on one: what it scored, where that puts it, and the ten best
runs this browser has finished. A name is optional and nothing is saved until
somebody presses the button — the run appears in its place on the board either
way, because a rank you cannot see until you commit to it is not an answer to
"how did I do".

**It is this browser's board, and the screen says so** — `RANKING 排行榜 · ON
THIS DEVICE 本机`. A table of one machine's runs presented as the world's would
be a lie told in gold letters. `src/game/scores.js` is two operations wide —
put a run on, read it back in order — so the day there is a server to talk to,
the adapter changes and nothing above it does. That day also needs an origin in
`host_permissions`, a privacy policy that describes what is collected, and a
store listing that agrees with both, which is why it is not today.

Two things went wrong on the way and both are worth knowing about. The game's
key map owns A, D, W, S, J, K, L, M, U and the space bar, and it called
`preventDefault` on all of them — so typing RACHEL into the name box produced
RCHE. A keystroke aimed at a text field is not a game input, and `input.js` now
says so. And R plays again, Enter plays again, and a tap anywhere plays again,
all of which are reasonable until somebody is typing a name in the middle of
them; the board swallows its own clicks and keys.

## Infinite mode

A switch on the roster screen. Clear the last stage and the level starts again
instead of ending: fresh gates, back to the top of the belt, and **nothing put
back** — the same lives, the same health, the same score, the same rage in the
meter, and a stage number that keeps counting. Stage 6 is the first gate of the
second lap, and the HUD says `6/∞` because there is no total to be a fraction
of. The only way out is the ordinary one, which is running out of lives.

The fresh gates are the part that matters: `opened` is written to as each wave
triggers, so a second lap that reused the list would find every fight in it
already over.

## Sound

Five short files, played through `<audio>` elements. No mixer, no graph, no
library — for a handful of impacts that is the whole job.

| | |
| --- | --- |
| **punch**, **kick** | the player's, on contact |
| **fall** | anything knocked down, hero, wolf or Cart |
| **charge** | the Cart's engine, on the wind-up |
| **win**, **loss** | the two ways a run ends |
| **select**, **confirm** | moving across the roster, and choosing |
| **theme** | a two-and-a-quarter-minute loop, under everything |

The two supers have a sound each, hung off the character rather than the bank:
Niulai's call to his mother, and the noise Baola's change makes. Both are
`shout` in the registry's `power` block, played the moment the meter is spent,
and `shoutVolume` pulls one back if it sits too loud against the rest.

Each fighter also has a **voice** — an effort on the swing and a cry on going
down — under `voice` in their registry entry. The effort is on the swing rather
than on contact, unlike the impacts: it is the effort, and it happens whether or
not anything is there to hit. The cry goes with the fall rather than with the
life being deducted, which is a second and a quarter later as they are already
getting back up.

The bank is shared and deliberately last-writer-wins, because rounds are
sequential: starting a round registers that fighter's voice under `voice:attack`
and `voice:down`, replacing whoever was there, and no call site has to ask who
is being played. The one place that builds a second game *beside* the first
rather than after it is the test suite, which borrows the voice and hands it
back.

**Punches and kicks are the player's only.** The wolves throwing the same sound
back would turn a crowd into noise, and the point of these is that a player can
hear their own hits land without watching the health bars. They fire on contact
rather than on the swing, and only when the hit actually registered — a heavy
impact under a punch that missed is a lie, and one under a punch the target's
invulnerability ate is a smaller one.

The knockdown is a hook on the Fighter rather than four call sites in the game.
Punches, a charge and a stampede all arrive through `takeHit` and all end the
same way, so the sound belongs where they meet. The Cart has the same
arrangement for its phases.

**The engine starts with the wind-up, not with the charge.** The pause is the
only warning the move gives, and a warning you can hear reaches a player who is
busy with a wolf — which is exactly the player who is about to be run over. The
source is 4.8 seconds of a truck getting steadily louder, peaking right at the
end, so playing it whole would have put its loudest moment four seconds after
the charge, during the stall, which is the quietest thing that happens in the
fight. It ships as the last 1.45 seconds of that build, which lands its peak on
the charge.

Each sound gets a few `<audio>` elements played round robin. One element per
sound cuts itself off, so two punches a tenth of a second apart become one
punch — which is exactly the moment a brawler most needs to sound like two.

Silence is never treated as failure. Autoplay policy blocks anything before the
first real interaction, a muted tab rejects `play()` outright, and every path
swallows its own errors so none of it can reach the game loop. What *is* checked
is that every file in the bank is one the browser can decode, and that the right
event makes the right noise — recorded by standing in for `play` rather than by
listening, since a muted test machine would answer no to everything.

### The music, and its switch

The theme is one element that keeps its place rather than a pool of voices —
giving it voices would mean the music restarting on top of itself. It runs
under the roster and stays running through the fight.

The switch is on the intro screen and the preference outlives the page: a player
who turns it off does not want to be asked again. On unless it has been turned
off, because a game that opens silent looks broken to someone who never finds
the button.

Starting it is the fiddly part, and it took two goes:

- **Autoplay policy refuses audio before a page has been interacted with**, and
  the roster appears before anyone has done anything. A refusal arms a one-shot
  listener, so the music comes in on the first click or keypress — on a screen
  whose entire job is to be clicked, a moment away.
- **The manifest is still in the air the first time the music is asked for.**
  The first version returned quietly when the track was not in the bank yet,
  which meant it never started *and* never armed the fallback above: silent,
  with nothing to suggest anything had gone wrong. It now retries when the
  manifest lands.

Everything is Opus in WebM, including the sources that arrived as MP3, Ogg
Vorbis and 24-bit WAV: one format the whole toolchain and both test suites
already know how to check. Effects are 64 kbps stereo; the theme is 48 kbps
mono, which is under a megabyte for two and a quarter minutes and
indistinguishable underneath the game at a third of full volume. Downmixing to
mono pushes the peak about three decibels over, so it is trimmed by rather more
than that or it clips — measure the output, do not assume the trim landed.

**Not MIDI**, which was tried and thrown away. The same music as a MIDI file is
5.9 KB against 970, which sounds decisive until it is weighed: no browser can
play a MIDI file, so shipping one means shipping a synthesiser as well, and the
music then no longer sounds like the recording — it sounds like three
oscillators, which nobody can check without listening to it. Trading known-good
audio for unheard audio, plus two hundred lines of parser and synth to maintain,
is not a bargain at any file size.

```bash
ffmpeg -i theme.ogg -vn -af "volume=-4.5dB" -c:a libopus -b:a 48k -ac 1 assets/audio/theme.webm
```

## Rage

**Both fighters have a meter**, both fill it the same way, and both spend it on
**M** — but what it buys is not the same move with different numbers, because
they do not have the same problem.

### Niulai: mama

Niulai has a meter. It fills from **both** halves of a fight — three and a half
for landing a hit, six for taking one, five for finishing a wolf — and when it
is full, **M** spends the lot. That is around seven wolves' worth, so it arrives
somewhere in the middle of the level rather than inside the first wave: a
screen-clearing move you spend because you need it, not because it is there.

He plants his feet, shouts for his mother, and ten of her come through the stage
in five parallel lines, running everything down. Every enemy in a lane is hit
once per cow that reaches it, which clears a screen of wolves outright and takes
about half the Cart's health, since the Cart is wide enough for several lanes to
find it at once.

They cross at 3.25 units a second — slower than the hero walks, and slow enough
to watch, which for the one spectacle in the game is the point. Their legs
follow: the gallop is scaled by how fast the herd is actually travelling against
the speed the clip was authored for, so slowing it down does not turn it into
skating.

Both that and the meter's fill rate live in the registry's `power` block, and
the tests read the herd until it is gone rather than for a fixed number of
seconds, so re-tuning either does not turn the suite red.

A cow retires after `range` units as well as on leaving the picture, and that
second rule is not belt-and-braces. The finish line is measured from the camera
and the camera follows the player — safe while the herd outran everyone, but at
less than walking pace a player heading right moves the line away faster than
the cows advance on it, and a cow that can never reach it never leaves the
scene. Ten more every cast, for ever.

The weighting is the design. Rewarding only aggression would withhold the button
from the player who is losing, which is exactly who needs it; rewarding only
damage taken would make the move a consolation prize. Both, tilted toward being
hit, means a bad exchange is still progress toward a good one. The second he
spends standing still is what it costs — and he is untouchable for that second,
because a super that a stray wolf can cancel is a super nobody uses when they
are surrounded, which is the only time it is worth using.

### Baola: seven seconds as something else

Hers does not touch the screen at all. She **becomes** something else —
Super Baola 超级豹拉, a jaguar warrior a third again her size — for seven
seconds: **double damage out, half damage in**, and no pause at all.

![Super Baola standing over a line of wolves](docs/super.png)

That last part is the design. Niulai's costs a second of standing still because
it answers being surrounded, and a screen-clear is worth paying for. Hers
answers the opposite problem — a fight she is losing on attrition, where what
she needs is not the screen cleared but a window in which trading hits is
finally in her favour. Locking her in place for it would spend the thing it
gives her.

The swap is of the actor, not the fighter: health, position, facing, the meter
and every rule about hitstun stay where they were, and only the body doing it
changes. The bar becomes a clock while it runs, in a different colour, so a
half-full bar never means two things.

**She grows into it.** The new body appears at exactly the size the old one was
standing at, eases up to its own over about half a second — overshooting a
little and settling, so it looks like something happening to her rather than a
slider being dragged — and eases back down before it hands her body back.
Appearing at full size on the swap frame read as a glitch instead of a
transformation: one frame a leopard cub, the next a jaguar warrior a third again
as tall, with nothing on screen connecting the two. Both the growth and the
shrink happen *inside* the seven seconds, so the number on the bar is the number
of seconds she is actually stronger for.

The ground goes first. Ten animals arriving at a run is the loudest thing in
the game and it used to happen in a perfectly steady shot; the camera now takes
a shake at the moment the herd lands — decaying squared, on two frequencies that
do not divide into each other, so the axes never fall into step and draw a line
across the screen instead of a rumble. `shake` and `shakeFor` in the registry
are how hard and how long. It is applied as an offset the camera keeps outside
its own position, so the frame after it still follows the player from where the
shot wanted to be rather than from wherever the last jolt left it.

Which of the two a character gets is `kind` in the registry — `summon` or
`transform`. A character with no `power` block still gets no meter, no key and
no bar.

## Winning

Clear the last stage and the game stops being a fight. Niulai plants himself
and goes into a sweep kick and a backflip, on a loop, while the camera leaves
its fighting distance and comes in to watch — and the banner moves to the top of
the screen so the words are not standing on top of him.

![Niulai mid-backflip under the winning banner](docs/win.png)

It is the same `play()` every other state goes through, so the celebration is a
clip name in the registry and nothing more. **Baola has no celebration clip**,
and rather than freezing her in whatever the last thing she did left her in, she
falls back to her idle: `actor.has(state)` is what decides, and dropping the same
clip into her registry entry is all it would take to give her one.

Finding that out turned up a real bug, and an old one. `state` starts as `idle`
and `play()` returns early for the state it is already in — so the game's first
`play('idle')` was always a no-op and **no action ever started**. A character
that had not yet done something else stood in its bind pose: not breathing, not
swaying, a mannequin. Nothing caught it for as long as it existed because the
player walks within a second of starting and the wolves walk on arrival, so
almost everything asked for a *different* state before anyone looked at it. What
does not is a character standing still at the end of a won run.

## The Cart

The last stage is not more wolves. **The Cart 木车** rolls in with two of them,
and it has exactly one attack:

1. It follows you, slowly. Too slowly to catch anyone who keeps moving — it is
   not trying to catch you, it is trying to line you up.
2. It stops dead for **one second**, rears its nose up and shakes.
3. It charges straight down the belt at six times its rolling speed, and being
   hit costs a third of your health.
4. It overshoots, stalls for a second and a half, and takes **double damage**
   while it does.

That loop is the whole fight, and every part of it is there to make the attack
answerable. The charge holds the lane it committed to during the wind-up, so
the answer is to step off that line — the third axis the stages before it let
you ignore. Blocking works too and costs you a fifth of the damage, where
moving costs nothing. The stall afterwards is the only window worth punching
in, so the fight is a rhythm rather than a race.

It does not flinch. A punch hurts it without stopping it, because a boss a jab
could halt would make the whole thing a matter of mashing one button and never
moving.

**It is held to exactly the box the player is held to**, and that is a fairness
rule rather than a detail. Its arena is what ends a charge that has run out of
room; when the arena was a window around the last gate instead of the level, a
player who retreated past the left edge of that window made every charge hit the
"wall" on its first frame and go straight to recovery. The Cart would follow
them around the level for ever and could never touch them — a fight that looked
like it was happening and was not.

## Installing it

Clone it, then in Chrome: **chrome://extensions** → turn on **Developer mode**
→ **Load unpacked** → choose this folder. The toolbar button opens the game.

No build step. `dist/bundle.js` is committed precisely so that works — a folder
you load unpacked has to be loadable unpacked, and requiring a build first
means a fresh clone fails with `ERR_FILE_NOT_FOUND` and a blank screen.

If you change anything under `src/`, rebuild it:

```bash
npm install
npm run build
```

`npm run package` builds `dist/niulai-fight-<version>.zip` for the Web Store.

To play it without the extension at all:

```bash
npm run serve      # then open the printed address
```

## The characters

**The four fighting bodies are rigged bipeds.** `npm run models` reads one folder
per character under `incoming/` and writes a single `.glb` each — 11 clips for
Niulai and Baola, 10 for Wolfwolf, around a megabyte apiece.

**The Cart is not.** It arrived as one static mesh with no rig and no clips at
all, which for a vehicle is not a shortcoming: its entire vocabulary is pitch,
roll and shake, and those are three lines each. `npm run prop` brings a model
like that in — re-encoding its textures, standing it on the floor and measuring
it — and `updateProp` in `actor.js` writes the motion. It still goes through
the same `play()` and `update()` as everything else, so nothing outside that
file knows which kind of actor it got.

**Mama is a rig with one clip.** She has no health, cannot be hit, and collides
with nothing — she is not a Fighter at all, just an actor that runs in a
straight line. `fallbacks` in the registry points every state the actor knows
about at the only clip she has, so nothing has to special-case an actor with a
vocabulary of one.

`npm run models` takes character names now, and it is worth using them:
re-exporting a character that has not changed still writes a byte-different
`.glb`, and a diff full of megabytes nobody altered hides the one that was.

The shout is **Opus in WebM**, not the m4a it arrived as. AAC plays in Chrome
and does not play in Chromium — no proprietary codecs in the open build — so the
move was silent for anyone not on Google's binary, and nothing said so. Both
test suites now check that the file has a duration, which is what "the browser
understood the container and the codec" looks like from JavaScript:

```bash
ffmpeg -i mama.m4a -vn -af "volume=10dB" -c:a libopus -b:a 64k -ac 1 assets/audio/mama.webm
```

Adding a fighter is a registry entry, not a code change: give it `playable:
true`, its clip trims and its stats, and it appears on the select screen with a
portrait rendered from the model itself. Baola went in that way, and reuses
Niulai's trims unchanged — the clips came from the same generator with the same
names, so the slices that worked for him work for her.

Super Baola is a registry entry too, and reuses Baola's clip trims unchanged:
same rig, same clip names, same rest height, a different mesh and a bigger
scale. Five clips rather than eight — no block, no knee, no jump — and
`fallbacks` covers the gap.

Re-texturing her goes through `npm run retexture` rather than the merge:

```bash
npm run retexture superbaola incoming/textures/superbaola.glb
```

A re-texture comes back as a *static* model — the same character, new maps, no
rig and no clips — so dropping it into `incoming/` and re-merging would throw
the animations away.

The obvious shortcut is to move the maps: keep the rigged mesh and point its
material at the new images. **That is wrong**, and it shipped once before it was
caught. A re-texture comes back with its own UV unwrap — the same character laid
out differently on the sheet — so the new image on the old unwrap is a smear.
Putting the two atlases side by side is the two-second check that would have
saved the trip; they look nothing alike.

What *is* true is that the geometry is identical: every vertex of the new mesh
lands exactly on a vertex of the old one once the unit-height export is scaled
back up. So the mesh moves instead. The new geometry, with its own UVs, is bound
to the old skeleton by copying each vertex's weights from the vertex it
coincides with, and the old material keeps its shape and gets the new images.
The clips never move at all.

The vertex counts differ — 4104 against 4096 for Super Baola — because a
different unwrap splits seams differently, which is why the match is by position
rather than by index, and why every vertex has to find a partner or the tool
refuses to write anything. Seven of hers land a thousandth of her height away
from their partner, so a hash miss falls back to a nearest-neighbour search
inside a tolerance; a miss beyond it means the models really are different.

The old material keeps its shape on purpose. These exports put the same texture
in three places — base colour, emissive at full white, and normal — which is how
the generator makes a model read flat and unlit, and **the emissive is the slot
that decides what the character actually looks like**. The first attempt
replaced base colour and normal and left the emissive alone, which is why it
came back looking exactly as it had: the new paint was underneath a layer
nobody could see past.

The proof is a render, not an argument, so look at one — of the animated model,
in more than one clip, because that is where both halves of this can fail. There
is also a check that the form can still play every state the game will ask it
for, since a re-texture that came back without the clips would leave her frozen
in her bind pose for seven seconds while every other check passed: the damage
numbers belong to the Fighter and have nothing to do with whether anything is
moving.

A boss is a registry entry and a gate: `{ x, count, boss: 'cart' }` on the last
gate is what puts it there. Its size lives in the registry too, and it matters
more than it looks — the Cart is nearly three units long, so a hit box measured
centre to centre, which is how every other fighter is measured, would put its
middle further away than an arm can reach while its bodywork is in your face.
`hurtRadius` is what makes it hittable at all.

Locomotion speed follows actual ground speed, so nobody skates. Niulai uses the
**run** cycle because he covers about four body-heights a second; the wolves,
at 2.5, use the **walk** one. Niulai blocks and the wolves do not — that stays
the player's move.

Spare clips are merged and named but not yet bound to anything: hurdle,
back-jump and the wolf's jumping punch. Jumping needs an air state first; the
knee is an obvious heavy attack whenever a third button is wanted.

The placeholder path — a head model on a body built from primitives — is still
there for a character that has no rig yet. Set `animated: false` and it takes
over. Both kinds go through the same `play()` and `update()`, so they coexist.
[docs/MODELS.md](docs/MODELS.md) is the contract.

## Tests

```bash
npm test               # plays the game over http://
npm run test:extension # loads it as a real unpacked extension and plays it
```

Both drive the actual build through the same input a player uses, and read the
same state the HUD reads. That matters more than it sounds: a brawler can
render perfectly and still be broken in the only way that counts — a punch that
never connects, a gate that never opens — and none of that shows up in a
screenshot. Between them they check that walking reaches a gate, that the gate
holds you until the wave is dead, that a punch damages a wolf, that enough
punches finish one, that a wolf can hurt you, that clearing opens the gate, and
that a punch misses someone standing further up the belt.

Each super gets its own set. Niulai's: that the meter fills from hitting and
from being hit, that it will not fire early, that firing it empties the meter and plants
him in the summon pose, that ten of them arrive in parallel lines and all run
the same way, that nothing can touch him mid-summon, that a screen of wolves
does not survive it, that several of them land on the Cart at once because it is
wide enough for that, that the herd clears itself off the field, that the shout
is in a format the browser can decode. Baola's: that casting it turns her into
something else, that the new body takes over the old one's place in the scene
rather than a place beside it, that it runs for seven seconds and never holds
her still, that she hits for exactly twice and takes exactly half, that seven
seconds later she is entirely herself again, and that a round ending in the
middle of it puts her back.

The ending has checks of its own: that clearing the last gate plays the
celebration rather than stopping the frame, that the bones are still moving
afterwards, that the camera comes in, that the banner gets out of the way — and,
in the one place that can ask it, that a brand-new character animates before
anyone has asked it to do anything.

The boss gets its own set, and each one is the same question from a different
side — is its one attack answerable? That it pauses before it charges and does
not creep during the pause; that the charge holds its lane and is much faster
than its roll; that standing in it costs a lot and stepping off it costs
nothing; that blocking costs something in between; that a punch can reach it at
all; that hitting it hurts without stopping it; that it takes more damage while
stalled; and that wrecking it ends the game. Breaking any one of those on
purpose fails exactly the checks that name it — including the unhittable-boss
bug, which nothing else here would have noticed, because a boss that cannot be
hit simply never loses.

The extension suite exists separately because "works" and "works as an
extension" fail differently: a manifest naming a missing file, an asset the
extension's own CSP refuses to fetch. Those only show up when it is loaded the
way a player loads it.

## How it is built

```
src/
├── main.js            bootstrap, HUD, the frame loop
├── select.js          the character select, portraits and all
├── background.js      the extension: one click, one tab
└── game/
    ├── game.js        waves, gates, camera, the rules
    ├── fighter.js     health, hitstun, knockdown — shared by player and wolves
    ├── boss.js        the Cart: stalk, wind up, charge, stall
    ├── power.js       the rage meter and what it summons
    ├── sound.js       the sound bank, and enough voices to overlap
    ├── actor.js       rigged models, props, and the placeholder body
    ├── stage.js       ground, trees, the painted backdrop and its palette
    ├── difficulty.js  the three settings, and the gates each one builds
    ├── tutorial.js    the six lessons, and what finishes each of them
    ├── scores.js      the ranking board, and the seam a server would go through
    └── input.js       keyboard and touch
```

Two decisions worth knowing:

- **The gate is the structure.** Without a boundary the player runs past every
  fight; with one the level becomes a sequence of small arenas. `boundary`
  stops the player and the camera at the same line, so the wall you run into
  is one the picture agrees with.
- **Attacks are buffered for a quarter of a second.** A press during hitstun
  or during the tail of your own last swing is held rather than dropped.
  Without it the game feels like it is ignoring you at exactly the moment you
  are pressing hardest.

## Permissions

None. The extension declares no permissions and no host access: it opens a tab
to a page inside itself, makes no network requests, and touches no other site.

The obvious refinement — focusing an already-open game instead of opening a
second tab — needs the `tabs` permission, which Chrome shows users as "read
your browsing history". Not a fair trade for a game.

## Licence

MIT for the code — see [LICENSE](LICENSE). The characters, their names and
their artwork are not covered by it; see [NOTICE.md](NOTICE.md).
