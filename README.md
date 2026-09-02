# Niulai Fight 牛来大战

A belt-scrolling brawler in the shape of the Famicom ones: walk right, the
screen stops, wolves arrive, clear them, the screen lets you on. Niulai fights
through woods and grassland; Wolfwolf comes in packs.

Runs as a Chrome extension. Click the toolbar button and it opens in a tab.

![Niulai between two wolves in the woods](docs/screenshot.png)

## Playing it

| | |
| --- | --- |
| **← →** | move |
| **↑ ↓** | step up and down the belt |
| **J** or **Space** | punch |
| **K** | kick |

Stepping up and down is not decoration. An attack only lands if you are close
in X *and* nearly level in Z, so a wolf standing a metre upstage cannot hit you
and you cannot hit it. Circling is how you fight three at once.

## Installing it

```bash
npm install
npm run build
```

Then in Chrome: **chrome://extensions** → turn on **Developer mode** →
**Load unpacked** → choose this folder. The toolbar button opens the game.

`npm run package` builds `dist/niulai-fight-<version>.zip` for the Web Store.

To play it without the extension at all:

```bash
npm run serve      # then open the printed address
```

## The characters

**Niulai is rigged.** He is a full skinned biped with five motion-captured
clips — punch, kick, knee, hit reaction, jump — merged into one
`assets/models/niulai-rigged.glb` by `npm run models`.

Two of the six states have not been delivered yet, and the registry says so out
loud: `walk` falls back to the guard-stance idle, so he slides rather than
strides, and `down` falls back to the hit reaction, so a knockdown reads as a
flinch. Neither is the game failing; both go away when the clips arrive.

**Wolfwolf is still a head on a placeholder body**, built from primitives and
animated by rotating them — the wolf model is the one from the
[Critter Cam filter](https://github.com/sxz8564/niulai_filter), which is a head
because that is all a face filter ever needed.

Both go through the same `play()` and `update()`, so the two kinds coexist and
either can be swapped without the game changing.
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
