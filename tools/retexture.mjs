import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from './serve.mjs';

/*
 * Puts a re-textured model onto a character that already has its animations.
 *
 *   node tools/retexture.mjs superbaola incoming/textures/superbaola.glb
 *
 * Re-texturing hands back a *static* model: the same character, new maps, no
 * rig and no clips. Dropping that into incoming/ and re-merging would throw the
 * animations away, because the merge keeps the first file's mesh and there is
 * no skeleton in this one for the clips to bind to.
 *
 * The obvious shortcut is to move the maps: keep the rigged mesh and point its
 * material at the new images. That is wrong, and it was shipped once before it
 * was caught. A re-texture comes back with its own UV unwrap — the same
 * character laid out differently on the sheet — so the new image on the old
 * unwrap is a smear. The atlases look nothing alike side by side, which is the
 * two-second check that would have saved the trip.
 *
 * What is true is that the *geometry* is identical: every vertex of the new
 * mesh lands exactly on a vertex of the old one once the unit-height export is
 * scaled back up. So the mesh moves instead. The new geometry, with its own
 * UVs, is bound to the old skeleton by copying each vertex's weights from the
 * vertex it coincides with, and the old material keeps its shape and gets the
 * new images. The clips never move at all.
 *
 * The vertex counts differ — 4104 against 4096 for Super Baola — because a
 * different unwrap splits seams differently. That is why the match is done by
 * position rather than by index, and why every vertex has to find a partner or
 * this refuses to write anything.
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
  const firstMesh = (gltf) => {
    let found = null;
    gltf.scene.traverse((node) => {
      if (!found && (node.isMesh || node.isSkinnedMesh)) found = node;
    });
    return found;
  };

  const rigged = await grab(riggedUrl);
  const skin = await grab(skinUrl);
  const old = firstMesh(rigged);
  const fresh = firstMesh(skin);
  if (!old || !old.isSkinnedMesh) throw new Error('the rigged model has no skinned mesh');
  if (!fresh) throw new Error('the textured model has no mesh');

  const source = [].concat(fresh.material)[0];
  if (!source || !source.map) throw new Error('the textured model has no base colour map');

  /*
   * Put the new geometry in the old one's frame. The re-texture is exported at
   * unit height and centred on its own box; the rigged model stands on the
   * floor at its real size. Matching height and box centre is enough, and the
   * proof that it is enough is that every vertex then coincides exactly.
   */
  const geometry = fresh.geometry.clone();
  const oldBox = new THREE.Box3().setFromBufferAttribute(old.geometry.attributes.position);
  const newBox = new THREE.Box3().setFromBufferAttribute(geometry.attributes.position);
  const oldSize = new THREE.Vector3(); oldBox.getSize(oldSize);
  const newSize = new THREE.Vector3(); newBox.getSize(newSize);
  const oldMid = new THREE.Vector3(); oldBox.getCenter(oldMid);
  const newMid = new THREE.Vector3(); newBox.getCenter(newMid);
  const k = oldSize.y / newSize.y;
  geometry.translate(-newMid.x, -newMid.y, -newMid.z);
  geometry.scale(k, k, k);
  geometry.translate(oldMid.x, oldMid.y, oldMid.z);

  /*
   * Match by position. Quantised, because the two exports round their floats
   * independently — a shared vertex can differ in the last bit and still be the
   * same vertex.
   */
  const QUANTUM = 1e4;
  const key = (x, y, z) =>
    `${Math.round(x * QUANTUM)},${Math.round(y * QUANTUM)},${Math.round(z * QUANTUM)}`;
  const oldPos = old.geometry.attributes.position;
  const oldJoints = old.geometry.attributes.skinIndex;
  const oldWeights = old.geometry.attributes.skinWeight;
  if (!oldJoints || !oldWeights) throw new Error('the rigged mesh has no skinning attributes');

  const byPosition = new Map();
  for (let i = 0; i < oldPos.count; i++) {
    const k2 = key(oldPos.getX(i), oldPos.getY(i), oldPos.getZ(i));
    if (!byPosition.has(k2)) byPosition.set(k2, i);
  }

  /*
   * A hash lookup gets all but a handful. The stragglers are not different
   * vertices — they are the same vertex whose coordinate rounded to the far
   * side of a bucket boundary in one export and the near side in the other — so
   * a miss falls back to the nearest vertex within a tolerance, and only a miss
   * beyond that tolerance means the models really are different.
   */
  const pos = geometry.attributes.position;
  const joints = new Uint16Array(pos.count * 4);
  const weights = new Float32Array(pos.count * 4);
  const tolerance = oldSize.y * 0.002;   // two thousandths of the model's height
  let searched = 0;
  let worst = 0;
  const orphaned = [];
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    let at = byPosition.get(key(x, y, z));
    if (at === undefined) {
      searched++;
      let best = Infinity;
      for (let j = 0; j < oldPos.count; j++) {
        const dx = oldPos.getX(j) - x, dy = oldPos.getY(j) - y, dz = oldPos.getZ(j) - z;
        const d = dx * dx + dy * dy + dz * dz;
        if (d < best) { best = d; at = j; }
      }
      const away = Math.sqrt(best);
      if (away > worst) worst = away;
      if (away > tolerance) { orphaned.push(away); continue; }
    }
    joints[i * 4] = oldJoints.getX(at); joints[i * 4 + 1] = oldJoints.getY(at);
    joints[i * 4 + 2] = oldJoints.getZ(at); joints[i * 4 + 3] = oldJoints.getW(at);
    weights[i * 4] = oldWeights.getX(at); weights[i * 4 + 1] = oldWeights.getY(at);
    weights[i * 4 + 2] = oldWeights.getZ(at); weights[i * 4 + 3] = oldWeights.getW(at);
  }
  if (orphaned.length) {
    throw new Error(`${orphaned.length} of ${pos.count} vertices are more than ` +
      `${tolerance.toFixed(4)} from anything in the rigged mesh (worst ${worst.toFixed(4)}) — ` +
      'these are not the same model, and nothing has been written');
  }
  geometry.setAttribute('skinIndex', new THREE.BufferAttribute(joints, 4));
  geometry.setAttribute('skinWeight', new THREE.BufferAttribute(weights, 4));

  /*
   * The old material keeps its shape and only its images change. These exports
   * put the same texture in three places — base colour, emissive at full white,
   * and normal — which is how the generator makes a model read flat and unlit,
   * and it is the emissive that decides what the character actually looks like.
   * Rebuilding the material from the static export instead would light her
   * differently from everyone else in the game.
   */
  const material = [].concat(old.material)[0];
  const slots = [];
  for (const slot of ['map', 'emissiveMap', 'aoMap', 'lightMap', 'specularMap', 'alphaMap']) {
    if (!material[slot]) continue;
    material[slot] = source.map;
    slots.push(slot);
  }
  if (material.normalMap || source.normalMap) {
    material.normalMap = source.normalMap || material.normalMap;
    slots.push('normalMap');
  }
  material.needsUpdate = true;

  old.geometry = geometry;
  old.castShadow = true;
  old.receiveShadow = true;

  // Anything still pointing at an image that did not come from the new file is
  // a slot this tool does not know about, and half a character is worse than
  // none.
  const wanted = new Set([source.map, source.normalMap].filter(Boolean));
  const stale = [];
  for (const key3 of Object.keys(material)) {
    const value = material[key3];
    if (value && value.isTexture && !wanted.has(value)) stale.push(key3);
  }
  if (stale.length) throw new Error(`still pointing at the old texture in: ${stale.join(', ')}`);

  const MAX_TEXTURE = 1024;
  const report = [];
  for (const texture of wanted) {
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
    verts: { was: oldPos.count, now: pos.count, searched, worst: Number(worst.toFixed(6)) },
    scaledBy: Number(k.toFixed(4)),
    slots,
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
console.log(`  mesh replaced: ${result.verts.was} verts -> ${result.verts.now}, ` +
  `every one matched by position (scaled x${result.scaledBy})`);
console.log(`  ${result.verts.searched} needed a nearest-neighbour search, ` +
  `worst gap ${result.verts.worst}`);
console.log(`  images into: ${result.slots.join(', ')}`);
console.log(`  textures: ${result.textures.join(', ')} (written as WebP)`);
console.log(`  clips kept: ${result.clips.join(', ')}`);

await browser.close();
server.close();
