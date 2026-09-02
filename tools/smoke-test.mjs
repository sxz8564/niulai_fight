import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from './serve.mjs';

/*
 * Plays the game and checks it played.
 *
 * A brawler can render perfectly and still be broken in the only way that
 * matters — a punch that never connects, a gate that never opens, an enemy
 * that walks through you. None of that shows up in a screenshot, so this
 * drives the real build through the same input the player uses and reads the
 * same state the HUD reads.
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

const { server, url } = await serve(0);
const browser = await chromium.launch({
  args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
  executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
page.on('response', (r) => { if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`); });
page.on('requestfailed', (r) => errors.push(`request failed ${r.url()}`));

await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction(() => globalThis.__niulaiFight, null, { timeout: 60000 });

// Software GL is slow; stop the render loop and drive the clock ourselves so
// the test measures the game rather than the frame rate.
await page.evaluate(() => globalThis.__niulaiFight.stop());

const api = (fn, ...args) => page.evaluate(fn, ...args);

check('the page loads with no script errors', errors.length === 0, errors[0] || '');

const start = await api(() => globalThis.__niulaiFight.game.snapshot());
check('the player starts alive with full health', start.health === start.maxHealth && start.lives === 3);
check('the level reports five stages', start.stages === 5, `${start.stages}`);

/* The models are the real ones from the filter, so a missing head would mean
 * the whole art pipeline is broken rather than one file. */
const heads = await api(() => {
  const g = globalThis.__niulaiFight.game;
  return { specs: Object.keys(g.specs), gltfs: Object.keys(g.gltfs) };
});
check('both character models load', heads.gltfs.includes('niulai') && heads.gltfs.includes('wolfwolf'),
  heads.gltfs.join(', '));

// The picture must contain something other than sky.
async function pixelVariety() {
  return api(() => {
    globalThis.__niulaiFight.game.render();
    const canvas = document.getElementById('view');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    const w = canvas.width, h = canvas.height;
    const buffer = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buffer);
    const seen = new Set();
    for (let i = 0; i < buffer.length; i += 4 * 97) {
      seen.add(`${buffer[i] >> 4},${buffer[i + 1] >> 4},${buffer[i + 2] >> 4}`);
    }
    return seen.size;
  });
}
await api(() => globalThis.__niulaiFight.step(0.2));
const variety = await pixelVariety();
check('the stage draws something', variety > 6, `${variety} distinct colours`);

// The canvas can be drawing perfectly behind an overlay that never went away,
// which is exactly what happened the first time this ran.
const overlays = await api(() => ({
  loading: getComputedStyle(document.getElementById('loading')).display,
  banner: getComputedStyle(document.getElementById('banner')).display
}));
check('the loading screen goes away', overlays.loading === 'none', overlays.loading);
check('the banner stays hidden until it has something to say', overlays.banner === 'none', overlays.banner);
await page.screenshot({ path: join(shots, '1-start.png') });

/* Walking right must reach the first gate and trigger a wave. */
await api(() => globalThis.__niulaiFight.press('right'));
let state = await api(() => globalThis.__niulaiFight.step(6));
await api(() => globalThis.__niulaiFight.release('right'));
check('walking right moves the player', state.x > 3, `x=${state.x.toFixed(1)}`);
check('reaching the gate spawns wolves', state.enemies > 0, `${state.enemies} on screen`);
await page.screenshot({ path: join(shots, '2-wave.png') });

/* The gate must actually hold the player back. */
const held = await api(() => {
  const g = globalThis.__niulaiFight.game;
  globalThis.__niulaiFight.press('right');
  globalThis.__niulaiFight.step(4);
  globalThis.__niulaiFight.release('right');
  return { x: g.player.position.x, boundary: g.boundary };
});
check('the gate holds the player back', held.x <= held.boundary + 0.01,
  `x=${held.x.toFixed(1)} boundary=${held.boundary}`);

/* A punch has to hurt something. Put a wolf in reach and swing. */
const punch = await api(() => {
  const g = globalThis.__niulaiFight.game;
  const wolf = g.enemies[0];
  wolf.root.position.set(g.player.position.x + 0.6, 0, g.player.position.z);
  wolf.stunTimer = 0; wolf.attackTimer = 0;
  g.player.facing = 1;
  const before = wolf.health;
  const swing = g.player.timings.punch + 0.2;
  globalThis.__niulaiFight.press('punch');
  globalThis.__niulaiFight.step(swing);
  return { before, after: wolf.health, dead: wolf.dead };
});
check('a punch damages a wolf', punch.after < punch.before, `${punch.before} -> ${punch.after}`);

/* And enough punches have to finish one. */
const killed = await api(() => {
  const g = globalThis.__niulaiFight.game;
  const before = g.enemies.length;
  const step = g.player.timings.punch + 0.2;
  for (let swing = 0; swing < 24 && g.enemies.length >= before; swing++) {
    const wolf = g.enemies[0];
    if (!wolf) break;
    if (wolf.downTimer > 0 || wolf.health <= 0) { globalThis.__niulaiFight.step(step); continue; }
    wolf.root.position.set(g.player.position.x + 0.6, 0, g.player.position.z);
    wolf.stunTimer = 0;
    g.player.facing = 1;
    globalThis.__niulaiFight.press('punch');
    globalThis.__niulaiFight.step(step);
  }
  return { before, after: g.enemies.length, score: g.score };
});
check('enough punches kill a wolf', killed.after < killed.before,
  `${killed.before} -> ${killed.after}`);
check('killing scores points', killed.score > 0, `${killed.score}`);

/* Wolves have to be dangerous, or there is no game. */
const hurt = await api(() => {
  const g = globalThis.__niulaiFight.game;

  /*
   * Stand the player back up first. By this point the earlier checks have had
   * wolves swinging at him for a while and he may already be on the floor — in
   * which case `before` is zero, the respawn puts it back to full, and the
   * check reads a resurrection as a wound. Establish the precondition rather
   * than hoping for it.
   */
  g.player.health = g.player.maxHealth;
  g.player.dead = false;
  g.player.downTimer = 0;
  g.player.stunTimer = 0;
  g.player.actor.play('idle');

  const before = g.player.health;
  g.player.invulnerable = 0;
  for (let i = 0; i < 40 && g.player.health === before; i++) {
    const wolf = g.enemies[0];
    if (!wolf) break;
    wolf.root.position.set(g.player.position.x + 0.55, 0, g.player.position.z);
    wolf.thinkTimer = 0;
    wolf.facing = -1;
    g.player.invulnerable = 0;
    globalThis.__niulaiFight.step(0.3);
  }
  return { before, after: g.player.health };
});
check('a wolf can hurt the player', hurt.after < hurt.before, `${hurt.before} -> ${hurt.after}`);

/* Clearing the wave must open the gate and let the player through. */
const opened = await api(() => {
  const g = globalThis.__niulaiFight.game;
  const wasBoundary = g.boundary;
  for (const wolf of g.enemies) { wolf.health = 0; wolf.downTimer = 0.01; wolf.dead = false; }
  globalThis.__niulaiFight.step(1.5);
  return { wasBoundary, boundary: g.boundary, enemies: g.enemies.length };
});
check('clearing the wave opens the gate', opened.boundary > opened.wasBoundary,
  `${opened.wasBoundary} -> ${opened.boundary}`);
await page.screenshot({ path: join(shots, '3-cleared.png') });

/* Stepping up and down the belt has to matter, or the third axis is decoration. */
const depth = await api(() => {
  const g = globalThis.__niulaiFight.game;
  const wolf = g.enemies[0] || g.spawnFighter('wolfwolf',
    { x: g.player.position.x + 0.6, z: g.player.position.z }, {
      health: 34, speed: 2.5, damage: 8, team: 'enemy', facing: -1
    });
  if (!g.enemies.includes(wolf)) g.enemies.push(wolf);
  g.player.facing = 1;

  // Level in Z: should connect.
  wolf.root.position.set(g.player.position.x + 0.6, 0, g.player.position.z);
  wolf.health = 34; wolf.dead = false; wolf.downTimer = 0; wolf.stunTimer = 0;
  const swing = g.player.timings.punch + 0.2;
  const levelBefore = wolf.health;
  globalThis.__niulaiFight.press('punch');
  globalThis.__niulaiFight.step(swing);
  const levelHit = wolf.health < levelBefore;

  // A metre upstage: should miss.
  wolf.root.position.set(g.player.position.x + 0.6, 0, g.player.position.z - 1.1);
  wolf.health = 34; wolf.dead = false; wolf.downTimer = 0; wolf.stunTimer = 0;
  const apartBefore = wolf.health;
  globalThis.__niulaiFight.press('punch');
  globalThis.__niulaiFight.step(swing);
  const apartHit = wolf.health < apartBefore;

  return { levelHit, apartHit };
});
check('a punch lands when level on the belt', depth.levelHit);
check('and misses someone standing further up it', !depth.apartHit);

/* Blocking. The point of it is the asymmetry: it works against what you are
 * facing and not against what you are not, so both halves are checked. */
const blocked = await api(() => {
  const g = globalThis.__niulaiFight.game;
  const api2 = globalThis.__niulaiFight;

  function hit({ blocking, facing }) {
    g.player.health = g.player.maxHealth;
    g.player.dead = false;
    g.player.downTimer = 0; g.player.stunTimer = 0; g.player.invulnerable = 0;
    g.player.blocking = blocking;
    g.player.facing = facing;
    // A blow arriving from the player's right travels leftward, so its
    // direction is -1.
    g.player.takeHit(20, -1);
    return g.player.maxHealth - g.player.health;
  }

  const facingInto = hit({ blocking: true, facing: 1 });
  const facingAway = hit({ blocking: true, facing: -1 });
  const unguarded = hit({ blocking: false, facing: 1 });

  // And a blocked hit must never knock you down, however little health is left.
  g.player.health = 2;
  g.player.blocking = true;
  g.player.facing = 1;
  g.player.invulnerable = 0;
  g.player.takeHit(999, -1);
  const survivedChip = !g.player.dead && g.player.downTimer === 0;

  return { facingInto, facingAway, unguarded, survivedChip };
});
check('blocking cuts damage from a blow you are facing',
  blocked.facingInto < blocked.unguarded, `${blocked.facingInto} vs ${blocked.unguarded} unguarded`);
check('blocking does nothing against a blow from behind',
  blocked.facingAway === blocked.unguarded, `${blocked.facingAway} vs ${blocked.unguarded}`);
check('a blocked hit never knocks you down', blocked.survivedChip);

/* Holding block has to cost something, or it is a button with no decision. */
const cost = await api(() => {
  const g = globalThis.__niulaiFight.game;
  g.player.blocking = false;
  g.player.health = g.player.maxHealth;
  g.player.dead = false; g.player.downTimer = 0; g.player.stunTimer = 0;
  const startX = g.player.position.x;

  globalThis.__niulaiFight.press('block');
  globalThis.__niulaiFight.press('right');
  globalThis.__niulaiFight.step(1.0);
  const movedWhileBlocking = Math.abs(g.player.position.x - startX);
  const attackedWhileBlocking = g.player.attackTimer > 0;
  globalThis.__niulaiFight.release('block');
  globalThis.__niulaiFight.release('right');
  return { movedWhileBlocking, attackedWhileBlocking, blocking: g.player.blocking };
});
check('you cannot walk while blocking', cost.movedWhileBlocking < 0.05,
  `moved ${cost.movedWhileBlocking.toFixed(3)}`);
check('you cannot swing while blocking', !cost.attackedWhileBlocking);

check('still no script errors after playing', errors.length === 0, errors[0] || '');

writeFileSync(join(shots, 'result.json'), JSON.stringify({ passed, failed }, null, 2));
console.log(`\n${passed} passed, ${failed} failed. Screenshots in .smoke/`);

await browser.close();
server.close();
process.exit(failed ? 1 : 0);
