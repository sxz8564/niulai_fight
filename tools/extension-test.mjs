import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync } from 'node:fs';
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
await page.waitForFunction(() => globalThis.__niulaiFight, null, { timeout: 60000 });
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
  wolf.root.position.set(api.game.player.position.x + 0.6, 0, api.game.player.position.z);
  api.game.player.facing = 1;
  const before = wolf.health;
  api.press('punch');
  api.step(0.5);
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
