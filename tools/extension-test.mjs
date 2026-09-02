import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * Loads the repository as an unpacked Chrome extension and plays the game from
 * inside it.
 *
 * The http:// smoke test proves the game works. It does not prove the game
 * works *as an extension*, and the ways that differ are exactly the ways
 * extensions break: a page served from chrome-extension:// rather than a
 * server, a manifest that names a file that is not there, a fetch of a bundled
 * asset that the extension's own CSP refuses. None of that shows up until it
 * is loaded the way a player loads it.
 */

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const shots = join(root, '.smoke');
mkdirSync(shots, { recursive: true });

let passed = 0;
let failed = 0;
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`PASS  ${label}${detail ? ' — ' + detail : ''}`); }
  else { failed++; console.log(`FAIL  ${label}${detail ? ' — ' + detail : ''}`); }
}

/*
 * Before launching anything: does every file the extension names actually
 * exist?
 *
 * This is here because it did not, and a user found out instead of the tests.
 * dist/bundle.js is a build artifact that was excluded from the repository, so
 * a fresh clone loaded unpacked reported net::ERR_FILE_NOT_FOUND to a console
 * nobody had open and sat on a loading screen. Every check below this line
 * passed throughout, because they all ran in a working tree that had been
 * built. Checking the references themselves is the only thing that catches it.
 */
const referenced = [];
const html = readFileSync(join(root, 'index.html'), 'utf8');
for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
  const url = match[1];
  if (!/^(https?:|data:|#)/.test(url)) referenced.push(url);
}
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
referenced.push(manifest.background.service_worker, ...Object.values(manifest.icons));

const absent = referenced.filter((file) => !existsSync(join(root, file)));
check('every file the extension references exists', absent.length === 0,
  absent.length ? `missing: ${absent.join(', ')}` : `${referenced.length} checked`);

const profile = mkdtempSync(join(tmpdir(), 'niulai-fight-'));
const context = await chromium.launchPersistentContext(profile, {
  headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined,
  viewport: { width: 1280, height: 720 },
  args: [
    '--no-sandbox',
    '--enable-unsafe-swiftshader',
    `--disable-extensions-except=${root}`,
    `--load-extension=${root}`
  ]
});

// The service worker registering at all is the first thing that can go wrong:
// a manifest pointing at a missing file fails here and nowhere else.
let worker = context.serviceWorkers()[0];
if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20000 }).catch(() => null);
check('the extension loads and its service worker starts', Boolean(worker));

const id = worker ? new URL(worker.url()).host : null;
check('the extension has an id', Boolean(id), id || '');

const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
page.on('response', (r) => { if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`); });
page.on('requestfailed', (r) => errors.push(`request failed ${r.url()}`));

await page.goto(`chrome-extension://${id}/index.html`, { waitUntil: 'load' });
// The select screen comes first now, so the harness picks for itself.
await page.waitForFunction(() => globalThis.__niulaiFight, null, { timeout: 60000 });
await page.evaluate(() => globalThis.__niulaiFight.choose('niulai'));
await page.waitForFunction(() => globalThis.__niulaiFight.game, null, { timeout: 60000 });
check('the game page opens from chrome-extension://', true, page.url().slice(0, 42) + '…');

/*
 * The models and the backdrop are fetched at runtime. Under an extension's
 * CSP that is the step most likely to be refused, and a caught failure would
 * otherwise leave a game that runs with invisible characters.
 */
const loaded = await page.evaluate(() => {
  const g = globalThis.__niulaiFight.game;
  return { models: Object.keys(g.gltfs), children: g.scene.children.length };
});
check('bundled models load inside the extension',
  loaded.models.includes('niulai') && loaded.models.includes('wolfwolf'), loaded.models.join(', '));
check('the stage was built', loaded.children > 4, `${loaded.children} objects in the scene`);

await page.evaluate(() => globalThis.__niulaiFight.stop());

// And it has to actually play, not merely load.
const played = await page.evaluate(() => {
  const api = globalThis.__niulaiFight;
  api.press('right');
  const walked = api.step(6);
  api.release('right');
  const wolf = api.game.enemies[0];
  if (!wolf) return { walked, punched: false };

  // Put both fighters in a known state first. Six seconds of walking leaves
  // whatever it leaves — a stunned wolf, a player mid-swing — and a punch
  // check that starts from "whatever happened" measures the weather.
  const player = api.game.player;
  player.health = player.maxHealth;
  player.dead = false;
  player.downTimer = 0; player.stunTimer = 0; player.attackTimer = 0;
  player.facing = 1;
  wolf.root.position.set(player.position.x + 0.6, 0, player.position.z);
  wolf.stunTimer = 0; wolf.downTimer = 0; wolf.attackTimer = 0;
  wolf.invulnerable = 0; wolf.dead = false; wolf.health = wolf.maxHealth;

  const before = wolf.health;
  api.press('punch');
  api.step(player.timings.punch + 0.2);
  return { walked, punched: wolf.health < before };
});
check('the player walks and wolves appear', played.walked.x > 3 && played.walked.enemies > 0,
  `x=${played.walked.x.toFixed(1)}, ${played.walked.enemies} wolves`);
check('a punch connects inside the extension', played.punched);

await page.screenshot({ path: join(shots, '4-extension.png') });
check('no errors while running as an extension', errors.length === 0, errors[0] || '');

console.log(`\n${passed} passed, ${failed} failed.`);
await context.close();
process.exit(failed ? 1 : 0);
