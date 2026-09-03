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
  // Muted: the suite checks that the shout decodes, not that a headless box on
  // a machine with no sound card can open an audio device.
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio'],
  executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

/*
 * Two different things, kept apart.
 *
 * `errors` is the game misbehaving: a thrown exception, a console error, a
 * response the server refused. Any of those is a defect.
 *
 * `transients` is the network dropping a request that the loader then retried
 * successfully — observed here as net::ERR_ABORTED on a model, from the
 * dev-server path only, never from chrome-extension://. Recovering from that
 * is what the retry is *for*, so counting it as a failure would mean the
 * feature working correctly turned the suite red. They are still printed,
 * because a rise in them is worth seeing, and an asset that genuinely cannot
 * load still fails: the loader throws on the second attempt, which lands in
 * `errors`, and the extension suite checks every referenced file exists.
 */
const errors = [];
const transients = [];
page.on('pageerror', (error) => errors.push(String(error)));
page.on('response', (r) => { if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`); });
page.on('requestfailed', (r) => {
  const why = r.failure() ? r.failure().errorText : 'unknown';
  transients.push(`${why} ${r.url().replace(/^https?:\/\/[^/]+/, '')}`);
});

await page.goto(url, { waitUntil: 'load' });
// The select screen comes first now, so the harness picks for itself.
await page.waitForFunction(() => globalThis.__niulaiFight, null, { timeout: 60000 });
await page.evaluate(() => globalThis.__niulaiFight.choose('niulai'));
await page.waitForFunction(() => globalThis.__niulaiFight.game, null, { timeout: 60000 });

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
check('the boss model loads', heads.gltfs.includes('cart'), heads.gltfs.join(', '));

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

  // Both fighters into a known state. Ten seconds of walking past wolves
  // leaves the player as likely as not in hitstun, and a punch pressed then is
  // buffered for a quarter second and dropped — the check measures the weather
  // rather than the punch.
  const p = g.player;
  p.health = p.maxHealth;
  p.dead = false; p.downTimer = 0; p.stunTimer = 0; p.attackTimer = 0;
  p.blocking = false;
  g.buffered = null;

  const wolf = g.enemies[0];
  wolf.root.position.set(p.position.x + 0.6, 0, p.position.z);
  wolf.stunTimer = 0; wolf.attackTimer = 0; wolf.downTimer = 0;
  wolf.invulnerable = 0; wolf.dead = false;
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

/*
 * Every wolf on the field must have a body of its own.
 *
 * The bug this exists for: all actors of one kind were handed the same
 * gltf.scene, and a three.js object has one parent — so spawning the second
 * wolf took the mesh out of the first. That wolf went invisible while
 * remaining a Fighter: it still blocked the player and still landed punches.
 * A phantom, reported by a player and invisible to every other check here,
 * because nothing else asks whether a thing that can hit you can be seen.
 */
const bodies = await api(() => {
  const g = globalThis.__niulaiFight.game;
  // Enough wolves at once that a shared model would show.
  while (g.enemies.length < 3) {
    g.spawnQueue = 3 - g.enemies.length;
    g.spawnTimer = 0;
    globalThis.__niulaiFight.step(2);
  }

  const meshes = [];
  let withoutABody = 0;
  for (const wolf of g.enemies) {
    let found = null;
    wolf.root.traverse((node) => { if (node.isSkinnedMesh || node.isMesh) found = found || node; });
    if (!found) withoutABody++;
    else meshes.push(found.uuid);
  }
  return {
    wolves: g.enemies.length,
    withoutABody,
    distinct: new Set(meshes).size,
    // A shared skeleton would make every copy animate as one.
    distinctSkeletons: new Set(g.enemies.map((wolf) => {
      let skeleton = null;
      wolf.root.traverse((node) => { if (node.isSkinnedMesh) skeleton = skeleton || node.skeleton; });
      return skeleton ? skeleton.uuid : 'none';
    })).size
  };
});
check('every wolf has a body', bodies.withoutABody === 0,
  `${bodies.wolves} wolves, ${bodies.withoutABody} invisible`);
check('no two wolves share one mesh', bodies.distinct === bodies.wolves,
  `${bodies.distinct} meshes for ${bodies.wolves} wolves`);
check('no two wolves share one skeleton', bodies.distinctSkeletons === bodies.wolves,
  `${bodies.distinctSkeletons} skeletons for ${bodies.wolves} wolves`);

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


/* ---------------------------------------------------------------- the boss --
 *
 * The Cart is a different question from the wolves, and every check below is
 * that question from a different side: is its one attack answerable? A charge
 * you cannot see coming, cannot step out of the way of, or cannot punish is not
 * a boss fight, it is a damage tax.
 */

/* Puts the game at the last gate with the Cart on the field and nothing else,
 * so what follows measures the boss rather than whichever wolf wandered in. */
await api(() => {
  globalThis.__toBoss = () => {
    const g = globalThis.__niulaiFight.game;
    for (let i = 0; i < g.gates.length - 1; i++) g.gates[i].opened = true;
    g.gateIndex = g.gates.length - 1;
    const gate = g.gates[g.gateIndex];
    gate.opened = false;
    for (const e of g.enemies) g.scene.remove(e.root);
    g.enemies = [];
    g.boss = null;
    g.spawnQueue = 0;
    g.over = false; g.won = false; g.lives = 3;
    g.player.position.set(gate.x - 5, 0, 0.2);
    g.player.health = g.player.maxHealth;
    g.player.dead = false; g.player.downTimer = 0; g.player.stunTimer = 0;
    g.player.attackTimer = 0; g.player.invulnerable = 0; g.player.blocking = false;
    g.buffered = null;

    globalThis.__niulaiFight.step(0.2);   // the gate opens and the Cart rolls in
    g.spawnQueue = 0;                     // its escort would only muddy a measurement
    for (const e of g.enemies) if (!g.boss || e !== g.boss.fighter) g.scene.remove(e.root);
    g.enemies = g.enemies.filter((e) => g.boss && e === g.boss.fighter);
    return g.boss;
  };

  /* One charge, start to finish, with the player placed and posed by the
   * caller. Returns what it cost them. */
  globalThis.__oneCharge = ({ lane = 0, blocking = false, facing = 1 } = {}) => {
    const g = globalThis.__niulaiFight.game;
    const b = g.boss;
    const f = b.fighter;
    f.position.set(g.player.position.x + 3.4, 0, 0);
    g.player.position.z = lane;
    g.player.health = g.player.maxHealth;
    g.player.dead = false; g.player.downTimer = 0; g.player.stunTimer = 0;
    g.player.invulnerable = 0;
    g.player.facing = facing;
    if (blocking) globalThis.__niulaiFight.press('block');
    b.enter('wind');
    const before = g.player.health;
    for (let t = 0; t < 40 && b.phase !== 'recover'; t++) {
      g.player.facing = facing;          // held: the charge is what is being measured
      globalThis.__niulaiFight.step(0.1);
    }
    if (blocking) globalThis.__niulaiFight.release('block');
    return { before, after: g.player.health, cost: before - g.player.health };
  };
});

const bossArrived = await api(() => {
  const g = globalThis.__niulaiFight.game;
  const boss = globalThis.__toBoss();
  let mesh = null;
  boss.fighter.root.traverse((node) => { if (node.isMesh) mesh = mesh || node; });
  return {
    lastGateIsBoss: !!g.gates[g.gates.length - 1].boss,
    spawned: !!boss,
    phase: boss.phase,
    health: boss.fighter.health,
    counted: g.enemies.includes(boss.fighter),
    hasABody: !!mesh,
    hurtRadius: boss.fighter.hurtRadius
  };
});
check('the last stage is a boss stage', bossArrived.lastGateIsBoss);
check('the Cart rolls in at the last gate', bossArrived.spawned && bossArrived.health > 0,
  `${bossArrived.health} hp, ${bossArrived.phase}`);
check('the boss counts as an enemy, so the gate cannot open past it', bossArrived.counted);
check('the boss has a body', bossArrived.hasABody);
await api(() => globalThis.__niulaiFight.step(0.6));
await page.screenshot({ path: join(shots, '4-boss.png') });

/*
 * The wind-up. This is the whole fight: a second of standing still is the only
 * warning the charge gives, and if it ever moves during it the tell is a lie.
 */
const tell = await api(() => {
  const g = globalThis.__niulaiFight.game;
  const b = g.boss;
  b.enter('wind');
  const startX = b.fighter.position.x;
  globalThis.__niulaiFight.step(0.8);
  const stillWinding = b.phase === 'wind';
  const drifted = Math.abs(b.fighter.position.x - startX);
  const pose = b.fighter.pose;
  globalThis.__niulaiFight.step(0.4);
  return { stillWinding, drifted, pose, then: b.phase };
});
check('the boss pauses before it charges', tell.stillWinding && tell.then === 'charge',
  `${tell.pose} for a second, then ${tell.then}`);
check('and does not move an inch while it winds up', tell.drifted < 0.02,
  `drifted ${tell.drifted.toFixed(4)}`);

/*
 * The charge is a straight line. Not a simplification — it is the reason the
 * fight has an answer: it commits to a lane, so stepping off that lane is the
 * dodge. A charge that tracked the player in Z would be unavoidable.
 */
const line = await api(() => {
  const g = globalThis.__niulaiFight.game;
  const b = g.boss;
  const f = b.fighter;
  f.position.set(g.player.position.x + 3.5, 0, 0);
  g.player.position.z = 1.2;         // well off the line, and it must not follow
  b.enter('wind');
  globalThis.__niulaiFight.step(1.05);
  const z0 = f.position.z;
  const x0 = f.position.x;
  globalThis.__niulaiFight.step(0.3);
  const chargeSpeed = Math.abs(f.position.x - x0) / 0.3;
  // Read now, not at the return. Stalking steers in Z on purpose, so measuring
  // the drift after the comparison below reads the wrong phase entirely — which
  // is exactly what this check did on its first run, and it failed the game for
  // doing the right thing.
  const drift = Math.abs(f.position.z - z0);
  const phase = b.phase;

  // What it manages in the same time while merely stalking, for comparison.
  b.enter('stalk');
  b.timer = 99;                      // stalking, not lining up for another one
  const x1 = f.position.x;
  globalThis.__niulaiFight.step(0.3);
  const stalkSpeed = Math.abs(f.position.x - x1) / 0.3;

  return { drift, phase, chargeSpeed, stalkSpeed };
});
check('the charge holds its lane', line.phase === 'charge' && line.drift < 0.02,
  `${line.phase}, drifted ${line.drift.toFixed(4)} in Z`);
check('the charge is much faster than it rolls', line.chargeSpeed > line.stalkSpeed * 3,
  `${line.chargeSpeed.toFixed(1)} vs ${line.stalkSpeed.toFixed(1)} units/s`);

/*
 * And it can do it anywhere the player can stand.
 *
 * The Cart's arena — the thing that ends a charge when it runs out of room —
 * used to be a window fifteen units either side of the last gate, while the
 * player is free to walk the whole level. Retreat past the left edge of that
 * window and every charge hit the "wall" on its first frame and went straight
 * to recovery: the Cart followed you around for ever and could not touch you.
 * The two of them get the same box now, and this is the check that says so.
 */
const reach = await api(() => {
  const g = globalThis.__niulaiFight.game;
  const boss = globalThis.__toBoss();
  const f = boss.fighter;

  // Where the player can actually get to, asked rather than assumed.
  g.player.position.set(-999, 0, 0.2);
  globalThis.__niulaiFight.step(1 / 60);
  const playerCanReach = g.player.position.x;

  const chargeAt = (where) => {
    g.player.position.set(where, 0, 0.2);
    g.player.health = g.player.maxHealth;
    g.player.dead = false; g.player.downTimer = 0; g.player.stunTimer = 0;
    g.player.attackTimer = 0; g.player.invulnerable = 0; g.player.blocking = false;
    f.position.set(where + 3.4, 0, 0.2);
    f.health = f.maxHealth;
    boss.enter('wind');
    globalThis.__niulaiFight.step(1.05);
    globalThis.__niulaiFight.step(0.5);
    return { where, cost: g.player.maxHealth - g.player.health };
  };

  const gate = g.gates[g.gateIndex];
  const tries = [gate.x - 5, 40, 0, playerCanReach].map(chargeAt);

  /*
   * Put the fight back where it was found. This check deliberately drags it to
   * the far end of the level, and the checks after it are about the Cart rather
   * than about where the Cart is — leaving them standing at the left wall makes
   * them depend on this one, which is how a single change ends up failing five
   * things and none of the messages say why.
   */
  g.player.position.set(gate.x - 5, 0, 0.2);
  g.player.health = g.player.maxHealth;
  g.player.dead = false; g.player.downTimer = 0; g.player.stunTimer = 0;
  g.player.attackTimer = 0; g.player.invulnerable = 0; g.player.blocking = false;
  f.position.set(gate.x - 1.5, 0, 0.2);
  f.health = f.maxHealth;
  boss.enter('stalk');

  return { arena: { ...boss.arena }, playerCanReach, boundary: gate.x, tries };
});
check('the boss is held to the same box as the player',
  reach.arena.min <= reach.playerCanReach && reach.arena.max >= reach.boundary,
  `boss [${reach.arena.min}, ${reach.arena.max}] against a player who reaches ` +
  `[${reach.playerCanReach}, ${reach.boundary}]`);
check('and can land its charge anywhere in it',
  reach.tries.every((attempt) => attempt.cost > 20),
  reach.tries.map((attempt) => `x=${attempt.where}: ${attempt.cost.toFixed(0)}`).join(', '));

/* Standing in the way must hurt, and hurt properly — a boss whose attack costs
 * what a wolf's does is a wolf. */
const ran = await api(() => globalThis.__oneCharge({ lane: 0 }));
const wolfDamage = await api(() => 8);
check('being run over costs a lot of health', ran.cost > wolfDamage * 3,
  `${ran.cost.toFixed(0)} against a wolf's ${wolfDamage}`);

/* And stepping off the line must cost nothing at all. This is the payoff for
 * the third axis: a player can finish the first four stages without ever
 * needing it, and cannot finish this one without it. */
const dodged = await api(() => globalThis.__oneCharge({ lane: 1.25 }));
check('stepping off the line dodges the charge completely', dodged.cost === 0,
  `${dodged.cost.toFixed(0)} damage taken`);

/* Blocking is the other answer, and a worse one — it costs you a share of the
 * damage where moving costs nothing. */
const guarded = await api(() => globalThis.__oneCharge({ lane: 0, blocking: true, facing: 1 }));
check('blocking into the charge cuts the damage', guarded.cost > 0 && guarded.cost < ran.cost,
  `${guarded.cost.toFixed(1)} blocked against ${ran.cost.toFixed(0)} unguarded`);

/*
 * It has to be reachable. The Cart is nearly three units long, so a hit box
 * measured centre to centre — which is how every other fighter is measured —
 * puts its middle further away than an arm can reach while its bodywork is in
 * the player's face. Without hurtRadius it is literally unhittable, and nothing
 * else here would notice: it would simply never lose a fight.
 */
const reached = await api(() => {
  const g = globalThis.__niulaiFight.game;
  const f = g.boss.fighter;
  f.position.set(g.player.position.x + 1.7, 0, g.player.position.z);   // past REACH_X
  g.boss.enter('stalk');
  g.boss.timer = 99;
  f.health = f.maxHealth;
  f.invulnerable = 0;
  g.player.facing = 1;
  g.player.attackTimer = 0; g.player.stunTimer = 0; g.player.blocking = false;
  g.buffered = null;
  const before = f.health;
  globalThis.__niulaiFight.press('punch');
  globalThis.__niulaiFight.step(g.player.timings.punch + 0.2);
  return { before, after: f.health, gap: 1.7 };
});
check('a punch can reach the boss at all', reached.after < reached.before,
  `${reached.before} -> ${reached.after} from ${reached.gap} away`);

/*
 * The punish window. An attack with no recovery has no counterplay, so the
 * stall after a charge is where the fight is actually won — and it is worth
 * more than hitting it any other time.
 */
const punish = await api(() => {
  const g = globalThis.__niulaiFight.game;
  const f = g.boss.fighter;
  const bite = () => {
    f.health = f.maxHealth;
    f.invulnerable = 0;
    f.takeHit(10, 1);
    return f.maxHealth - f.health;
  };
  g.boss.enter('stalk');
  const rolling = bite();
  g.boss.enter('recover');
  const stalled = bite();
  g.boss.enter('stalk');
  return { rolling, stalled };
});
check('the boss takes more damage while it is stalled', punish.stalled > punish.rolling,
  `${punish.stalled} in recovery against ${punish.rolling} while rolling`);

/* Armour: a jab must not stop two tonnes. Otherwise the whole fight collapses
 * into mashing punch and never moving. */
const armour = await api(() => {
  const g = globalThis.__niulaiFight.game;
  const b = g.boss;
  const f = b.fighter;
  f.position.set(g.player.position.x + 3.4, 0, 0);
  f.health = f.maxHealth;
  b.enter('wind');
  globalThis.__niulaiFight.step(1.05);
  const chargingBefore = b.phase;
  f.invulnerable = 0;
  f.takeHit(12, -1);
  globalThis.__niulaiFight.step(0.1);
  return { chargingBefore, phase: b.phase, stun: f.stunTimer, hurt: f.maxHealth - f.health };
});
check('a punch hurts the boss without stopping the charge',
  armour.chargingBefore === 'charge' && armour.phase === 'charge' && armour.stun === 0 && armour.hurt > 0,
  `${armour.hurt} damage, still ${armour.phase}, ${armour.stun}s of stun`);

/* And finally: killing it has to end the level. */
const finished = await api(() => {
  const g = globalThis.__niulaiFight.game;
  const f = g.boss.fighter;
  g.boss.enter('stalk');
  f.invulnerable = 0;
  f.takeHit(f.health, 1);
  const wrecked = f.downTimer > 0;
  globalThis.__niulaiFight.step(4);
  const snap = g.snapshot();
  return { wrecked, over: snap.over, won: snap.won, enemies: snap.enemies, boss: snap.boss };
});
check('the boss goes down rather than vanishing', finished.wrecked);
check('wrecking the boss wins the game', finished.over && finished.won,
  `over=${finished.over} won=${finished.won}`);
check('the boss bar goes away with the boss', finished.boss === null);

/* Back to a clean game for the checks that follow. */
await api(() => {
  const g = globalThis.__niulaiFight.game;
  g.over = false; g.won = false;
  g.gateIndex = 0;
  for (const gate of g.gates) gate.opened = false;
  for (const e of g.enemies) g.scene.remove(e.root);
  g.enemies = []; g.boss = null; g.spawnQueue = 0;
  g.player.position.set(0, 0, 0.2);
  g.player.health = g.player.maxHealth;
  g.player.dead = false; g.player.downTimer = 0; g.player.stunTimer = 0;
});



/* ------------------------------------------------------------------- rage --
 *
 * Niulai's super. The meter is a promise: being surrounded, which the ordinary
 * moveset has no answer to, eventually pays for itself. The checks below are
 * that promise taken apart — does it fill from both halves of a fight, does it
 * refuse to fire early, does firing it actually clear a screen, and does the
 * second it costs come with the protection that makes spending it worth doing.
 */

/* Puts wolves on the field wherever the player is standing. */
await api(() => {
  globalThis.__wolves = (n, spread = 0.7) => {
    const g = globalThis.__niulaiFight.game;
    for (const e of g.enemies) g.scene.remove(e.root);
    g.enemies = [];
    g.boss = null;
    g.spawnQueue = 0;
    for (let i = 0; i < n; i++) {
      const wolf = g.spawnFighter('wolfwolf', {
        x: g.player.position.x + 1.5 + i * 0.8,
        z: -1.2 + i * spread
      }, { health: 34, speed: 2.5, damage: 8, team: 'enemy', facing: -1 });
      wolf.thinkTimer = 99;      // no swinging back: this is about the herd
      g.enemies.push(wolf);
    }
    return g.enemies.length;
  };
});

const meter = await api(() => {
  const g = globalThis.__niulaiFight.game;
  const p = g.power;
  globalThis.__wolves(1);
  p.meter = 0;

  // Landing a hit.
  const wolf = g.enemies[0];
  wolf.root.position.set(g.player.position.x + 0.6, 0, g.player.position.z);
  wolf.health = 34; wolf.dead = false; wolf.stunTimer = 0; wolf.invulnerable = 0;
  g.player.facing = 1;
  g.player.attackTimer = 0; g.player.stunTimer = 0; g.player.blocking = false;
  g.buffered = null;
  globalThis.__niulaiFight.press('punch');
  globalThis.__niulaiFight.step(g.player.timings.punch + 0.2);
  const fromHitting = p.meter;

  // Taking one.
  p.meter = 0;
  g.player.health = g.player.maxHealth;
  g.player.dead = false; g.player.downTimer = 0; g.player.stunTimer = 0;
  g.player.invulnerable = 0;
  g.player.blocking = false;
  g.player.takeHit(8, -1);
  // takeHit is what the game calls; the meter is credited by resolveHits, so
  // drive it the way the game does rather than reaching past it.
  p.meter = 0;
  g.player.invulnerable = 0;
  wolf.root.position.set(g.player.position.x + 0.55, 0, g.player.position.z);
  wolf.facing = -1; wolf.thinkTimer = 0; wolf.stunTimer = 0; wolf.attackTimer = 0;
  wolf.health = 34; wolf.dead = false; wolf.downTimer = 0;
  for (let i = 0; i < 30 && p.meter === 0; i++) {
    g.player.health = g.player.maxHealth;
    g.player.dead = false; g.player.downTimer = 0; g.player.stunTimer = 0;
    g.player.invulnerable = 0;
    wolf.thinkTimer = 0;
    globalThis.__niulaiFight.step(0.25);
  }
  const fromBeingHit = p.meter;
  return { fromHitting, fromBeingHit, max: p.max };
});
check('landing a hit builds rage', meter.fromHitting > 0, `+${meter.fromHitting}`);
check('and so does taking one', meter.fromBeingHit > 0, `+${meter.fromBeingHit}`);
check('being hit is worth more than hitting', meter.fromBeingHit > meter.fromHitting,
  `${meter.fromBeingHit} against ${meter.fromHitting}`);

/* It must refuse to fire on an empty meter, or the meter is decoration. */
const early = await api(() => {
  const g = globalThis.__niulaiFight.game;
  g.power.meter = g.power.max - 1;
  g.player.attackTimer = 0; g.player.stunTimer = 0; g.player.downTimer = 0;
  g.player.dead = false; g.player.blocking = false;
  const fired = g.power.cast(g.player);
  return { fired, ready: g.power.ready, casting: g.power.casting };
});
check('the super will not fire on a meter that is not full', !early.fired && early.casting === 0);

/*
 * A full meter, spent. Everything the move promises, in one go: it empties the
 * meter, plants him in the summon pose, and puts ten of them on the field.
 */
const cast = await api(() => {
  const g = globalThis.__niulaiFight.game;
  const p = g.power;
  globalThis.__wolves(5);
  const before = g.enemies.map((e) => e.health);
  p.meter = p.max;
  g.player.attackTimer = 0; g.player.stunTimer = 0; g.player.downTimer = 0;
  g.player.dead = false; g.player.blocking = false;
  g.buffered = null;

  globalThis.__niulaiFight.press('power');
  globalThis.__niulaiFight.step(0.05);
  const casting = { on: p.casting > 0, meter: p.meter, pose: g.player.pose };

  // Halfway through the cast the herd should be out.
  globalThis.__niulaiFight.step(0.5);
  const herd = p.herd.length;
  const startX = p.herd.map((cow) => cow.actor.root.position.x);
  const lanes = new Set(p.herd.map((cow) => cow.actor.root.position.z.toFixed(2))).size;

  // Untouchable while he is stood there.
  const hp = g.player.health;
  g.player.takeHit(30, -1);
  const tookDamage = g.player.health < hp;

  /*
   * Run it until the herd is gone rather than for a fixed time. How long a
   * stampede takes is a tuning number in the registry — it has been halved once
   * already — and a test that bakes in the old value fails the day someone
   * changes it, which teaches people to distrust the suite rather than the
   * change.
   */
  const moved = [];
  for (let i = 0; i < 60 && p.herd.length; i++) {
    globalThis.__niulaiFight.step(0.2);
    p.herd.forEach((cow, j) => { moved[j] = cow.actor.root.position.x - startX[j]; });
  }
  const endX = moved;
  return {
    casting, herd, lanes, tookDamage,
    ranAllOneWay: endX.every((d) => d > 0),
    left: p.herd.length,
    before,
    after: g.enemies.map((e) => e.health),
    alive: g.enemies.filter((e) => !e.dead && e.health > 0).length,
    pose: g.player.pose,
    casts: p.casts
  };
});
check('the super fires when the meter is full and empties it',
  cast.casting.on && cast.casting.meter === 0, `meter ${cast.casting.meter}`);
check('he is locked in the summon pose while it goes off',
  cast.casting.pose === 'summon', cast.casting.pose);
check('ten mamas arrive', cast.herd === 10, `${cast.herd} of them`);
check('in parallel lines rather than one', cast.lanes >= 4, `${cast.lanes} lanes`);
check('all of them run the same way, left to right', cast.ranAllOneWay);
check('nothing can touch him mid-summon', !cast.tookDamage);
check('the stampede runs over every wolf in its path', cast.alive === 0,
  `${cast.before.length} wolves, ${cast.alive} still standing`);
check('the summon pose is let go when the cast ends', cast.pose === null, String(cast.pose));
check('the herd clears itself off the field', cast.left === 0, `${cast.left} left in the scene`);

/*
 * And it clears itself even from a player who walks away from it.
 *
 * The herd used to retire on leaving the picture, which was safe while it
 * outran everyone. It crosses at less than walking pace now, so a player
 * heading right moves the camera — and with it the finish line — away faster
 * than the cows advance on it, and a cow that can never reach it never leaves
 * the scene. Ten more every cast, for ever.
 */
const trailing = await api(() => {
  const g = globalThis.__niulaiFight.game;
  const gate = g.gates[g.gateIndex];
  const wall = gate.x;
  gate.x = 400;                  // no gate in the way of the measurement
  for (const e of g.enemies) g.scene.remove(e.root);
  g.enemies = []; g.boss = null; g.spawnQueue = 0;
  g.power.clear();
  g.player.position.set(0, 0, 0.2);
  g.player.health = g.player.maxHealth;
  g.player.dead = false; g.player.downTimer = 0; g.player.stunTimer = 0;
  g.player.attackTimer = 0; g.player.blocking = false;
  g.buffered = null;
  g.power.meter = g.power.max;

  globalThis.__niulaiFight.press('power');
  globalThis.__niulaiFight.step(1.2);
  const released = g.power.herd.length;

  globalThis.__niulaiFight.press('right');
  for (let i = 0; i < 40; i++) globalThis.__niulaiFight.step(0.5);
  globalThis.__niulaiFight.release('right');

  const left = g.power.herd.length;
  gate.x = wall;
  g.player.position.set(0, 0, 0.2);
  return { released, left, walkedTo: g.player.position.x };
});
check('the herd retires even when the player walks away from it',
  trailing.released === 10 && trailing.left === 0,
  `${trailing.released} released, ${trailing.left} still following after 20s of walking`);

/*
 * The shout has to be a format the browser will actually decode.
 *
 * The first cut of this shipped the m4a as supplied, which plays in Chrome and
 * does not play in Chromium — no AAC in the open build — so the move was silent
 * for anyone not on Google's binary, and nothing here would have said so. It is
 * Opus in WebM now, and this is the check that keeps it that way.
 */
const shout = await api(async () => {
  const audio = globalThis.__niulaiFight.game.power.shout;
  if (!audio) return { missing: true };
  await new Promise((resolve) => {
    if (audio.readyState >= 1) return resolve();
    audio.addEventListener('loadedmetadata', resolve, { once: true });
    audio.addEventListener('error', resolve, { once: true });
    setTimeout(resolve, 5000);
  });
  return {
    src: audio.src.split('/').slice(-2).join('/'),
    readyState: audio.readyState,
    duration: audio.duration,
    error: audio.error ? audio.error.code : null
  };
});
check('the shout is a format the browser can decode',
  !shout.missing && shout.error === null && shout.duration > 0,
  `${shout.src} — ${shout.duration ? shout.duration.toFixed(2) + 's' : 'no audio'}` +
  `${shout.error ? `, media error ${shout.error}` : ''}`);

/* And the bar itself, which only exists for a fighter that has a super. */
const bar = await page.evaluate(() => {
  const wrap = document.getElementById('ragewrap');
  return { hidden: wrap.hidden, label: document.getElementById('ragelabel').textContent };
});
check('the rage bar is on screen for a fighter that has a super', !bar.hidden, bar.label);

/*
 * And against something wide. The Cart spans several lanes at once, so several
 * cows reach it on the same frame — which is the case the herd's disregard for
 * invulnerability frames exists for, and the only case where it changes
 * anything. Letting the first cow's i-frames swallow the rest costs two thirds
 * of the move's damage against the one enemy it is most needed against.
 */
const trampled = await api(() => {
  const g = globalThis.__niulaiFight.game;
  const boss = globalThis.__toBoss();
  const f = boss.fighter;
  f.position.set(g.player.position.x + 2.2, 0, 0);
  boss.enter('stalk');
  boss.timer = 99;
  f.health = f.maxHealth;
  f.invulnerable = 0;
  g.power.meter = g.power.max;
  g.player.attackTimer = 0; g.player.stunTimer = 0; g.player.downTimer = 0;
  g.player.dead = false; g.player.blocking = false;
  const before = f.health;
  globalThis.__niulaiFight.press('power');
  // One step first: the press is only consumed on the next update, so a loop
  // that checks "is it casting yet" before that runs zero times and reports a
  // super that did nothing.
  globalThis.__niulaiFight.step(0.1);
  for (let i = 0; i < 60 && (g.power.casting > 0 || g.power.herd.length); i++) {
    globalThis.__niulaiFight.step(0.2);
  }
  const damage = before - f.health;
  return { damage, cows: damage / (g.power.spec.damage || 18) };
});
check('several of them hit the boss at once, because it is wide enough for that',
  trampled.cows >= 4, `${trampled.cows.toFixed(0)} cows landed, ${trampled.damage} damage`);

await api(() => {
  const g = globalThis.__niulaiFight.game;
  g.over = false; g.won = false;
  g.gateIndex = 0;
  for (const gate of g.gates) gate.opened = false;
  for (const e of g.enemies) g.scene.remove(e.root);
  g.enemies = []; g.boss = null; g.spawnQueue = 0;
  g.power.clear();
  g.power.meter = 0;
  g.player.position.set(0, 0, 0.2);
  g.player.health = g.player.maxHealth;
  g.player.dead = false; g.player.downTimer = 0; g.player.stunTimer = 0;
});

/*
 * Baola is the other hero. Loading her is the check that a second playable
 * character is a registry entry rather than a code change — and that the clip
 * trims written for Niulai actually fit her, since they came from the same
 * generator with the same names.
 */
const second = await page.evaluate(async () => {
  const { Game } = globalThis.__niulaiFight.game.constructor === Function
    ? {} : { Game: globalThis.__niulaiFight.game.constructor };
  const canvas = document.createElement('canvas');
  canvas.width = 320; canvas.height = 180;
  /*
   * The sound bank is shared and deliberately last-writer-wins: rounds are
   * sequential, so registering the new fighter's voice over the old one is the
   * whole point. This block is the one place that builds a second Game *beside*
   * the first rather than after it, so it borrows the voice and has to give it
   * back — otherwise every later check runs with her grunt in his mouth.
   */
  const borrowed = ['voice:attack', 'voice:down']
    .map((key) => [key, globalThis.__niulaiFight.sounds.bank.get(key)]);

  const baola = new Game(canvas, { playerId: 'baola' });
  await baola.load();
  // Read at the moment she registers it, not at the end — by then it has been
  // handed back.
  const herVoice = ['voice:attack', 'voice:down'].map((key) => {
    const entry = baola.sounds.bank.get(key);
    return entry ? entry.voices[0].src.split('/').pop() : null;
  });
  const missing = baola.player.actor.missingClips;
  const snap = baola.snapshot();

  /*
   * A brand-new character, asked for nothing yet, has to be animating.
   *
   * This is the one place that can ask. `state` starts as 'idle' and `play()`
   * returns early for the state it is already in, so the game's first
   * play('idle') was a no-op and no action ever started: a character that had
   * not yet done something else stood in its bind pose. Nothing caught it
   * because the player walks within a second of starting and the wolves walk on
   * arrival — everything asked for a *different* state before anyone looked.
   * What does not is a character standing still at the end of a won run.
   */
  const Vec = Object.getPrototypeOf(baola.camera.position).constructor;
  const bones = [];
  baola.player.actor.root.traverse((node) => { if (node.isBone) bones.push(node); });
  const sample = () => bones.map((bone) => bone.getWorldPosition(new Vec()).y);
  const moved = (a, b) => a.filter((v, i) => Math.abs(v - b[i]) > 1e-4).length;

  const atRest = sample();
  for (let i = 0; i < 24; i++) baola.update(1 / 60);
  const breathing = moved(atRest, sample());


  /* ---------------------------------------------- her super: seven seconds --
   *
   * Niulai's clears the screen. Hers does not touch the screen at all: she
   * becomes something else for seven seconds, hits twice as hard and takes half
   * as much, and — the part that makes it a different move rather than the same
   * one with different numbers — she is never held in place for it. The seven
   * seconds are hers to fight in.
   */
  const readyUp = () => {
    baola.player.health = baola.player.maxHealth;
    baola.player.dead = false;
    baola.player.downTimer = 0; baola.player.stunTimer = 0; baola.player.attackTimer = 0;
    baola.player.invulnerable = 0; baola.player.blocking = false;
    baola.buffered = null;
    baola.player.facing = 1;
  };
  /* One punch through the real input path, and what it took off. The wolf is
   * given more health than the fight can spend so a doubled hit still leaves a
   * number to read. */
  const punchOnce = () => {
    const wolf = baola.enemies[0];
    wolf.health = 999; wolf.maxHealth = 999;
    wolf.stunTimer = 0; wolf.downTimer = 0; wolf.invulnerable = 0; wolf.dead = false;
    wolf.root.position.set(baola.player.position.x + 0.6, 0, baola.player.position.z);
    readyUp();
    baola.input.press('punch');
    for (let i = 0; i < 40; i++) baola.update(1 / 60);
    return 999 - wolf.health;
  };
  /* And what one costs her. */
  const takeOne = () => {
    baola.player.health = baola.player.maxHealth;
    baola.player.dead = false; baola.player.downTimer = 0; baola.player.stunTimer = 0;
    baola.player.invulnerable = 0; baola.player.blocking = false;
    baola.player.takeHit(20, -1);
    return baola.player.maxHealth - baola.player.health;
  };

  const sparring = baola.spawnFighter('wolfwolf',
    { x: baola.player.position.x + 0.6, z: baola.player.position.z },
    { health: 999, speed: 2.5, damage: 8, team: 'enemy', facing: -1 });
  sparring.thinkTimer = 999;     // it is here to be hit, not to fight back
  baola.enemies.push(sparring);

  const ordinaryPunch = punchOnce();
  const ordinaryHurt = takeOne();
  const ordinaryForm = baola.player.actor.root.name;
  const ordinaryRoot = baola.player.root;

  /*
   * The noise the change makes. Spied on the element rather than listened to:
   * whether a sound reaches the speakers is the browser's business, and a muted
   * test machine would answer no to all of it. What is checkable is that the
   * file decodes and that the cast is what reaches for it.
   */
  const shout = baola.power.shout;
  let shouts = 0;
  const shoutInfo = { file: null, seconds: 0, error: 'no shout' };
  if (shout) {
    await new Promise((resolve) => {
      if (shout.readyState >= 1) return resolve();
      shout.addEventListener('loadedmetadata', resolve, { once: true });
      shout.addEventListener('error', resolve, { once: true });
      setTimeout(resolve, 5000);
    });
    shoutInfo.file = shout.src.split('/').slice(-2).join('/');
    shoutInfo.seconds = shout.duration;
    shoutInfo.error = shout.error ? shout.error.code : null;
    shoutInfo.volume = shout.volume;
    shout.play = () => { shouts++; return Promise.resolve(); };
  }

  readyUp();
  baola.power.meter = baola.power.max;
  baola.input.press('power');
  baola.update(1 / 60);
  const shouted = shouts;

  // And a press with nothing in the meter must be silent, not just ineffective.
  shouts = 0;
  const bankedMeter = baola.power.meter;
  baola.power.meter = 0;
  baola.input.press('power');
  baola.update(1 / 60);
  const shoutedOnEmpty = shouts;
  baola.power.meter = bankedMeter;

  const changed = {
    form: baola.player.actor.root.name,
    named: baola.snapshot().playerName,
    /*
     * Every state the game will ask the swapped-in body for, answerable. The
     * form is re-textured from time to time — new maps onto the same rig — and
     * a re-texture that came back without the clips would leave her frozen in
     * her bind pose for seven seconds while every other check here still
     * passed, because the damage numbers are the Fighter's and have nothing to
     * do with whether anything is moving.
     */
    plays: ['idle', 'walk', 'punch', 'kick', 'hit', 'down', 'block']
      .filter((state) => !baola.player.actor.has(state)),
    remaining: baola.power.remaining,
    locked: baola.power.casting,
    inScene: baola.scene.children.includes(baola.player.root),
    oldGone: !baola.scene.children.includes(ordinaryRoot)
  };

  /*
   * The growth. Appearing at full size on the swap frame reads as a glitch
   * rather than a transformation — one frame a leopard cub, the next a jaguar
   * warrior a third again as tall, with nothing on screen connecting the two.
   * So it starts at the size the old body was standing at, rises, overshoots a
   * little and settles.
   */
  const scales = [baola.player.root.scale.x];
  for (let i = 0; i < 36; i++) {
    baola.update(1 / 60);
    scales.push(baola.player.root.scale.x);
  }
  const growth = {
    first: scales[0],
    peak: Math.max(...scales),
    settled: scales[scales.length - 1],
    rose: scales.slice(0, 10).every((v, i, a) => i === 0 || v > a[i - 1])
  };

  // Not held in place, unlike the summon.
  const wasX = baola.player.position.x;
  baola.input.press('right');
  for (let i = 0; i < 20; i++) baola.update(1 / 60);
  baola.input.release('right');
  const walkedWhileSuper = baola.player.position.x - wasX;

  const superPunch = punchOnce();
  const superHurt = takeOne();

  // Run the clock down to the last of it, and watch her come back down with it.
  for (let i = 0; i < 10 * 60 && baola.power.remaining > 0.28; i++) baola.update(1 / 60);
  const shrinking = [];
  for (let i = 0; i < 60 && baola.power.remaining > 0; i++) {
    baola.update(1 / 60);
    if (baola.power.remaining > 0) shrinking.push(baola.player.root.scale.x);
  }
  const cameDown = {
    samples: shrinking.length,
    from: shrinking[0],
    to: shrinking[shrinking.length - 1]
  };

  // Run the clock out and check she is entirely herself again.
  for (let i = 0; i < 2 * 60; i++) baola.update(1 / 60);
  const reverted = {
    form: baola.player.actor.root.name,
    scale: baola.player.root.scale.x,
    remaining: baola.power.remaining,
    inScene: baola.scene.children.includes(baola.player.root),
    formGone: !baola.scene.children.includes(changed.rootWas)
  };
  const afterPunch = punchOnce();
  const afterHurt = takeOne();

  /*
   * A round that ends mid-transformation must not leave the form swapped in.
   * The body in the scene is the one dispose() tears down, and the one the next
   * round would find still standing there.
   */
  readyUp();
  baola.power.meter = baola.power.max;
  baola.input.press('power');
  baola.update(1 / 60);
  const midway = baola.player.actor.root.name;
  baola.power.clear();
  const cleared = {
    from: midway,
    form: baola.player.actor.root.name,
    damage: baola.player.damage,
    vulnerability: baola.player.vulnerability,
    inScene: baola.scene.children.includes(baola.player.root),
    remaining: baola.power.remaining
  };

  for (const enemy of baola.enemies) baola.scene.remove(enemy.root);
  baola.enemies = [];

  // And her ending: she has no celebration clip, so she must fall back to the
  // idle rather than freeze in whatever the last thing she did left her in.
  for (const gate of baola.gates) gate.opened = true;
  baola.gateIndex = baola.gates.length - 1;
  baola.player.position.set(baola.gates[baola.gateIndex].x - 3, 0, 0.2);
  for (let i = 0; i < 12; i++) baola.update(1 / 60);
  const endState = baola.player.actor.state;
  const stood = sample();
  for (let i = 0; i < 30; i++) baola.update(1 / 60);
  const stillMoving = moved(stood, sample());

  for (const [key, entry] of borrowed) {
    if (entry) globalThis.__niulaiFight.sounds.bank.set(key, entry);
  }

  return {
    name: snap.playerName,
    chinese: snap.playerNameChinese,
    health: snap.maxHealth,
    speed: baola.player.speed,
    kind: baola.power && baola.power.kind,
    voices: herVoice,
    rage: snap.rage,
    missing,
    ordinaryPunch, superPunch, afterPunch,
    ordinaryHurt, superHurt, afterHurt,
    ordinaryForm, changed, walkedWhileSuper, reverted, cleared, growth, cameDown,
    shoutInfo, shouted, shoutedOnEmpty,
    bones: bones.length,
    breathing,
    hasWin: baola.player.actor.has('win'),
    won: baola.won,
    endState,
    stillMoving
  };
});
check('Baola loads as a second hero', second.name === 'Baola', `${second.name} ${second.chinese}`);
check('Baola has a clip for every state', second.missing.length === 0,
  second.missing.join(', ') || 'all present');
check('the two heroes are not identical', second.speed !== 4.1 || second.health !== 100,
  `Baola: ${second.health} hp, speed ${second.speed}`);
/*
 * And her super, which is a different move rather than Niulai's with different
 * numbers. The registry is what decides which one a character gets, so the
 * first of these is really a check that it does.
 */
check('choosing her swaps the voice, rather than leaving his in place',
  second.voices.every((file) => file && file.startsWith('baola-')), second.voices.join(', '));
check('Baola has a meter too, and it buys a different move',
  second.kind === 'transform' && second.rage !== null, `kind: ${second.kind}`);
check('her change has a sound, and it is one the browser can decode',
  second.shoutInfo.error === null && second.shoutInfo.seconds > 0,
  `${second.shoutInfo.file} — ${second.shoutInfo.seconds
    ? second.shoutInfo.seconds.toFixed(2) + 's at ' + second.shoutInfo.volume : 'no audio'}`);
check('it goes off when she changes, and not on a press that cannot pay for it',
  second.shouted === 1 && second.shoutedOnEmpty === 0,
  `${second.shouted} on the cast, ${second.shoutedOnEmpty} on an empty meter`);
check('casting it turns her into something else',
  second.changed.form === 'superbaola' && second.changed.named === 'Super Baola',
  `${second.ordinaryForm} -> ${second.changed.form}`);
check('the new body takes over the old one\'s place in the scene, not a place beside it',
  second.changed.inScene && second.changed.oldGone);
check('she grows into it rather than appearing at full size',
  second.growth.first < 0.85 && second.growth.rose,
  `starts at ${second.growth.first.toFixed(3)} of full size and rises`);
check('the growth overshoots a little and settles exactly',
  second.growth.peak > 1.01 && second.growth.settled === 1,
  `peaks at ${second.growth.peak.toFixed(3)}, settles at ${second.growth.settled}`);
check('and she comes back down at the end rather than popping out',
  second.cameDown.samples > 3 && second.cameDown.to < second.cameDown.from &&
  second.cameDown.to < 0.85,
  `${second.cameDown.from.toFixed(3)} -> ${second.cameDown.to.toFixed(3)} over ` +
  `${second.cameDown.samples} frames`);
check('and the body she comes back to is her own size',
  second.reverted.scale === 1, `scale ${second.reverted.scale}`);
check('the form can play everything the game will ask it for',
  second.changed.plays.length === 0, second.changed.plays.join(', ') || 'all present');
check('it runs for seven seconds', Math.abs(second.changed.remaining - 7) < 0.1,
  `${second.changed.remaining.toFixed(2)}s`);
check('and it never holds her still — the seven seconds are hers to fight in',
  second.changed.locked === 0 && second.walkedWhileSuper > 0.5,
  `walked ${second.walkedWhileSuper.toFixed(2)} while super`);
check('she hits twice as hard while it lasts',
  Math.abs(second.superPunch - second.ordinaryPunch * 2) < 0.01,
  `${second.superPunch} against ${second.ordinaryPunch}`);
check('and takes half as much',
  Math.abs(second.superHurt - second.ordinaryHurt / 2) < 0.01,
  `${second.superHurt} against ${second.ordinaryHurt}`);
check('a round ending mid-transformation puts her back',
  second.cleared.from === 'superbaola' && second.cleared.form === second.ordinaryForm &&
  second.cleared.inScene && second.cleared.remaining === 0 &&
  second.cleared.vulnerability === 1,
  `${second.cleared.from} -> ${second.cleared.form}`);
check('seven seconds later she is entirely herself again',
  second.reverted.form === second.ordinaryForm && second.reverted.inScene &&
  second.afterPunch === second.ordinaryPunch && second.afterHurt === second.ordinaryHurt,
  `${second.reverted.form}, ${second.afterPunch} damage, ${second.afterHurt} taken`);
check('a character animates before it is asked to do anything',
  second.breathing > 0, `${second.breathing} of ${second.bones} bones moving on an untouched idle`);
check('a fighter with no celebration falls back to its idle rather than freezing',
  second.won && !second.hasWin && second.endState === 'idle' && second.stillMoving > 0,
  `${second.endState}, ${second.stillMoving} bones moving`);


/* ------------------------------------------------------------------ sound --
 *
 * Impacts, and who gets to make them. The player's punches and kicks are the
 * only ones that thud: the wolves throwing the same sound back would turn a
 * crowd into noise, and the point of these is that a player can hear their own
 * hits land without watching the health bars.
 */
const sfx = await api(async () => {
  const g = globalThis.__niulaiFight.game;
  await g.sounds.load();
  const decoded = {};
  for (const name of g.sounds.names) {
    const audio = g.sounds.bank.get(name).voices[0];
    await new Promise((resolve) => {
      if (audio.readyState >= 1) return resolve();
      audio.addEventListener('loadedmetadata', resolve, { once: true });
      audio.addEventListener('error', resolve, { once: true });
      setTimeout(resolve, 5000);
    });
    decoded[name] = { seconds: audio.duration, error: audio.error ? audio.error.code : null };
  }
  return { names: g.sounds.names, decoded };
});
const undecodable = Object.entries(sfx.decoded)
  .filter(([, v]) => v.error !== null || !(v.seconds > 0))
  .map(([k]) => k);
check('every sound in the bank is one the browser can decode',
  sfx.names.length >= 5 && undecodable.length === 0,
  undecodable.length ? `cannot decode: ${undecodable.join(', ')}` : sfx.names.join(', '));

/*
 * Which event makes which noise. Recorded by standing in for `play` rather than
 * by listening, because what is being checked is the wiring — whether a sound
 * comes out of the speakers is the browser's business and a muted test machine
 * would answer no to all of it.
 */
const heard = await api(() => {
  const g = globalThis.__niulaiFight.game;
  const api2 = globalThis.__niulaiFight;
  const log = [];
  const real = g.sounds.play.bind(g.sounds);
  g.sounds.play = (name) => { log.push(name); return true; };

  globalThis.__wolves(1);
  const wolf = g.enemies[0];
  const reset = () => {
    const p = g.player;
    p.health = p.maxHealth; p.dead = false; p.downTimer = 0; p.stunTimer = 0;
    p.attackTimer = 0; p.invulnerable = 0; p.blocking = false; p.facing = 1;
    g.buffered = null;
    wolf.health = 999; wolf.maxHealth = 999; wolf.dead = false;
    wolf.downTimer = 0; wolf.stunTimer = 0; wolf.invulnerable = 0; wolf.thinkTimer = 999;
    wolf.root.position.set(p.position.x + 0.6, 0, p.position.z);
    log.length = 0;
  };
  const take = () => { const copy = log.slice(); log.length = 0; return copy; };

  reset();
  api2.press('punch');
  api2.step(g.player.timings.punch + 0.2);
  const punching = take();

  reset();
  api2.press('kick');
  api2.step(g.player.timings.kick + 0.2);
  const kicking = take();

  // A wolf landing one on the player must make neither.
  reset();
  wolf.facing = -1;
  for (let i = 0; i < 30 && g.player.health === g.player.maxHealth; i++) {
    wolf.thinkTimer = 0;
    g.player.invulnerable = 0;
    api2.step(0.25);
  }
  const hurtBefore = g.player.health < g.player.maxHealth;
  const beingHit = take();

  // And a body going down, whoever it belongs to.
  reset();
  wolf.health = 5;
  api2.press('punch');
  api2.step(g.player.timings.punch + 0.4);
  const knockdown = take();

  g.sounds.play = real;
  for (const enemy of g.enemies) g.scene.remove(enemy.root);
  g.enemies = [];
  return { punching, kicking, beingHit, hurtBefore, knockdown };
});
check('the player\'s punch landing makes a punch',
  heard.punching.includes('punch') && !heard.punching.includes('kick'),
  heard.punching.join(', ') || 'silence');
check('and their kick makes a kick',
  heard.kicking.includes('kick') && !heard.kicking.includes('punch'),
  heard.kicking.join(', ') || 'silence');
check('a wolf hitting the player makes neither',
  heard.hurtBefore && heard.beingHit.length === 0,
  heard.beingHit.join(', ') || 'silence, and the player was hit');
check('a body going down thuds', heard.knockdown.includes('fall'),
  heard.knockdown.join(', ') || 'silence');

/*
 * The fighter's own voice: an effort on the swing, and a cry on going down.
 *
 * The effort is on the swing rather than on contact, unlike the impacts — it is
 * the effort, and it happens whether or not anything is there to hit. The cry
 * goes with the fall rather than with the life being deducted, which is a
 * second and a quarter later as they are already getting back up.
 */
const spoke = await api(async () => {
  const g = globalThis.__niulaiFight.game;
  const api2 = globalThis.__niulaiFight;

  const loaded = {};
  for (const key of ['voice:attack', 'voice:down']) {
    const entry = g.sounds.bank.get(key);
    const audio = entry && entry.voices[0];
    if (!audio) { loaded[key] = null; continue; }
    await new Promise((resolve) => {
      if (audio.readyState >= 1) return resolve();
      audio.addEventListener('loadedmetadata', resolve, { once: true });
      audio.addEventListener('error', resolve, { once: true });
      setTimeout(resolve, 5000);
    });
    loaded[key] = {
      file: audio.src.split('/').pop(),
      seconds: audio.duration,
      error: audio.error ? audio.error.code : null
    };
  }

  const log = [];
  const real = g.sounds.play.bind(g.sounds);
  g.sounds.play = (name) => { log.push(name); return true; };
  const take = () => { const copy = log.slice(); log.length = 0; return copy; };
  const p = g.player;
  const ready = () => {
    p.health = p.maxHealth; p.dead = false; p.downTimer = 0; p.stunTimer = 0;
    p.attackTimer = 0; p.invulnerable = 0; p.blocking = false; p.facing = 1;
    g.buffered = null;
    log.length = 0;
  };

  ready(); api2.press('punch'); api2.step(0.1);
  const swinging = take();
  ready(); api2.press('kick'); api2.step(0.1);
  const kicking = take();
  // A press that cannot become a swing must stay quiet.
  ready(); p.attackTimer = 0.4; api2.press('punch'); api2.step(0.05);
  const whileBusy = take();

  ready(); p.takeHit(999, -1);
  const goingDown = take();

  // And a wolf going down must not borrow the hero's voice.
  globalThis.__wolves(1);
  const wolf = g.enemies[0];
  take();
  wolf.invulnerable = 0;
  wolf.takeHit(999, -1);
  const wolfDown = take();

  g.sounds.play = real;
  for (const enemy of g.enemies) g.scene.remove(enemy.root);
  g.enemies = [];
  ready();
  return { loaded, swinging, kicking, whileBusy, goingDown, wolfDown };
});
const missing = Object.entries(spoke.loaded)
  .filter(([, v]) => !v || v.error !== null || !(v.seconds > 0)).map(([k]) => k);
check('the fighter has a voice, and it is one the browser can decode',
  missing.length === 0,
  missing.length ? `cannot decode: ${missing.join(', ')}`
    : Object.values(spoke.loaded).map((v) => `${v.file} ${v.seconds.toFixed(2)}s`).join(', '));
check('they make an effort when they swing, punch or kick',
  spoke.swinging.includes('voice:attack') && spoke.kicking.includes('voice:attack'),
  `${spoke.swinging.join(', ') || 'silence'} / ${spoke.kicking.join(', ') || 'silence'}`);
check('and not on a press that never becomes a swing',
  spoke.whileBusy.length === 0, spoke.whileBusy.join(', ') || 'silence');
check('they cry out as they go down, with the thud',
  spoke.goingDown.includes('voice:down') && spoke.goingDown.includes('fall'),
  spoke.goingDown.join(', ') || 'silence');
check('a wolf going down does not borrow it',
  spoke.wolfDown.includes('fall') && !spoke.wolfDown.includes('voice:down'),
  spoke.wolfDown.join(', ') || 'silence');

/*
 * And the three that are about the shape of a run rather than a hit: the Cart
 * spooling up, and the two endings.
 *
 * The engine starts with the wind-up, not with the charge. The pause is the
 * only warning the move gives, and a warning you can hear reaches a player who
 * is busy with a wolf — which is exactly the player who is about to be run
 * over. Its file is trimmed to peak where the charge lands rather than four
 * seconds later, which is what the whole 4.8-second source would have done.
 */
const bigMoments = await api(() => {
  const g = globalThis.__niulaiFight.game;
  const log = [];
  const real = g.sounds.play.bind(g.sounds);
  g.sounds.play = (name) => { log.push(name); return true; };
  const take = () => { const copy = log.slice(); log.length = 0; return copy; };

  const boss = globalThis.__toBoss();
  take();
  boss.enter('wind');
  const winding = take();
  boss.enter('charge');
  const charging = take();
  boss.enter('recover');
  const recovering = take();

  // The last life.
  g.lives = 1;
  g.over = false;
  g.player.health = 0; g.player.dead = true; g.player.downTimer = 0;
  g.loseLife();
  const losing = take();

  // And winning.
  g.over = false; g.won = false;
  g.player.dead = false; g.player.health = g.player.maxHealth; g.player.downTimer = 0;
  g.celebrate();
  const winning = take();

  g.sounds.play = real;

  // Put it back the way the checks after this one expect to find it.
  g.over = false; g.won = false; g.lives = 3;
  g.gateIndex = 0;
  for (const gate of g.gates) gate.opened = false;
  for (const enemy of g.enemies) g.scene.remove(enemy.root);
  g.enemies = []; g.boss = null; g.spawnQueue = 0;
  g.power.clear();
  g.power.meter = 0;
  g.player.position.set(0, 0, 0.2);
  g.player.pose = null;
  g.player.actor.play('idle');
  return { winding, charging, recovering, losing, winning };
});
check('the Cart\'s engine starts with the wind-up, which is the warning',
  bigMoments.winding.join() === 'charge', bigMoments.winding.join(', ') || 'silence');
check('and not again when it actually charges or stalls',
  bigMoments.charging.length === 0 && bigMoments.recovering.length === 0,
  [...bigMoments.charging, ...bigMoments.recovering].join(', ') || 'silence');
check('running out of lives sounds like losing',
  bigMoments.losing.join() === 'loss', bigMoments.losing.join(', ') || 'silence');
check('and clearing the last stage sounds like winning',
  bigMoments.winning.join() === 'win', bigMoments.winning.join(', ') || 'silence');

/*
 * The music, and its switch.
 *
 * The track is one element that keeps its place rather than a pool of voices —
 * giving it voices would mean the music restarting on top of itself — and the
 * preference outlives the page, because a player who turns it off does not want
 * to be asked again.
 */
const theme = await api(() => {
  const sounds = globalThis.__niulaiFight.sounds;
  const entry = sounds.bank.get('theme');
  const audio = entry && entry.voices[0];
  return entry ? {
    loop: entry.loop && audio.loop,
    voices: entry.voices.length,
    seconds: audio.duration,
    error: audio.error ? audio.error.code : null,
    volume: audio.volume
  } : null;
});
check('the theme is a single looping track the browser can decode',
  theme && theme.loop && theme.voices === 1 && theme.error === null && theme.seconds > 0,
  theme ? `${theme.seconds.toFixed(1)}s at ${theme.volume}` : 'no theme in the bank');

// A real keypress first: the switch turning the music *on* has to be able to
// start it, and a browser will not start anything until the page has been
// touched.
await page.keyboard.press('KeyQ');
const stored = () => page.evaluate(() => {
  try { return localStorage.getItem('niulai-fight.music'); } catch { return 'unavailable'; }
});
const label = () => page.evaluate(() => {
  const button = document.getElementById('music');
  return { text: button.textContent, pressed: button.getAttribute('aria-pressed') };
});

const off = await api(() => {
  const sounds = globalThis.__niulaiFight.sounds;
  document.getElementById('music').click();
  return { on: sounds.musicOn, playing: sounds.musicPlaying };
});
const offStored = await stored();
const offLabel = await label();
check('the switch turns the music off', off.on === false && off.playing === false,
  `on=${off.on} playing=${off.playing}`);
check('and says so', offLabel.text.includes('OFF') && offLabel.pressed === 'false', offLabel.text);
check('and remembers it', offStored === 'off', String(offStored));

const on = await api(() => {
  const sounds = globalThis.__niulaiFight.sounds;
  document.getElementById('music').click();
  return { on: sounds.musicOn, playing: sounds.musicPlaying };
});
const onStored = await stored();
const onLabel = await label();
check('and turns it back on', on.on === true && on.playing === true,
  `on=${on.on} playing=${on.playing}`);
check('and says that too', onLabel.text.includes('ON') && onLabel.pressed === 'true', onLabel.text);
check('and remembers that', onStored === 'on', String(onStored));

/* ------------------------------------------------------------ the ending --
 *
 * Winning used to stop the frame. That is right for a loss — the player is on
 * the floor and the run is finished — but it left a won run as a hero standing
 * perfectly still under a banner congratulating him.
 */
const ending = await api(() => {
  const g = globalThis.__niulaiFight.game;
  const Vec = Object.getPrototypeOf(g.camera.position).constructor;
  const bones = [];
  g.player.actor.root.traverse((node) => { if (node.isBone) bones.push(node); });
  const sample = () => bones.map((bone) => bone.getWorldPosition(new Vec()).y);
  const moved = (a, b) => a.filter((v, i) => Math.abs(v - b[i]) > 1e-4).length;

  // Clear the last gate for real rather than setting `over` by hand, so this
  // measures the path the game actually takes to its ending.
  for (const gate of g.gates) gate.opened = true;
  g.gateIndex = g.gates.length - 1;
  g.player.position.set(g.gates[g.gateIndex].x - 3, 0, 0.2);
  for (const enemy of g.enemies) g.scene.remove(enemy.root);
  g.enemies = []; g.boss = null; g.spawnQueue = 0;
  g.power.clear();
  g.player.health = g.player.maxHealth;
  g.player.dead = false; g.player.downTimer = 0; g.player.stunTimer = 0;
  g.player.attackTimer = 0;
  globalThis.__niulaiFight.step(0.2);

  const snap = g.snapshot();
  const farAway = g.camera.position.z;
  const before = sample();
  globalThis.__niulaiFight.step(0.5);
  const movingAfterTheWin = moved(before, sample());
  globalThis.__niulaiFight.step(2.5);
  return {
    won: snap.won, cheering: snap.cheering,
    state: g.player.actor.state,
    has: g.player.actor.has('win'),
    farAway, closeUp: g.camera.position.z,
    movingAfterTheWin, bones: bones.length
  };
});
check('winning the last stage plays the celebration',
  ending.won && ending.has && ending.state === 'win', `${ending.state}`);
check('and the frame keeps running so it can be seen',
  ending.movingAfterTheWin > 0, `${ending.movingAfterTheWin} of ${ending.bones} bones moving`);
check('the camera comes in to watch it', ending.closeUp < ending.farAway - 1,
  `${ending.farAway.toFixed(1)} -> ${ending.closeUp.toFixed(1)}`);
check('the banner moves off the hero when the news is good',
  await page.evaluate(() => document.getElementById('banner').classList.contains('won')));
await page.screenshot({ path: join(shots, '5-win.png'), animations: 'disabled' });

/* ------------------------------------------------------ the game controls --
 *
 * Music, pause and restart, without leaving the fight.
 */
const controlsExist = await page.evaluate(() => ['t-music', 't-pause', 't-restart']
  .filter((id) => !document.getElementById(id)));
check('the fight has its three controls', controlsExist.length === 0,
  controlsExist.length ? `missing: ${controlsExist.join(', ')}` : 'music, pause, restart');

/*
 * Pause has to stop the clock, not the frame. The scene stays on screen behind
 * the overlay, so what proves it is the simulation standing still while real
 * time passes — read from the world rather than from a flag.
 */
await api(() => {
  const g = globalThis.__niulaiFight.game;
  g.player.position.set(2, 0, 0.2);
  g.player.health = g.player.maxHealth;
  g.player.dead = false; g.player.downTimer = 0; g.player.stunTimer = 0;
  g.over = false; g.won = false;
  // The suite normally drives the clock itself. Pause lives in the frame loop,
  // so for this one stretch the game runs on its own like a player's does.
  globalThis.__niulaiFight.run();
  globalThis.__niulaiFight.press('right');
});
/* Software GL runs a handful of frames a second, so the test waits for frames
 * rather than for wall-clock milliseconds — a fixed timeout would measure the
 * renderer, not the pause. */
const frames = (count) => page.evaluate((n) => new Promise((resolve) => {
  let left = n;
  const tick = () => (--left <= 0 ? resolve() : requestAnimationFrame(tick));
  requestAnimationFrame(tick);
}), count);

await page.waitForFunction(() => globalThis.__niulaiFight.game.player.position.x > 2.5,
  null, { timeout: 30000 });
const walking = await api(() => globalThis.__niulaiFight.game.player.position.x);
await page.click('#t-pause');
const pausedAt = await api(() => globalThis.__niulaiFight.game.player.position.x);
await frames(10);
const whilePaused = await api(() => ({
  x: globalThis.__niulaiFight.game.player.position.x,
  overlay: !document.getElementById('paused').hidden
}));
await page.click('#t-pause');
await frames(10);
const resumed = await api(() => ({
  x: globalThis.__niulaiFight.game.player.position.x,
  overlay: !document.getElementById('paused').hidden
}));
await api(() => {
  globalThis.__niulaiFight.release('right');
  globalThis.__niulaiFight.stop();
});
check('it was actually moving before the pause', walking > 2.5,
  `walked to ${walking.toFixed(2)}`);
check('pausing stops the world', Math.abs(whilePaused.x - pausedAt) < 0.001 && whilePaused.overlay,
  `${(whilePaused.x - pausedAt).toFixed(4)} of movement over 10 frames, overlay ${whilePaused.overlay ? 'up' : 'missing'}`);
check('and letting go starts it again', resumed.x > whilePaused.x + 0.2 && !resumed.overlay,
  `moved ${(resumed.x - whilePaused.x).toFixed(2)} once resumed`);

await page.keyboard.press('KeyP');
const byKey = await page.evaluate(() => !document.getElementById('paused').hidden);
await page.keyboard.press('KeyP');
const byKeyAgain = await page.evaluate(() => !document.getElementById('paused').hidden);
check('P does it from the keyboard', byKey && !byKeyAgain,
  `pressed: ${byKey}, pressed again: ${byKeyAgain}`);

/* One setting, two switches: the roster's and the fight's. */
await page.click('#t-music');
const muted = await page.evaluate(() => ({
  on: globalThis.__niulaiFight.sounds.musicOn,
  roster: document.getElementById('music').textContent,
  glyph: document.getElementById('t-music').textContent
}));
await page.click('#t-music');
const unmuted = await page.evaluate(() => ({
  on: globalThis.__niulaiFight.sounds.musicOn,
  roster: document.getElementById('music').textContent
}));
check('the fight can mute the music, and the roster agrees',
  muted.on === false && muted.roster.includes('OFF') && unmuted.on === true &&
  unmuted.roster.includes('ON'),
  `${muted.glyph} / ${muted.roster}`);

/*
 * And the awkward one. These buttons sit inside a window-level "tap anywhere to
 * play again" listener, so a click on the music or pause button while the run
 * is over would otherwise throw the run away as a side effect of turning the
 * sound down.
 */
await api(() => {
  const g = globalThis.__niulaiFight.game;
  g.score = 4321;
  g.over = true;
  g.won = false;
  g.onState(g.snapshot());
});
await page.click('#t-music');
await page.click('#t-music');
await page.click('#t-pause');
await page.click('#t-pause');
await page.waitForTimeout(200);
const survived = await api(() => {
  const g = globalThis.__niulaiFight.game;
  return { score: g.score, over: g.over };
});
check('the music and pause buttons do not end the run under them',
  survived.score === 4321, `score ${survived.score} after four clicks on a finished run`);

/* The restart button, on the other hand, is meant to. */
await page.click('#t-restart');
await page.waitForFunction(() => globalThis.__niulaiFight.game &&
  globalThis.__niulaiFight.game.score === 0, null, { timeout: 60000 });
const restarted = await api(() => {
  const g = globalThis.__niulaiFight.game;
  globalThis.__niulaiFight.stop();   // back to driving the clock ourselves
  return {
    score: g.score, over: g.over, player: g.snapshot().player,
    anyGateOpened: g.gates.some((gate) => gate.opened),
    paused: !document.getElementById('paused').hidden
  };
});
check('the restart button starts a fresh round with the same fighter',
  restarted.score === 0 && restarted.over === false && restarted.player === 'niulai' &&
  !restarted.anyGateOpened && !restarted.paused,
  `${restarted.player}, score ${restarted.score}`);

/*
 * Restarting. The interesting part is not that a new game appears — it is that
 * it is a *new* one. The level was a module-level array whose `opened` flags
 * were written to as waves triggered, so a second run would have started with
 * every gate already open and every fight skipped.
 */
const beforeRestart = await api(() => {
  const g = globalThis.__niulaiFight.game;
  g.score = 4321;
  g.gateIndex = 2;
  g.gates[0].opened = true;
  g.over = true;
  g.won = false;
  g.onState(g.snapshot());
  return { score: g.score, stage: g.snapshot().stage, firstGateOpened: g.gates[0].opened };
});
check('the banner offers a restart when the game is over',
  await page.evaluate(() => {
    const banner = document.getElementById('banner');
    return !banner.hidden && /play again/i.test(banner.textContent);
  }), 'banner shown');

await page.keyboard.press('r');
await page.waitForFunction(() => globalThis.__niulaiFight.game, null, { timeout: 60000 });

const afterRestart = await api(() => {
  const g = globalThis.__niulaiFight.game;
  return {
    score: g.score,
    stage: g.snapshot().stage,
    over: g.over,
    anyGateOpened: g.gates.some((gate) => gate.opened),
    player: g.snapshot().player,
    health: g.player.health
  };
});
check('R starts a fresh round', afterRestart.over === false && afterRestart.score === 0,
  `score ${beforeRestart.score} -> ${afterRestart.score}`);
check('the restarted level has all its gates shut again', !afterRestart.anyGateOpened,
  afterRestart.anyGateOpened ? 'a gate was still open' : 'all shut');
check('restarting keeps the fighter you chose', afterRestart.player === 'niulai',
  afterRestart.player);
check('the banner is gone once play resumes',
  await page.evaluate(() => document.getElementById('banner').hidden));

check('still no script errors after playing', errors.length === 0, errors[0] || '');

if (transients.length) {
  console.log(`\nNOTE  ${transients.length} request(s) failed and were retried successfully:`);
  for (const note of transients) console.log(`      ${note}`);
}

writeFileSync(join(shots, 'result.json'), JSON.stringify({ passed, failed }, null, 2));
console.log(`\n${passed} passed, ${failed} failed` +
  `${transients.length ? `, ${transients.length} retried request(s)` : ''}. Screenshots in .smoke/`);

await browser.close();
server.close();
process.exit(failed ? 1 : 0);
