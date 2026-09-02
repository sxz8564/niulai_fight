import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from './serve.mjs';

/*
 * Puts a new skin on a character that already has its animations.
 *
 *   node tools/retexture.mjs superbaola incoming/textures/superbaola.glb
 *
 * Meshy re-texturing hands back a *static* model: the same mesh, new maps, no
 * rig and no clips. Dropping that into incoming/ and re-merging would throw the
 * animations away, because the merge keeps the first file's mesh and there is
 * no skeleton in this one for the clips to bind to.
 *
 * So the maps move rather than the mesh. The rigged model keeps its skeleton,
 * its skinning weights and all of its clips, and only its material changes.
 * That works because a re-texture is the same geometry with the same UV layout
 * — the vertex counts differ slightly, since rigging splits seams, but the
 * unwrap does not move, which is the thing a texture actually depends on. The
 * proof is a render, not an argument, so look at one before shipping it.
 */

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const [name, skinPath] = process.argv.slice(2);
if (!name || !skinPath) {
  console.error('usage: node tools/retexture.mjs <character> <path/to/textured.glb>');
  process.exit(1);
}
const target = join(root, 'assets/models', `${name}-rigged.glb`);

const { server, url: origin } = await serve(0);
const browser = await chromium.launch({
  args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
  executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined
});
const page = await browser.newPage();
await page.goto(`${origin}__blank`);
await page.addScriptTag({ content: readFileSync(join(root, 'dist/merge-deps.js'), 'utf8') });

const result = await page.evaluate(async ({ riggedUrl, skinUrl }) => {
  const { GLTFLoader, GLTFExporter, THREE } = globalThis.__mergeDeps;
  const loader = new GLTFLoader();

  const grab = async (url) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${response.status} fetching ${url}`);
    return loader.parseAsync(await response.arrayBuffer(), '');
  };

  const rigged = await grab(riggedUrl);
  const skin = await grab(skinUrl);

  let source = null;
  skin.scene.traverse((node) => {
    if (!source && node.isMesh) source = [].concat(node.material)[0];
  });
  if (!source || !source.map) throw new Error('the textured model has no base colour map');

  /*
   * Base colour and normal only. The re-texture also ships a
   * metallic-roughness map, and taking it would override the factors the
   * animated export set — a character that looked right suddenly reading as wet
   * plastic. The two maps below are what "a new texture" means to look at.
   */
  const applied = [];
  let count = 0;
  rigged.scene.traverse((node) => {
    if (!node.isMesh && !node.isSkinnedMesh) return;
    node.castShadow = true;
    node.receiveShadow = true;
    for (const material of [].concat(node.material)) {
      material.map = source.map;
      if (source.normalMap) material.normalMap = source.normalMap;
      material.needsUpdate = true;
      count++;
    }
  });
  applied.push(`baseColor${source.normalMap ? ' + normal' : ''} onto ${count} material(s)`);

  const MAX_TEXTURE = 1024;
  const textures = new Set();
  rigged.scene.traverse((node) => {
    if (!node.isMesh && !node.isSkinnedMesh) return;
    for (const material of [].concat(node.material)) {
      for (const slot of ['map', 'normalMap']) {
        if (material && material[slot]) textures.add(material[slot]);
      }
    }
  });

  const report = [];
  for (const texture of textures) {
    const image = texture.image;
    if (!image || !image.width) continue;
    const scaleDown = Math.min(1, MAX_TEXTURE / Math.max(image.width, image.height));
    if (scaleDown < 1) {
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(image.width * scaleDown);
      canvas.height = Math.round(image.height * scaleDown);
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
      report.push(`${image.width}x${image.height} -> ${canvas.width}x${canvas.height}`);
      texture.image = canvas;
    } else {
      report.push(`${image.width}x${image.height} kept`);
    }
    texture.userData.mimeType = 'image/webp';
    texture.needsUpdate = true;
  }

  const glb = await new GLTFExporter().parseAsync(rigged.scene, {
    binary: true, animations: rigged.animations, embedImages: true
  });
  const bytes = new Uint8Array(glb);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  }
  return {
    base64: btoa(binary),
    applied,
    textures: report,
    clips: rigged.animations.map((clip) => clip.name)
  };
}, {
  riggedUrl: `${origin}assets/models/${name}-rigged.glb`,
  skinUrl: `${origin}${skinPath.split('/').map(encodeURIComponent).join('/')}`
});

const before = statSync(target).size;
writeFileSync(target, Buffer.from(result.base64, 'base64'));

console.log(`${skinPath} -> assets/models/${name}-rigged.glb`);
console.log(`  ${(before / 1048576).toFixed(1)} MB -> ${(statSync(target).size / 1048576).toFixed(1)} MB`);
console.log(`  ${result.applied.join(', ')}`);
console.log(`  textures: ${result.textures.join(', ')} (written as WebP)`);
console.log(`  clips kept: ${result.clips.join(', ')}`);

await browser.close();
server.close();
