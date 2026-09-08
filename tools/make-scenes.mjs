import { createRequire } from 'node:module';
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from './serve.mjs';

/*
 * Builds the scene registry from whatever is in assets/scenes.
 *
 * Three things come out of each painting, and none is worth doing by eye. A
 * thumbnail, because seven full backdrops is the better part of a megabyte and
 * that is a silly price for a menu. The sky colour, sampled from the top of
 * the image, which the game paints behind everything and fogs the distance
 * into. And a ground palette — the grass, the path, the trees and the bushes
 * that stand in front of the painting.
 *
 * That last one is a proposal rather than a verdict. The ladder below is the
 * orchard's own scheme written down as relationships — how much lighter the
 * path is than the grass, how much greener the trees are, how far down the
 * bushes sit — so a new painting arrives already dressed in something
 * plausible. An existing `ground` block in the registry is left alone, because
 * a colour somebody looked at and adjusted beats a colour a rule produced.
 * Pass --repalette to overwrite them anyway.
 *
 *   node tools/make-scenes.mjs [--repalette]
 */

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const scenes = join(root, 'assets/scenes');
const thumbs = join(scenes, 'thumbs');
mkdirSync(thumbs, { recursive: true });

/* Display names, in the order the roster shows them. Anything on disk that is
 * not named here still ships — it just gets its filename tidied up. */
const NAMES = {
  'orchard-day': ['Orchard Day', '果园白日'],
  'cattle-valley': ['Cattle Valley', '牛谷'],
  'golden-grove': ['Golden Grove', '金林'],
  'paintbox-wood': ['Paintbox Wood', '彩林'],
  'pale-plain': ['Pale Plain', '苍原'],
  'lantern-night': ['Lantern Night', '灯夜'],
  'star-valley': ['Star Valley', '星谷']
};

/*
 * The orchard's scheme, as a ladder. Hue and saturation come from the
 * painting; these numbers say what the foreground does with them. Lightness is
 * held roughly where the original scheme put it, on purpose: the material
 * colours are albedo, and the scene light is already scaled by how bright the
 * sky is, so darkening a night painting's grass as well would take it to mud.
 */
const LADDER = {
  grass: ['ground', 0, 43],
  path: ['ground', -4, 49],
  tuft: ['ground', +4, 37],
  bush: ['leaf', 0, 33]
};
const TREES = [[0, -2, 33], [-8, 0, 36], [+6, -3, 29], [-14, +2, 41]];
const BARK = '#6b4a2f';

const clamp = (v, low, high) => Math.max(low, Math.min(high, v));
function hsl([h, s], shift, sat, light) {
  const H = ((h + shift) % 360 + 360) % 360;
  const S = clamp(s + sat, 8, 46) / 100;
  const L = light / 100;
  const a = S * Math.min(L, 1 - L);
  const channel = (n) => {
    const k = (n + H / 30) % 12;
    return Math.round(255 * (L - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return '#' + [channel(0), channel(8), channel(4)]
    .map((v) => v.toString(16).padStart(2, '0')).join('');
}
/** Halfway between two colours, so a proposed trunk is still bark. */
function mix(a, b) {
  const read = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const [x, y] = [read(a), read(b)];
  return '#' + x.map((v, i) => Math.round((v + y[i]) / 2).toString(16).padStart(2, '0')).join('');
}

function palette({ ground, leaf }) {
  const from = { ground, leaf };
  const out = {};
  for (const [key, [source, sat, light]] of Object.entries(LADDER)) {
    out[key] = hsl(from[source], 0, sat, light);
  }
  out.trunk = mix(BARK, hsl(leaf, 0, -12, 30));
  out.trees = TREES.map(([shift, sat, light]) => hsl(leaf, shift, sat, light));
  return out;
}

const repalette = process.argv.includes('--repalette');
const existing = existsSync(join(scenes, 'index.json'))
  ? JSON.parse(readFileSync(join(scenes, 'index.json'), 'utf8'))
  : [];
const authored = new Map(existing.map((scene) => [scene.id, scene.ground]));

const files = readdirSync(scenes).filter((f) => f.endsWith('.webp')).sort();
const order = Object.keys(NAMES);
files.sort((a, b) => {
  const rank = (f) => {
    const i = order.indexOf(basename(f, '.webp'));
    return i < 0 ? order.length : i;
  };
  return rank(a) - rank(b) || a.localeCompare(b);
});

const { server, url } = await serve(0);
const browser = await chromium.launch({
  args: ['--no-sandbox'],
  executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined
});
const page = await browser.newPage();
await page.goto(`${url}__blank`);

const registry = [];
for (const file of files) {
  const id = basename(file, '.webp');
  const result = await page.evaluate(async (src) => {
    const image = new Image();
    image.src = src;
    await image.decode();

    /*
     * The sky, as the fog will have to match it. The top of the painting is
     * where the game's own empty space meets it, and an average over that band
     * is steadier than any single pixel — these are watercolours, and no two
     * pixels of the same sky are the same colour.
     */
    const read = document.createElement('canvas');
    read.width = 160;
    read.height = 90;
    const rc = read.getContext('2d', { willReadFrequently: true });
    rc.drawImage(image, 0, 0, read.width, read.height);
    const band = rc.getImageData(0, 0, read.width, Math.round(read.height * 0.45)).data;
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < band.length; i += 4) { r += band[i]; g += band[i + 1]; b += band[i + 2]; }
    const pixels = band.length / 4;
    const hex = (v) => Math.round(v / pixels).toString(16).padStart(2, '0');

    /*
     * Two more samples, for the ground in front of the painting. The land is
     * the bottom of the image — whatever the painting stands on, with the
     * lightest quarter of it dropped, because in a painting with an open sky
     * that quarter is sky. The leaf is the most coloured thing in the lower
     * half, found by averaging the pixels above that half's own median
     * saturation; taking it from the whole image instead let a big orange sky
     * decide what colour the trees in front of it were. Both come back as hue
     * and saturation only: the ladder decides how light they end up.
     */
    const hueOf = (pixel) => {
      const [red, green, blue] = pixel.map((v) => v / 255);
      const max = Math.max(red, green, blue);
      const min = Math.min(red, green, blue);
      const light = (max + min) / 2;
      const chroma = max - min;
      if (!chroma) return [0, 0];
      const saturation = chroma / (1 - Math.abs(2 * light - 1));
      let hue;
      if (max === red) hue = ((green - blue) / chroma) % 6;
      else if (max === green) hue = (blue - red) / chroma + 2;
      else hue = (red - green) / chroma + 4;
      return [((hue * 60) % 360 + 360) % 360, Math.min(1, saturation) * 100];
    };
    /* Averaged around the circle, because hue wraps and a plain mean of 350
     * and 10 is 180 — the exact opposite of both. */
    const meanHue = (list) => {
      let x = 0, y = 0, s = 0;
      for (const [hue, sat] of list) {
        x += Math.cos(hue * Math.PI / 180);
        y += Math.sin(hue * Math.PI / 180);
        s += sat;
      }
      const hue = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
      return [Math.round(hue), Math.round(s / list.length)];
    };
    const at = (data, i) => [data[i], data[i + 1], data[i + 2]];

    const luma = (pixel) => 0.2126 * pixel[0] + 0.7152 * pixel[1] + 0.0722 * pixel[2];
    const top = Math.round(read.height * 0.78);
    const floor = rc.getImageData(0, top, read.width, read.height - top).data;
    const ground = [];
    for (let i = 0; i < floor.length; i += 4) ground.push(at(floor, i));
    const bright = [...ground].sort((a, b) => luma(a) - luma(b));
    const dark = new Set(bright.slice(0, Math.round(bright.length * 0.75)));
    const land = ground.filter((pixel) => dark.has(pixel)).map(hueOf);

    const half = Math.round(read.height * 0.5);
    const lower = rc.getImageData(0, half, read.width, read.height - half).data;
    const every = [];
    for (let i = 0; i < lower.length; i += 4) every.push(hueOf(at(lower, i)));
    const median = [...every].sort((a, b) => a[1] - b[1])[Math.floor(every.length / 2)][1];
    const coloured = every.filter(([, sat]) => sat >= median);

    // The thumbnail, at the same 16:9 the painting already is.
    const small = document.createElement('canvas');
    small.width = 192;
    small.height = 108;
    small.getContext('2d').drawImage(image, 0, 0, small.width, small.height);
    return {
      sky: `#${hex(r)}${hex(g)}${hex(b)}`,
      land: meanHue(land.length ? land : [[0, 0]]),
      leaf: meanHue(coloured.length ? coloured : land),
      width: image.naturalWidth,
      height: image.naturalHeight,
      thumb: small.toDataURL('image/webp', 0.82)
    };
  }, `${url}assets/scenes/${file}`);

  const thumb = `thumbs/${id}.webp`;
  writeFileSync(join(scenes, thumb),
    Buffer.from(result.thumb.split(',')[1], 'base64'));
  const [name, nameChinese] = NAMES[id] || [id.replace(/-/g, ' '), ''];
  const kept = !repalette && authored.get(id);
  const ground = kept || palette({ ground: result.land, leaf: result.leaf });
  registry.push({ id, name, nameChinese, file, thumb, sky: result.sky, ground });
  console.log(`${id.padEnd(14)} sky ${result.sky}  grass ${ground.grass}` +
    `  trees ${ground.trees[0]}${kept ? '  (kept)' : ''}`);
}

writeFileSync(join(scenes, 'index.json'), JSON.stringify(registry, null, 2) + '\n');
console.log(`\n${registry.length} scenes -> assets/scenes/index.json`);

await browser.close();
server.close();
