import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * Renders every clip as a strip of frames, one row per clip.
 *
 *   node tools/clip-sheet.mjs
 *
 * A clip list tells you a punch is four seconds long. It does not tell you
 * that three of those seconds are the character standing in a guard stance
 * before it throws anything — and that is the thing you need to know to use
 * the clip in a game, because a brawler's punch has to be over in a quarter of
 * a second. The only way to find the part worth keeping is to look at it.
 */

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'docs', 'clips');
mkdirSync(out, { recursive: true });

const model = readFileSync(join(root, 'assets/models/niulai-rigged.glb')).toString('base64');
const COLUMNS = Number(process.env.COLUMNS_PER_CLIP || 10);

const browser = await chromium.launch({
  args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
  executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined
});
const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
await page.addScriptTag({ content: readFileSync(join(root, 'dist/merge-deps.js'), 'utf8') });

const sheet = await page.evaluate(async ({ base64, columns }) => {
  const { GLTFLoader, THREE } = globalThis.__mergeDeps;
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)).buffer;
  const gltf = await new GLTFLoader().parseAsync(bytes, '');

  const cell = 190;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#f4f2ee');
  scene.add(new THREE.HemisphereLight('#ffffff', '#7a7a6a', 2.0));
  const key = new THREE.DirectionalLight('#ffffff', 2.0);
  key.position.set(2, 4, 5);
  scene.add(key);

  const model = gltf.scene;
  const box = new THREE.Box3().setFromObject(model);
  const size = new THREE.Vector3(); box.getSize(size);
  const centre = new THREE.Vector3(); box.getCenter(centre);
  model.position.sub(centre);
  model.position.y += size.y / 2;
  const holder = new THREE.Group();
  holder.add(model);
  scene.add(holder);

  // Three-quarter view: a punch thrown straight at a side-on camera is a
  // character standing still.
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
  const dist = size.y * 2.4;
  camera.position.set(dist * 0.55, size.y * 0.62, dist * 0.85);
  camera.lookAt(0, size.y * 0.5, 0);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setSize(cell, cell, false);
  renderer.setClearColor('#f4f2ee');

  const mixer = new THREE.AnimationMixer(model);
  const clips = gltf.animations.slice().sort((a, b) => a.name.localeCompare(b.name));

  const label = 26;
  const canvas = document.createElement('canvas');
  canvas.width = cell * columns;
  canvas.height = (cell + label) * clips.length;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#f4f2ee';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const results = [];
  for (let row = 0; row < clips.length; row++) {
    const clip = clips[row];
    const action = mixer.clipAction(clip);
    action.reset().play();

    for (let col = 0; col < columns; col++) {
      const t = (clip.duration * col) / (columns - 1 || 1);
      action.time = Math.min(t, clip.duration - 1e-4);
      mixer.update(0);
      renderer.render(scene, camera);
      ctx.drawImage(renderer.domElement, col * cell, row * (cell + label));

      ctx.fillStyle = '#8a8378';
      ctx.font = '11px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`${t.toFixed(2)}s`, col * cell + cell / 2, row * (cell + label) + cell + 14);
    }
    action.stop();

    ctx.fillStyle = '#1b1b1b';
    ctx.font = '600 15px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`${clip.name}  ·  ${clip.duration.toFixed(2)}s`, 8, row * (cell + label) + 18);
    results.push({ name: clip.name, duration: clip.duration });
  }

  return { url: canvas.toDataURL('image/png'), clips: results };
}, { base64: model, columns: COLUMNS });

writeFileSync(join(out, 'contact-sheet.png'), Buffer.from(sheet.url.split(',')[1], 'base64'));
console.log(`docs/clips/contact-sheet.png — ${sheet.clips.length} clips, ${COLUMNS} frames each`);
for (const clip of sheet.clips) console.log(`  ${clip.name.padEnd(8)} ${clip.duration.toFixed(2)}s`);

await browser.close();
