import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from './serve.mjs';

/*
 * Every picture the Chrome Web Store asks for, into dist/store/.
 *
 *   node tools/make-store.mjs
 *
 *   icon-128.png         store icon,         128 x 128
 *   icons/icon*.png      the manifest icons, 16 / 32 / 48 / 128
 *   1-select.png ...     screenshots,        1280 x 800
 *   promo-440x280.png    small promo tile
 *   promo-1400x560.png   marquee promo tile
 *
 * The screenshots are the real game, played to the moment worth showing rather
 * than posed. The tiles are built from one of those frames, so the art cannot
 * promise something the game does not do.
 */

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist', 'store');
mkdirSync(out, { recursive: true });

const { server, url } = await serve(0);
const browser = await chromium.launch({
  args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
  executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined
});

/* ------------------------------------------------- screenshots, 1280 x 800 */

const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction(() => globalThis.__niulaiFight, null, { timeout: 60000 });

// The portraits need a moment to load and settle into a pose facing forward.
await page.waitForTimeout(7000);
await page.screenshot({ path: join(out, '1-select.png') });
console.log('1-select.png');

await page.evaluate(() => globalThis.__niulaiFight.choose('niulai'));
await page.waitForFunction(() => globalThis.__niulaiFight.game, null, { timeout: 60000 });
await page.evaluate(() => globalThis.__niulaiFight.stop());

// Walk into the first wave and stop mid-fight, close enough that the wolves
// are actually threatening rather than approaching.
await page.evaluate(() => {
  const api = globalThis.__niulaiFight;
  api.press('right');
  api.step(6);
  api.release('right');
  const g = api.game;
  const wolves = g.enemies;
  if (wolves[0]) wolves[0].root.position.set(g.player.position.x + 1.1, 0, g.player.position.z + 0.1);
  if (wolves[1]) wolves[1].root.position.set(g.player.position.x - 1.2, 0, g.player.position.z - 0.3);
  g.player.facing = 1;
  api.press('punch');
  api.step(0.22);          // caught mid-swing
});
await page.screenshot({ path: join(out, '2-fight.png') });
console.log('2-fight.png');

/*
 * The super, with the herd among the wolves. This is the loudest thing the game
 * does and the reason to pick Niulai, so it is worth a slot of its own — and it
 * has to be caught at the moment the cows are level with the wolves rather than
 * entering, which is a window of about a fifth of a second.
 */
await page.evaluate(() => {
  const api = globalThis.__niulaiFight;
  const g = api.game;
  api.release('block');
  g.player.attackTimer = 0;
  g.player.stunTimer = 0;
  g.player.blocking = false;
  g.player.health = g.player.maxHealth;

  // A crowd worth clearing, spread across the belt so the lanes have targets.
  g.spawnQueue = 4;
  g.spawnTimer = 0;
  api.step(2.5);
  g.enemies.forEach((wolf, i) => {
    wolf.root.position.set(g.player.position.x + 1.4 + (i % 3) * 0.85, 0, -1.1 + i * 0.55);
    wolf.stunTimer = 0; wolf.attackTimer = 0; wolf.thinkTimer = 99;
  });
  g.player.facing = 1;
  g.power.meter = g.power.max;
  api.press('power');
  api.step(2.2);           // the front rank reaching the wolves, the rest still coming
  g.onState(g.snapshot());
});
await page.screenshot({ path: join(out, '3-mama.png'), animations: 'disabled' });
console.log('3-mama.png');

/*
 * The boss, caught in its wind-up. This is the one frame that says the game has
 * an ending: the Cart reared back with a second to go, which is exactly what a
 * player sees before it comes at them.
 */
await page.evaluate(() => {
  const api = globalThis.__niulaiFight;
  const g = api.game;
  // Skip to the last gate and let it open.
  for (let i = 0; i < g.gates.length - 1; i++) g.gates[i].opened = true;
  g.gateIndex = g.gates.length - 1;
  const gate = g.gates[g.gateIndex];
  gate.opened = false;
  for (const enemy of g.enemies) g.scene.remove(enemy.root);
  g.enemies = [];
  g.spawnQueue = 0;
  g.player.position.set(gate.x - 4.4, 0, 0.35);
  g.player.health = g.player.maxHealth;
  g.player.dead = false; g.player.downTimer = 0; g.player.stunTimer = 0;
  g.player.facing = 1;
  api.step(0.25);

  // One wolf left standing, so the shot reads as a fight rather than a standoff.
  g.spawnQueue = 0;
  const keep = g.enemies.filter((e) => !g.boss || e !== g.boss.fighter).slice(0, 1);
  for (const enemy of g.enemies) {
    if (g.boss && enemy === g.boss.fighter) continue;
    if (!keep.includes(enemy)) g.scene.remove(enemy.root);
  }
  g.enemies = g.enemies.filter((e) => (g.boss && e === g.boss.fighter) || keep.includes(e));
  if (keep[0]) keep[0].root.position.set(g.player.position.x - 1.3, 0, g.player.position.z - 0.5);

  // The camera needs a moment to reach its pulled-back boss framing.
  g.boss.fighter.position.set(g.player.position.x + 3.6, 0, 0.35);
  api.step(1.2);
  g.boss.enter('wind');
  api.step(0.75);          // most of the way through the tell, at its loudest
  g.onState(g.snapshot()); // so the bar says CHARGING, like it does in play
});
// The wind-up flashes the boss bar, and a screenshot taken mid-flash catches it
// at a third opacity. Freezing the animation takes its finished state instead.
await page.screenshot({ path: join(out, '4-boss.png'), animations: 'disabled' });
console.log('4-boss.png');

// A clean frame of the world with no interface, for the promo tiles. The boss
// is the strongest thing in the game to put on a tile, so it is taken here.
const plate = await page.evaluate(() => {
  const api = globalThis.__niulaiFight;
  const g = api.game;
  document.getElementById('hud').style.visibility = 'hidden';
  document.getElementById('banner').hidden = true;
  api.step(0.12);
  g.render();
  return document.getElementById('view').toDataURL('image/png');
});

/*
 * The ending. Cleared for real rather than by setting `over` by hand, because
 * the celebration only starts on the path the game actually takes to its ending
 * — and the celebration is the shot.
 */
await page.evaluate(() => {
  const api = globalThis.__niulaiFight;
  const g = api.game;
  document.getElementById('hud').style.visibility = '';
  g.score = 12400;
  for (const enemy of g.enemies) g.scene.remove(enemy.root);
  g.enemies = [];
  g.boss = null;
  g.spawnQueue = 0;
  g.power.clear();
  g.player.health = g.player.maxHealth;
  g.player.dead = false; g.player.downTimer = 0; g.player.stunTimer = 0;
  api.step(0.2);      // the last gate clears; he starts celebrating
  api.step(3.0);      // the apex of the flip: limbs out, silhouette unmistakable
  g.onState(g.snapshot());
});
await page.screenshot({ path: join(out, '5-win.png'), animations: 'disabled' });
console.log('5-win.png');
await page.close();

/* ------------------------------------------------------- tiles and icons */

const tilePage = await browser.newPage({ viewport: { width: 1500, height: 700 } });
await tilePage.goto(`${url}__blank`);
await tilePage.addScriptTag({ content: readFileSync(join(root, 'dist/merge-deps.js'), 'utf8') });

const art = await tilePage.evaluate(async ({ plate, modelUrl }) => {
  const { GLTFLoader, THREE } = globalThis.__mergeDeps;

  const frame = new Image();
  await new Promise((resolve, reject) => {
    frame.onload = resolve; frame.onerror = reject; frame.src = plate;
  });

  const FONT = '"Liberation Sans", "DejaVu Sans", system-ui, sans-serif';

  /* A promo tile: a slice of the game, darkened on one side, with the name. */
  function tile(w, h, titleSize, lines, lineSize) {
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');

    // Cover-crop, biased toward the right where the fighters are.
    const cover = Math.max(w / frame.width, h / frame.height);
    const dw = frame.width * cover, dh = frame.height * cover;
    ctx.drawImage(frame, w - dw + dw * 0.06, (h - dh) * 0.62, dw, dh);

    // Text needs a floor to stand on: painted scenery is a coin toss.
    const veil = ctx.createLinearGradient(0, 0, w, 0);
    veil.addColorStop(0, 'rgba(10,14,20,0.95)');
    veil.addColorStop(0.34, 'rgba(10,14,20,0.78)');
    veil.addColorStop(0.62, 'rgba(10,14,20,0.06)');
    veil.addColorStop(1, 'rgba(10,14,20,0)');
    ctx.fillStyle = veil;
    ctx.fillRect(0, 0, w, h);

    const pad = Math.round(w * 0.06);
    ctx.textAlign = 'left';
    ctx.fillStyle = '#ffd76a';
    ctx.font = `700 ${titleSize}px ${FONT}`;
    ctx.fillText('Niulai Fight', pad, h * 0.42);
    ctx.fillStyle = '#f4e7cf';
    ctx.font = `700 ${Math.round(titleSize * 0.72)}px ${FONT}`;
    ctx.fillText('牛来大战', pad, h * 0.42 + titleSize * 0.86);

    ctx.fillStyle = '#c3ccd8';
    ctx.font = `400 ${lineSize}px ${FONT}`;
    lines.forEach((line, i) => {
      ctx.fillText(line, pad, h * 0.42 + titleSize * 0.86 + lineSize * (2.1 + i * 1.45));
    });
    return canvas.toDataURL('image/png');
  }

  const small = tile(440, 280, 40, ['A side-scrolling brawler', 'in your browser.'], 15);
  const marquee = tile(1400, 560, 104, [
    'Walk right. The screen stops. Wolves arrive.',
    'Fill the bar, shout for mama, and ten of her arrive.'
  ], 30);

  /*
   * The icon is its own render rather than a crop of the game: at 16 pixels a
   * cropped screenshot is mud, and the one thing that has to survive is the
   * silhouette of a head.
   */
  const gltf = await new GLTFLoader().loadAsync(modelUrl);
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight('#ffffff', '#3a2f22', 2.0));
  const key = new THREE.DirectionalLight('#fff2d8', 2.4);
  key.position.set(1.5, 3, 4);
  scene.add(key);

  const model = gltf.scene;
  scene.add(model);

  // The guard pose, so the icon says "fighting game" rather than "animal".
  const punch = THREE.AnimationClip.findByName(gltf.animations, 'punch');
  if (punch) {
    const mixer = new THREE.AnimationMixer(model);
    const action = mixer.clipAction(punch);
    action.play();
    action.time = 0.02;   // the stance before the guard comes up over the face
    mixer.update(0);
  }
  model.updateMatrixWorld(true);

  const box = new THREE.Box3().setFromObject(model);
  const size = new THREE.Vector3(); box.getSize(size);
  const centre = new THREE.Vector3(); box.getCenter(centre);

  /*
   * Frame on the head bone rather than on a fraction of the figure.
   *
   * Guessing "the top fifth" put the crop through the ears and off to one
   * side, because a guard pose is neither symmetrical nor the shape the
   * estimate assumed — a raised fist moves the bounding box, and the box is
   * all a guess has to work with. The rig knows where the head is; ask it.
   */
  let head = null;
  model.traverse((node) => {
    if (!head && node.isBone && /head/i.test(node.name)) head = node;
  });

  const focus = new THREE.Vector3();
  if (head) head.getWorldPosition(focus);
  else focus.set(centre.x, box.max.y - size.y * 0.13, centre.z);

  const headSpan = size.y * 0.26;
  model.position.set(-focus.x, -focus.y, -focus.z);

  const camera = new THREE.PerspectiveCamera(26, 1, 0.1, 50);
  const fit = (headSpan * 2.75) / 2 / Math.tan((26 / 2) * Math.PI / 180);
  camera.position.set(0, 0, fit);
  camera.lookAt(0, 0, 0);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  const S = 512;
  renderer.setSize(S, S, false);
  renderer.render(scene, camera);

  const icon = document.createElement('canvas');
  icon.width = icon.height = S;
  const ictx = icon.getContext('2d');
  const bg = ictx.createLinearGradient(0, 0, S, S);
  bg.addColorStop(0, '#2f4a26');
  bg.addColorStop(1, '#16241a');
  ictx.fillStyle = bg;
  ictx.beginPath();
  ictx.roundRect(0, 0, S, S, S * 0.22);
  ictx.fill();
  ictx.drawImage(renderer.domElement, 0, 0, S, S);

  // Down-scaled copies for the manifest, drawn from the big one so the small
  // sizes are filtered rather than re-rendered at a size nothing survives.
  function scaled(px) {
    const c = document.createElement('canvas');
    c.width = c.height = px;
    const cx = c.getContext('2d');
    cx.imageSmoothingQuality = 'high';
    cx.drawImage(icon, 0, 0, px, px);
    return c.toDataURL('image/png');
  }

  return {
    small, marquee,
    icons: { 16: scaled(16), 32: scaled(32), 48: scaled(48), 128: scaled(128) }
  };
}, { plate, modelUrl: `${url}assets/models/niulai-rigged.glb` });

const write = (path, dataUrl) =>
  writeFileSync(path, Buffer.from(dataUrl.split(',')[1], 'base64'));

write(join(out, 'promo-440x280.png'), art.small);
write(join(out, 'promo-1400x560.png'), art.marquee);
write(join(out, 'icon-128.png'), art.icons[128]);
console.log('promo-440x280.png\npromo-1400x560.png\nicon-128.png');

mkdirSync(join(root, 'icons'), { recursive: true });
for (const [size, dataUrl] of Object.entries(art.icons)) {
  write(join(root, 'icons', `icon${size}.png`), dataUrl);
}
console.log('icons/icon{16,32,48,128}.png');

await browser.close();
server.close();
