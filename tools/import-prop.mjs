import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from './serve.mjs';

/*
 * Brings a static model — a prop, a vehicle, anything with no rig — into
 * assets/models/.
 *
 *   node tools/import-prop.mjs incoming/props/cart.glb cart-boss
 *
 * The characters go through tools/merge-animations.mjs, which exists because
 * Meshy ships one file per animation. A prop has no animations at all, so none
 * of that applies; what it still needs is the other half of that tool's job:
 *
 *   - the textures re-encoded. The exporter writes PNG, and a photographic
 *     texture as PNG is how a 5 MB model becomes a 12 MB one. WebP capped at
 *     1024 is a tenth of the size and indistinguishable at the size the thing
 *     is drawn;
 *   - the model moved onto its own feet. A prop's origin is wherever the
 *     generator left it, and the game places actors by putting their root at
 *     y = 0 on the ground. Centring in X and Z and dropping the base to y = 0
 *     means the registry's scale is the only number anyone has to tune;
 *   - measured, so that scale is read off the model rather than guessed.
 *
 * Runs in headless Chromium because three.js's exporter is a browser thing.
 */

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const [source, name] = process.argv.slice(2);
if (!source || !name) {
  console.error('usage: node tools/import-prop.mjs <path/to/model.glb> <output-name>');
  process.exit(1);
}

const { server, url: origin } = await serve(0);
const browser = await chromium.launch({
  args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
  executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined
});

const page = await browser.newPage();
await page.goto(`${origin}__blank`);
await page.addScriptTag({ content: readFileSync(join(root, 'dist/merge-deps.js'), 'utf8') });

const result = await page.evaluate(async ({ modelUrl }) => {
  const { GLTFLoader, GLTFExporter, THREE } = globalThis.__mergeDeps;

  const response = await fetch(modelUrl);
  if (!response.ok) throw new Error(`${response.status} fetching ${modelUrl}`);
  const gltf = await new GLTFLoader().parseAsync(await response.arrayBuffer(), '');
  const scene = gltf.scene;

  const MAX_TEXTURE = 1024;
  const textures = new Set();
  scene.traverse((node) => {
    if (!node.isMesh) return;
    node.castShadow = true;
    node.receiveShadow = true;
    for (const material of [].concat(node.material)) {
      for (const slot of ['map', 'emissiveMap', 'normalMap', 'roughnessMap', 'metalnessMap']) {
        if (material && material[slot]) textures.add(material[slot]);
      }
    }
  });

  const textureReport = [];
  for (const texture of textures) {
    const image = texture.image;
    if (!image || !image.width) continue;
    const scaleDown = Math.min(1, MAX_TEXTURE / Math.max(image.width, image.height));
    if (scaleDown < 1) {
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(image.width * scaleDown);
      canvas.height = Math.round(image.height * scaleDown);
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
      textureReport.push(`${image.width}x${image.height} -> ${canvas.width}x${canvas.height}`);
      texture.image = canvas;
    } else {
      textureReport.push(`${image.width}x${image.height} kept`);
    }
    texture.userData.mimeType = 'image/webp';
    texture.needsUpdate = true;
  }

  /*
   * Sit it on the floor, centred. The game puts an actor's root at y = 0 on
   * the ground and moves it in X and Z from there, so a model whose origin is
   * at its own centre floats by half its height and drifts sideways from the
   * position the code thinks it is steering.
   */
  const before = new THREE.Box3().setFromObject(scene);
  const size = new THREE.Vector3(); before.getSize(size);
  const centre = new THREE.Vector3(); before.getCenter(centre);
  scene.position.set(-centre.x, -before.min.y, -centre.z);
  scene.updateMatrixWorld(true);

  const glb = await new GLTFExporter().parseAsync(scene, { binary: true, embedImages: true });
  const bytes = new Uint8Array(glb);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  }
  return {
    base64: btoa(binary),
    textures: textureReport,
    size: { x: size.x, y: size.y, z: size.z },
    meshes: scene.children.length
  };
}, { modelUrl: `${origin}${source.split('/').map(encodeURIComponent).join('/')}` });

mkdirSync(join(root, 'assets/models'), { recursive: true });
const out = join(root, 'assets/models', `${name}.glb`);
writeFileSync(out, Buffer.from(result.base64, 'base64'));

const { x, y, z } = result.size;
console.log(`${source} -> assets/models/${name}.glb`);
console.log(`  ${(statSync(source).size / 1048576).toFixed(1)} MB in, ` +
  `${(statSync(out).size / 1048576).toFixed(1)} MB out`);
console.log(`  textures: ${result.textures.join(', ') || 'none'} (written as WebP)`);
console.log(`  bounds: ${x.toFixed(3)} wide x ${y.toFixed(3)} tall x ${z.toFixed(3)} deep`);
console.log(`  long axis is ${x >= z ? 'X' : 'Z'} — the registry's faceOffset turns that along the belt`);
console.log(`  suggested "scale": ${(1 / y).toFixed(4)}  (to stand one unit tall)`);

await browser.close();
server.close();
