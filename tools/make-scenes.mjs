import { createRequire } from 'node:module';
import { readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from './serve.mjs';

/*
 * Builds the scene registry from whatever is in assets/scenes.
 *
 * Two things come out of each painting, and neither is worth doing by eye. The
 * first is a thumbnail small enough that the roster can show all of them at
 * once — seven full backdrops is the better part of a megabyte, which is a
 * silly price for a menu. The second is the sky colour: the game fogs distant
 * trees into the backdrop and paints the empty space above it, and picking
 * that colour by hand for seven paintings would be seven chances to get it
 * slightly wrong. Sampling the top of the image cannot be wrong.
 *
 *   node tools/make-scenes.mjs
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

    // The thumbnail, at the same 16:9 the painting already is.
    const small = document.createElement('canvas');
    small.width = 192;
    small.height = 108;
    small.getContext('2d').drawImage(image, 0, 0, small.width, small.height);
    return {
      sky: `#${hex(r)}${hex(g)}${hex(b)}`,
      width: image.naturalWidth,
      height: image.naturalHeight,
      thumb: small.toDataURL('image/webp', 0.82)
    };
  }, `${url}assets/scenes/${file}`);

  const thumb = `thumbs/${id}.webp`;
  writeFileSync(join(scenes, thumb),
    Buffer.from(result.thumb.split(',')[1], 'base64'));
  const [name, nameChinese] = NAMES[id] || [id.replace(/-/g, ' '), ''];
  registry.push({ id, name, nameChinese, file, thumb, sky: result.sky });
  console.log(`${id.padEnd(14)} ${result.width}x${result.height}  sky ${result.sky}`);
}

writeFileSync(join(scenes, 'index.json'), JSON.stringify(registry, null, 2) + '\n');
console.log(`\n${registry.length} scenes -> assets/scenes/index.json`);

await browser.close();
server.close();
