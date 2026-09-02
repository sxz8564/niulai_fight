import { createRequire } from 'node:module';
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * Turns a folder of one-clip Meshy exports into a single playable character.
 *
 *   node tools/merge-animations.mjs
 *
 * Meshy exports one file per animation and puts the whole skinned mesh in each
 * of them, so five animations arrive as five copies of the same 5 MB
 * character. Shipping them as they are would mean downloading the model five
 * times to get five clips.
 *
 * This keeps the mesh from the first file, takes the clip out of every file,
 * and writes one .glb. It also does three things the exports need before a
 * game can use them:
 *
 *   - renames the clips, because "Armature|Boxing_Guard_Prep_Straight_Punch|
 *     baselayer" is not a name any game logic should have to say;
 *   - strips root translation, because the game decides where the character
 *     is. A clip that walks the root forward would drag the character out from
 *     under the code that thinks it is steering;
 *   - reports the rest bounding box, so the scale in the registry can be set
 *     from a measurement rather than a guess.
 *
 * Runs in headless Chromium because three.js's exporter is a browser thing.
 */

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const inbox = join(root, 'incoming');
const outDir = join(root, 'assets/models');

/** The clip a Meshy filename is really describing, mapped to a game state. */
const NAMING = [
  { match: /Prep_Straight_Punch/i, name: 'punch' },
  { match: /Right_Straight_Kick/i, name: 'kick' },
  { match: /Step_Knee_Strike/i, name: 'knee' },
  // Order matters below: BeHit_FlyUp is a knockdown, and would otherwise be
  // caught by the /Hit/ rule meant for the standing flinch.
  { match: /BeHit_FlyUp|Death|Knock|Fall/i, name: 'down' },
  { match: /Hit_Reaction|BeHit/i, name: 'hit' },
  { match: /Jump_Over_Obstacle/i, name: 'hurdle' },
  { match: /Back_Jump/i, name: 'backjump' },
  { match: /Regular_Jump|^.*Jump/i, name: 'jump' },
  { match: /Running|Run(?!g)/i, name: 'run' },
  { match: /Walking|Walk/i, name: 'walk' },
  { match: /Block/i, name: 'block' },
  { match: /Idle|Guard_Idle/i, name: 'idle' }
];

function clipNameFor(file) {
  const found = NAMING.find((rule) => rule.match.test(file));
  return found ? found.name : null;
}

/*
 * How much of a clip's upward root motion to keep.
 *
 * BeHit_FlyUp does what its name says: the hips go from a standing 67 up to
 * 209, about three body heights, and the character leaves the top of a fixed
 * camera entirely. A knockdown nobody can see is worse than no knockdown, so
 * the launch is compressed to something that still pops but stays in frame.
 *
 * Only motion *above* where the clip started is scaled. The end of that clip
 * has the hips at 7, lying on the ground, and scaling that toward the standing
 * height would leave the character floating above the floor it just hit.
 */
const ROOT_RISE = { down: 0.3 };

const files = readdirSync(inbox).filter((f) => f.toLowerCase().endsWith('.glb')).sort();
if (!files.length) {
  console.error(`No .glb files in ${inbox}`);
  process.exit(1);
}

const named = files.map((file) => ({ file, state: clipNameFor(file) }));
for (const entry of named) {
  if (!entry.state) console.warn(`  ? no state matched for ${entry.file} — it will keep its own name`);
}

const payload = named.map(({ file, state }) => ({
  file,
  state,
  base64: readFileSync(join(inbox, file)).toString('base64')
}));

const browser = await chromium.launch({
  args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
  executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined
});
const page = await browser.newPage();
await page.addScriptTag({ content: readFileSync(join(root, 'dist/merge-deps.js'), 'utf8') });

const result = await page.evaluate(async ({ inputs, riseFor }) => {
  const { GLTFLoader, GLTFExporter, THREE } = globalThis.__mergeDeps;
  const loader = new GLTFLoader();

  const loaded = [];
  for (const input of inputs) {
    const bytes = Uint8Array.from(atob(input.base64), (c) => c.charCodeAt(0)).buffer;
    const gltf = await loader.parseAsync(bytes, '');
    loaded.push({ ...input, gltf });
  }

  const base = loaded[0];
  const scene = base.gltf.scene;

  const clips = [];
  const report = [];
  for (const item of loaded) {
    for (const clip of item.gltf.animations) {
      const original = clip.name;
      clip.name = item.state || original.replace(/^Armature\|/, '').replace(/\|baselayer$/, '');

      /*
       * Root translation has to go. These clips move the whole character —
       * a jump travels forward, a punch steps in — and the game is the thing
       * that decides where a character stands. Left in, the mesh would slide
       * away from the position the game is steering, and hit detection would
       * be measuring somewhere the character is not.
       *
       * Only translation on the root, and only X and Z: the Y is what makes a
       * jump leave the ground, and dropping it would flatten the jump.
       */
      const rootNames = new Set();
      scene.traverse((node) => {
        if (node.isBone && (!node.parent || !node.parent.isBone)) rootNames.add(node.name);
      });

      let stripped = 0;
      const rise = riseFor[clip.name] != null ? riseFor[clip.name] : 1;
      for (const track of clip.tracks) {
        const [nodeName, property] = track.name.split('.');
        if (property !== 'position' || !rootNames.has(nodeName)) continue;
        const values = track.values;
        const x0 = values[0], y0 = values[1], z0 = values[2];
        for (let i = 0; i < values.length; i += 3) {
          values[i] = x0;         // hold X where the clip started
          values[i + 2] = z0;     // and Z; Y is what makes a jump leave the ground
          if (rise !== 1 && values[i + 1] > y0) {
            values[i + 1] = y0 + (values[i + 1] - y0) * rise;
          }
        }
        stripped++;
      }

      clips.push(clip);
      report.push({
        state: clip.name,
        from: original,
        seconds: Number(clip.duration.toFixed(3)),
        tracks: clip.tracks.length,
        rootTracksFlattened: stripped,
        rise
      });
    }
  }

  /*
   * The exporter writes PNG by default, which for a photographic character
   * texture is the worst possible choice — the first pass through here turned
   * a 5 MB model into a 6.5 MB one, 6 of which was a single PNG. Asking for
   * WebP and capping the size cuts that by an order of magnitude with no
   * visible difference at the size a character is drawn on screen.
   */
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

  // Measure the character standing in its rest pose, so the game's scale can
  // be computed rather than guessed.
  const box = new THREE.Box3().setFromObject(scene);
  const size = new THREE.Vector3();
  box.getSize(size);

  const exporter = new GLTFExporter();
  const glb = await exporter.parseAsync(scene, {
    binary: true,
    animations: clips,
    // Meshy models carry one big texture; leaving it as-is keeps the file the
    // size of one character rather than one per clip.
    embedImages: true
  });

  const bytes = new Uint8Array(glb);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  }
  return {
    base64: btoa(binary),
    report,
    textures: textureReport,
    size: { x: size.x, y: size.y, z: size.z },
    min: { x: box.min.x, y: box.min.y, z: box.min.z }
  };
}, { inputs: payload, riseFor: ROOT_RISE });

mkdirSync(outDir, { recursive: true });
const out = join(outDir, 'niulai-rigged.glb');
writeFileSync(out, Buffer.from(result.base64, 'base64'));

console.log(`\n${out}`);
console.log(`  ${(readFileSync(out).length / 1048576).toFixed(1)} MB, ${result.report.length} clips`);
console.log(`  rest pose: ${result.size.y.toFixed(3)} tall, feet at y=${result.min.y.toFixed(3)}`);
console.log(`  textures: ${result.textures.join(', ') || 'none'} (written as WebP)`);
console.log(`  suggested "scale": ${(1 / result.size.y).toFixed(3)}  (to stand one unit tall)\n`);
for (const clip of result.report) {
  console.log(`  ${clip.state.padEnd(8)} ${String(clip.seconds).padStart(6)}s  ` +
    `${clip.tracks} tracks, ${clip.rootTracksFlattened} root flattened` +
    `${clip.rise !== 1 ? `, rise x${clip.rise}` : ''}   [${clip.from}]`);
}

await browser.close();
