# Niulai Fight 牛来大战

A belt-scrolling brawler in the shape of the Famicom ones: walk right, the
screen stops, wolves arrive, clear them, the screen lets you on. Two fighters
to pick from — Niulai 牛来 and Baola 豹拉 — against Wolfwolf, who comes in
packs, through woods and grassland.

Runs as a Chrome extension. Click the toolbar button and it opens in a tab.

![The character select: Niulai and Baola](docs/select.png)

![Baola between two wolves in the woods](docs/screenshot.png)

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

Blocking works against what you are facing and not against what you are not,
which is what makes it a decision about where you are looking rather than a
button that turns damage off. A fifth of the damage still gets through, so
turtling cannot outlast a wave, and holding it costs your movement and your
offence.

Stepping up and down is not decoration. An attack only lands if you are close
in X *and* nearly level in Z, so a wolf standing a metre upstage cannot hit you
and you cannot hit it. Circling is how you fight three at once.

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

**All three characters are rigged bipeds.** `npm run models` reads one folder
per character under `incoming/` and writes a single `.glb` each — 11 clips for
Niulai and Baola, 10 for Wolfwolf, around a megabyte apiece.

Adding a fighter is a registry entry, not a code change: give it `playable:
true`, its clip trims and its stats, and it appears on the select screen with a
portrait rendered from the model itself. Baola went in that way, and reuses
Niulai's trims unchanged — the clips came from the same generator with the same
names, so the slices that worked for him work for her.

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
    ├── actor.js       head + body, and the swap-in point for a rigged model
    ├── stage.js       ground, trees, the painted backdrop
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
