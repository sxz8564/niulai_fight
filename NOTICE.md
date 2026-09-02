# What the licence covers, and what it does not

## The code is MIT

Everything in `src/`, `tools/`, the build setup and the documentation is under
the MIT licence in `LICENSE`. Take it, learn from it, build your own brawler
with it.

## The characters are not

**Niulai (牛来), Wolfwolf (狼狼), their names, their designs and the model files
in `assets/models/` are not covered by the MIT licence. All rights reserved.**

They are original characters belonging to the repository owner, used here and
in the [Critter Cam filter](https://github.com/sxz8564/niulai_filter). The MIT
licence above applies to the software, not to them.

To use the characters in your own work, ask.

This split is deliberate and worth stating plainly, because the usual reading
of a repository with a bare MIT licence at its root is that everything inside
is MIT — including the artwork. That is not the intention here.

## Third-party components

### three.js

- Bundled into `dist/bundle.js` by `npm run build`
- Copyright 2010-2025 three.js authors
- Licence: MIT — https://github.com/mrdoob/three.js/blob/dev/LICENSE

### Character models and scene art

The meshes were generated with Meshy AI from the owner's own designs, then
cropped, retextured and rigged by the tooling in the Critter Cam repository.
The painted backdrop in `assets/scenes/` was supplied by the owner. Check the
terms of whichever generator plan produced a given file before redistributing
it.
