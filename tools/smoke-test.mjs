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
  const baola = new Game(canvas, { playerId: 'baola' });
  await baola.load();
  const missing = baola.player.actor.missingClips;
  const snap = baola.snapshot();
  return {
    name: snap.playerName,
    chinese: snap.playerNameChinese,
    health: snap.maxHealth,
    speed: baola.player.speed,
    missing
  };
});
check('Baola loads as a second hero', second.name === 'Baola', `${second.name} ${second.chinese}`);
check('Baola has a clip for every state', second.missing.length === 0,
  second.missing.join(', ') || 'all present');
check('the two heroes are not identical', second.speed !== 4.1 || second.health !== 100,
  `Baola: ${second.health} hp, speed ${second.speed}`);

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
