# Publishing Niulai Fight

Everything here is prepared. What is left needs your Google account.

```bash
npm run store      # dist/store/ — icons, screenshots, both promo tiles
npm run package    # dist/niulai-fight-<version>.zip — the upload
```

`store` plays the real game to take its screenshots and builds the tiles from
one of those frames, so the artwork cannot promise something the game does not
do. The icon is rendered separately: at 16 pixels a cropped screenshot is mud,
and the only thing that survives is a silhouette.

## The listing

**Category:** Games. **Language:** English (United States).

### Name

> Niulai Fight 牛来大战

### Summary

The line under the title in search results. End-user copy — plain words, no
jargon. This lives in `manifest.json`.

> A side-scrolling brawler in a browser tab. Punch through five to nine stages
> of wolves, call your mother, and face the Cart.

### Description

Written for someone deciding whether to install, not for a developer. What they
will see and do, not how it is built.

> Turn a browser tab into a Famicom-era beat 'em up.
>
> Walk right. The screen stops. Wolves arrive. Clear them and the screen lets
> you on — through woods and grassland, all the way to the Cart.
>
> Three difficulties
>
> • Easy: five stages, wolves that go down quickly.
> • Normal: seven stages, wolves that take an extra hit.
> • Hard: nine stages, wolves that take two more — and a Cart with nearly twice
>   the health at the end of it.
>
> Two fighters
>
> • Niulai 牛来, steady: more health, hits harder.
> • Baola 豹拉, quick: faster on her feet, easier to hurt.
>
> Two rage bars, two very different answers
>
> Both fill from landing hits and from taking them, and both are spent with one
> key — but they are not the same move.
>
> • Niulai plants his feet and shouts for his mother. Ten of her come through
>   the field in parallel lines and run down everything in them. It clears a
>   screen of wolves outright, and it is the best second you will spend on the
>   Cart.
> • Baola turns into Super Baola 超级豹拉 for seven seconds: twice the damage
>   out, half the damage in, and no pause at all. The seven seconds are yours
>   to fight in.
>
> How it plays
>
> • Punch, kick, and hold to block. Blocking works against what you are facing
>   and not against what you are behind, so where you are looking matters.
> • Step up and down as well as left and right. A wolf standing further up the
>   field cannot hit you, and you cannot hit it — circling is how you handle
>   three at once.
> • Lose all your health and you go down. Lose three times and it is over, and
>   one key starts you again.
>
> And at the end, the Cart 木车
>
> The last stage is not more wolves. The Cart follows you, stops dead for a
> second to rear back and shake, and then charges straight down the field hard
> enough to take a third of your health. It holds the line it picked, so the
> answer is to step off it — and then to hit it while it is stalled, because
> that is the only moment it cannot hit you back.
>
> Sound
>
> Impacts, a body hitting the ground, an engine spooling up before the Cart
> comes at you, and a theme under all of it. One switch on the opening screen
> turns the music off and remembers you did.
>
> No account, no sign-in, no internet
>
> The whole game is inside the extension. It asks for no permissions at all,
> makes no network requests, and cannot see any other page you have open. It
> works with the wifi off.

### Graphics

Every file below is produced into `dist/store/` at exactly the sizes the
dashboard accepts.

| Field | File | Size |
| --- | --- | --- |
| Store icon | `icon-128.png` | 128 x 128 |
| Screenshots | `2-fight.png`, `3-mama.png`, `6-super.png`, `4-boss.png`, `5-win.png` | 1280 x 800 |
| Small promo tile | `promo-440x280.png` | 440 x 280 |
| Marquee promo tile | `promo-1400x560.png` | 1400 x 560 |

Six are produced and five go up, which is the most the store accepts. Upload
them in the order listed; `1-select.png` is the spare, and swapping it in for
one of these is a reasonable call if you would rather lead on the roster than
on what the two fighters do. It shows the first one largest, and a fight is a better first
impression than a menu. The stampede goes second because it is the loudest thing
in the game and nothing else on the page looks like it; the boss third, because
it is what says the game has an ending. The select screen comes after those:
two characters is a reason to install, but it is a quieter one.

The marquee is optional and only matters if the store ever features the
extension. It costs nothing to supply and a listing without one looks
unfinished next to those that have it.

## Privacy practices

This is the easiest listing you will ever fill in, because the honest answer to
almost everything is "none".

**Single purpose:**

> A single-player side-scrolling fighting game that runs in its own tab. That
> is the extension's only function.

**Permission justification:** there are none to justify. The extension declares
no `permissions` and no `host_permissions`. If the form insists on something:

> The extension requests no permissions. Clicking its toolbar button opens a
> page packaged inside the extension itself, which needs no permission, and it
> never interacts with any other site.

**Remote code** — answer **No, I am not using remote code**. If a box appears:

> All JavaScript, the 3D models, the audio and the artwork are packaged inside
> the extension. It makes no network requests of any kind and evaluates no code
> fetched at runtime.

**Data usage** — leave every collected-data category unticked and certify all
three statements. They are true and testable: the extension has no network
code, stores nothing, and asks for no identity.

## URLs

| Field | Use |
| --- | --- |
| Homepage | `https://github.com/sxz8564/niulai_fight` |
| Support | `https://github.com/sxz8564/niulai_fight/issues` |
| Privacy policy | `https://github.com/sxz8564/niulai_fight/blob/main/PRIVACY.md` |

All three need the repository to be public. A URL the reviewer cannot open is a
rejection.

## Before you submit

- [ ] Bump `version` in `manifest.json` (and `package.json`, which names the
      zip). The store rejects a version it has already published.
- [ ] Check the zip actually runs: unpack it somewhere else and load *that*
      folder unpacked, not the repository. A missing build artifact is exactly
      the failure that reached a player last time.
- [ ] Decide public or unlisted. Unlisted still goes through review but is
      reachable only by link — a reasonable way to hand it to a few people
      first.
- [ ] The name is 22 characters, well inside the 45 the store allows, so it
      will display in full everywhere.
- [ ] Nothing about the answers above changes when the game gains sound: the
      audio is a file inside the package, played by the page. No permission, no
      network, no new data of any kind.

## A note on the artwork

The characters are the repository owner's own and are **not** covered by the
MIT licence on the code — see `NOTICE.md`. That distinction matters more for a
store listing than a repository, because a listing is where someone decides
what they are allowed to reuse.
