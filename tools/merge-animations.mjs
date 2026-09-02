import { createRequire } from 'node:module';
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * Turns folders of one-clip Meshy exports into playable characters.
 *
 * One folder per character under incoming/, named for the character:
 *
 *   incoming/niulai/*.glb    -> assets/models/niulai-rigged.glb
 *   incoming/wolfwolf/*.glb  -> assets/models/wolfwolf-rigged.glb
 *
 *   node tools/merge-animations.mjs            all of them
 *   node tools/merge-animations.mjs niulai     just that one
 *
 * Naming the characters matters once a character is finished: re-exporting one
 * that has not changed still writes a byte-different .glb, and a diff full of
 * megabytes nobody altered hides the one that was.
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

import { serve } from './serve.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const inbox = join(root, 'incoming');
const outDir = join(root, 'assets/models');

/** The clip a Meshy filename is really describing, mapped to a game state. */
const NAMING = [
  // Order matters throughout. These two go first because "Charged_Spell_Cast"
  // and "Bow_Charge" both contain words the later rules look for.
  { match: /Charged_Spell_Cast|Spell_Cast|Summon/i, name: 'summon' },
  { match: /Bow_Charge|Charge_Left_Hand/i, name: 'charge' },
  { match: /Prep_Straight_Punch/i, name: 'punch' },
  { match: /Right_Straight_Kick/i, name: 'kick' },
  { match: /Step_Knee_Strike/i, name: 'knee' },
  // Order matters below: BeHit_FlyUp is a knockdown, and would otherwise be
  // caught by the /Hit/ rule meant for the standing flinch.
  { match: /BeHit_FlyUp|Death|Knock|Fall/i, name: 'down' },
  { match: /Hit_Reaction|BeHit/i, name: 'hit' },
  { match: /Jump_Over_Obstacle/i, name: 'hurdle' },
  { match: /Back_Jump/i, name: 'backjump' },
  { match: /Jumping_Punch/i, name: 'jumppunch' },
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

/* Each subfolder of incoming/ is one character. Named ones only, if any. */
const wanted = process.argv.slice(2);
const found = readdirSync(inbox, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const characters = wanted.length ? found.filter((name) => wanted.includes(name)) : found;

for (const name of wanted) {
  if (!found.includes(name)) {
    console.error(`No folder ${inbox}/${name}`);
    process.exit(1);
  }
}
if (!characters.length) {
  console.error(`No character folders in ${inbox}. Expected e.g. ${inbox}/niulai/*.glb`);
  process.exit(1);
}

const { server, url: origin } = await serve(0);
const browser = await chromium.launch({
  args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
  executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined
});

mkdirSync(outDir, { recursive: true });

for (const character of characters) {
  const folder = join(inbox, character);
  const files = readdirSync(folder).filter((f) => f.toLowerCase().endsWith('.glb')).sort();
  if (!files.length) { console.warn(`  ${character}: no .glb files, skipped`); continue; }

  const named = files.map((file) => ({ file, state: clipNameFor(file) }));
  for (const entry of named) {
    if (!entry.state) console.warn(`  ? ${character}: no state matched for ${entry.file}`);
  }
  /*
   * Names and URLs only. Passing the files themselves through page.evaluate
   * means base64-encoding every one of them into a single argument, and with
   * three characters of eleven 5 MB clips each that is enough to take the
   * renderer out with an out-of-memory kill. The page fetches them instead,
   * one at a time, and lets each go before asking for the next.
   */
  const payload = named.map(({ file, state }) => ({
    file, state, url: `${origin}incoming/${character}/${encodeURIComponent(file)}`
  }));

  // A fresh page per character: the previous one is holding a few hundred
  // megabytes of decoded texture and skinned geometry.
  const page = await browser.newPage();
  await page.goto(`${origin}__blank`);
  await page.addScriptTag({ content: readFileSync(join(root, 'dist/merge-deps.js'), 'utf8') });

  const result = await page.evaluate(async ({ inputs, riseFor }) => {
  const { GLTFLoader, GLTFExporter, THREE } = globalThis.__mergeDeps;
  const loader = new GLTFLoader();

  /*
   * One file at a time. Only the first file's scene is kept — every export
   * carries the same mesh — and each of the others is reduced to its clips and
   * then dropped, so peak memory is one character rather than eleven.
   */
  let scene = null;
  const clips = [];
  const report = [];

  for (const input of inputs) {
    const response = await fetch(input.url);
    if (!response.ok) throw new Error(`${response.status} fetching ${input.url}`);
    const gltf = await loader.parseAsync(await response.arrayBuffer(), '');
    if (!scene) scene = gltf.scene;

    for (const clip of gltf.animations) {
      const original = clip.name;
      clip.name = input.state || original.replace(/^Armature\|/, '').replace(/\|baselayer$/, '');

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

  const names = result.report.map((clip) => clip.state);
  const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
  if (duplicates.length) {
    console.error(`\n${character}: two clips share a name: ${[...new Set(duplicates)].join(', ')}`);
    console.error('  A lookup by name returns the first match, so one of them would silently');
    console.error('  never play. Add a rule to NAMING that tells them apart.');
    process.exitCode = 1;
  }

  const out = join(outDir, `${character}-rigged.glb`);
  writeFileSync(out, Buffer.from(result.base64, 'base64'));

  console.log(`\n${character} -> assets/models/${character}-rigged.glb`);
  console.log(`  ${(readFileSync(out).length / 1048576).toFixed(1)} MB, ${result.report.length} clips`);
  console.log(`  rest pose: ${result.size.y.toFixed(3)} tall, feet at y=${result.min.y.toFixed(3)}`);
  console.log(`  textures: ${result.textures.join(', ') || 'none'} (written as WebP)`);
  console.log(`  suggested "scale": ${(1 / result.size.y).toFixed(3)}  (to stand one unit tall)`);
  for (const clip of result.report) {
    console.log(`    ${clip.state.padEnd(10)} ${String(clip.seconds).padStart(6)}s  ` +
      `${clip.rootTracksFlattened} root flattened` +
      `${clip.rise !== 1 ? `, rise x${clip.rise}` : ''}   [${clip.from}]`);
  }

  await page.close();
}

await browser.close();
server.close();
