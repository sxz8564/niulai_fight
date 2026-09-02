import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { soundBank } from './game/sound.js';

/*
 * The character select.
 *
 * The portraits are the real models, turning slowly in their own idle pose,
 * rather than pictures of them. Drawn art would be one more thing that can
 * drift from what you actually get when you press the button, and these models
 * are already loaded a moment later anyway.
 */

export async function chooseCharacter(assetBase, root) {
  const sounds = soundBank(assetBase);
  const registry = await fetch(`${assetBase}models/index.json`).then((r) => r.json());
  const heroes = registry.filter((spec) => spec.playable);

  const loader = new GLTFLoader();
  const cards = [];

  return new Promise((resolve) => {
    let settled = false;
    function pick(id) {
      if (settled) return;
      settled = true;
      for (const card of cards) card.stop();
      window.removeEventListener('keydown', onKey);
      resolve(id);
    }

    function onKey(event) {
      const index = Number(event.key) - 1;
      if (heroes[index]) { event.preventDefault(); pick(heroes[index].id); }
      if (event.key === 'Enter' && heroes[0]) pick(heroes[0].id);
    }
    window.addEventListener('keydown', onKey);

    heroes.forEach((spec, index) => {
      const button = document.createElement('button');
      button.type = 'button';

      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 336;   // drawn at 168 CSS px, so 2x
      button.appendChild(canvas);

      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = spec.name;
      button.appendChild(name);

      const zh = document.createElement('div');
      zh.className = 'zh';
      zh.textContent = spec.nameChinese || '';
      button.appendChild(zh);

      const blurb = document.createElement('div');
      blurb.className = 'blurb';
      blurb.textContent = spec.blurb || '';
      button.appendChild(blurb);

      const key = document.createElement('div');
      key.className = 'key';
      key.textContent = `PRESS ${index + 1}`;
      button.appendChild(key);

      button.addEventListener('click', () => pick(spec.id));
      /*
       * A tick as the cursor crosses a card. Pointer movement is not a user
       * gesture as far as autoplay policy is concerned, so the very first one
       * may be swallowed — which is fine, and why nothing here checks.
       */
      button.addEventListener('pointerenter', () => sounds.play('select'));
      button.addEventListener('focus', () => sounds.play('select'));
      root.appendChild(button);

      cards.push(portrait(canvas, loader, assetBase, spec));
    });
  });
}

/** One slowly turning character in a small canvas. */
function portrait(canvas, loader, assetBase, spec) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setSize(canvas.width, canvas.height, false);

  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight('#ffffff', '#404a58', 2.2));
  const key = new THREE.DirectionalLight('#fff3dd', 2.2);
  key.position.set(2, 4, 4);
  scene.add(key);

  const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 50);
  const turntable = new THREE.Group();
  scene.add(turntable);

  let mixer = null;
  let raf = 0;
  let stopped = false;
  const clock = new THREE.Clock();

  loader.loadAsync(`${assetBase}models/${spec.file}`).then((gltf) => {
    if (stopped) return;
    const model = gltf.scene;
    turntable.add(model);

    const box = new THREE.Box3().setFromObject(model);
    const size = new THREE.Vector3(); box.getSize(size);
    const centre = new THREE.Vector3(); box.getCenter(centre);
    model.position.sub(centre);
    // Frame the upper body: at this size a whole figure is a smudge.
    model.position.y -= size.y * 0.12;
    camera.position.set(0, 0, size.y * 1.62);
    camera.lookAt(0, 0, 0);

    // The idle the game uses, so the card shows the stance you will play in.
    const idle = spec.clips && spec.clips.idle;
    const clipName = (idle && idle.clip) || 'idle';
    const source = THREE.AnimationClip.findByName(gltf.animations, clipName);
    if (source) {
      let clip = source;
      if (idle && (idle.from != null || idle.to != null)) {
        const fps = 30;
        clip = THREE.AnimationUtils.subclip(source.clone(), 'idle',
          Math.round((idle.from || 0) * fps),
          Math.round((idle.to != null ? idle.to : source.duration) * fps), fps);
      }
      mixer = new THREE.AnimationMixer(model);
      mixer.clipAction(clip).play();
    }
  }).catch(() => { /* a card without a portrait still selects */ });

  /*
   * A slow sway rather than a full turn. A character select is showing you a
   * face; a turntable spends half its time showing you the back of a head, and
   * whichever card you glance at is as likely as not to be facing away.
   *
   * Small, too. A quarter of a radian was still enough to catch both fighters
   * side-on at once — which is exactly what the store screenshot kept catching,
   * and a portrait nobody can see the face of is not a portrait. This keeps the
   * life in it and never turns far enough to lose the face.
   */
  let elapsed = 0;
  function frame() {
    raf = requestAnimationFrame(frame);
    const dt = clock.getDelta();
    elapsed += dt;
    if (mixer) mixer.update(dt);
    turntable.rotation.y = Math.sin(elapsed * 0.7) * 0.22;
    renderer.render(scene, camera);
  }
  raf = requestAnimationFrame(frame);

  return {
    stop() {
      stopped = true;
      cancelAnimationFrame(raf);
      renderer.dispose();
    }
  };
}
