import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';

/*
 * An actor is a head plus a body.
 *
 * The heads are the real character models from Critter Cam — they are heads and
 * nothing else, because that is what a face filter needs. A brawler needs
 * something to throw a punch with, so until a rigged full-body model exists the
 * body is built here out of primitives and animated procedurally.
 *
 * That is a placeholder, but it is a deliberate one: everything the rest of the
 * game asks of an actor goes through `play()` and `update()`, so a real rigged
 * model with animation clips drops in behind the same two calls. Set
 * `animated: true` in assets/models/index.json, name the clips, and nothing
 * outside this file needs to know which kind it got.
 */

/** The states the game asks for. A rigged model needs a clip for each. */
export const STATES = ['idle', 'walk', 'punch', 'kick', 'hit', 'down', 'block'];

const UNIT = 1.0;            // one world unit is roughly one character height
const HEAD_HEIGHT = 0.42;    // how much of that height the head takes up

/**
 * Builds a body from primitives, sized to sit under a head of the given width.
 * Limbs hang off pivot groups so a rotation swings them from the shoulder or
 * hip rather than about their own centre.
 */
function buildPlaceholderBody(spec) {
  const body = new THREE.Color(spec.bodyColor || '#b45309');
  const limb = new THREE.Color(spec.limbColor || '#92400e');
  const skin = (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.85, metalness: 0.0 });

  const group = new THREE.Group();
  const parts = {};

  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.24, 4, 12), skin(body));
  torso.position.y = 0.40;
  torso.castShadow = true;
  group.add(torso);
  parts.torso = torso;

  // Arms and legs are each a pivot at the joint with the limb hanging below,
  // so `pivot.rotation.x` reads as "swing forward" everywhere below.
  function makeLimb(length, radius, x, y, material) {
    const pivot = new THREE.Group();
    pivot.position.set(x, y, 0);
    const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(radius, length, 4, 8), material);
    mesh.position.y = -length / 2 - radius * 0.5;
    mesh.castShadow = true;
    pivot.add(mesh);
    group.add(pivot);
    return pivot;
  }

  parts.armL = makeLimb(0.22, 0.058, 0.20, 0.52, skin(limb));
  parts.armR = makeLimb(0.22, 0.058, -0.20, 0.52, skin(limb));
  parts.legL = makeLimb(0.26, 0.070, 0.09, 0.28, skin(limb));
  parts.legR = makeLimb(0.26, 0.070, -0.09, 0.28, skin(limb));

  return { group, parts };
}

/** Where the head sits, so a model swap does not move the character's eyeline. */
function mountHead(scene3d, spec) {
  const holder = new THREE.Group();
  holder.position.y = 0.62 + (spec.headOffsetY || 0);

  const head = scene3d.clone(true);
  // The head models are authored about one unit wide facing +Z, which is the
  // same convention the filter used, so they need only scaling to fit.
  const box = new THREE.Box3().setFromObject(head);
  const size = new THREE.Vector3();
  box.getSize(size);
  const scale = (HEAD_HEIGHT / Math.max(size.y, 1e-4)) * (spec.headScale || 1);
  head.scale.setScalar(scale);

  // Re-centre on the head's own middle, so a model whose origin sits at the
  // neck and one whose origin sits at the crown both land in the same place.
  const centre = new THREE.Vector3();
  box.getCenter(centre);
  head.position.set(-centre.x * scale, -centre.y * scale + HEAD_HEIGHT * 0.18, -centre.z * scale);

  head.traverse((node) => { if (node.isMesh) node.castShadow = true; });
  holder.add(head);
  return { holder, head };
}

export function createActor(spec, gltf) {
  const root = new THREE.Group();
  root.name = spec.id;

  const facing = new THREE.Group();   // yaw only; the game flips this to turn
  root.add(facing);

  /*
   * Only the placeholder path needs a head mounted on a built body. This used
   * to run for every character, which meant a rigged model had its entire
   * skinned mesh deep-cloned and scaled on load for a holder that was then
   * never added to the scene — invisible, but paid for in memory every time.
   */
  let holder = null;
  let head = null;

  let mixer = null;
  let actions = null;
  let parts = null;
  let missing = [];

  if (spec.animated && gltf.animations && gltf.animations.length) {
    /*
     * A rigged model brings its own body and its own motion — but a clip as
     * exported is rarely the clip a game wants. These arrive as complete
     * performances: the punch is four seconds of standing in a guard stance
     * with about half a second of punch in the middle of it. So each state
     * names a clip and, optionally, the slice of it worth playing.
     */
    /*
     * Every actor gets its own copy of the model.
     *
     * Handing out `gltf.scene` itself looks like it works right up until a
     * second character of the same kind spawns: a three.js object has one
     * parent, so adding the shared model to the new actor takes it out of the
     * old one. The first wolf becomes an empty group — invisible, but still a
     * Fighter with a position, so it still blocks the player and still throws
     * punches. A phantom.
     *
     * SkeletonUtils.clone rather than Object3D.clone: a plain clone copies the
     * skinned meshes but leaves them bound to the original's skeleton, so
     * every copy would animate identically to whichever one moved last.
     */
    const model = cloneSkinned(gltf.scene);
    if (spec.scale) model.scale.setScalar(spec.scale);
    // Without this the rigged character is the one thing on the field with no
    // shadow, which reads as floating even when it is standing on the ground.
    model.traverse((node) => {
      if (node.isMesh || node.isSkinnedMesh) { node.castShadow = true; node.frustumCulled = false; }
    });
    facing.add(model);
    mixer = new THREE.AnimationMixer(model);
    actions = {};
    missing = [];

    for (const state of STATES) {
      const entry = (spec.clips && spec.clips[state]) || state;
      const config = typeof entry === 'string' ? { clip: entry } : entry;
      const source = THREE.AnimationClip.findByName(gltf.animations, config.clip || state);
      if (!source) { missing.push(state); continue; }

      let clip = source;
      if (config.from != null || config.to != null) {
        // subclip counts in frames, so the seconds a human reads off a contact
        // sheet are converted here rather than in the registry.
        const fps = config.fps || 30;
        const from = Math.round((config.from || 0) * fps);
        const to = Math.round((config.to != null ? config.to : source.duration) * fps);
        clip = THREE.AnimationUtils.subclip(source.clone(), `${state}`, from, to, fps);
      }

      const action = mixer.clipAction(clip);
      const loops = config.loop != null ? config.loop : (state === 'idle' || state === 'walk');
      action.setLoop(loops ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
      // A one-shot has to hold its last frame, or the character snaps back to
      // the bind pose for a frame between the punch and the idle.
      action.clampWhenFinished = !loops;

      /*
       * The clip is fitted to the game's timing rather than the other way
       * round. A punch that the rules give a quarter of a second and an
       * animation that takes one will disagree about when contact happens, and
       * the disagreement shows up as a hit that lands before the fist arrives.
       * Deriving the speed from both numbers means they cannot drift apart.
       */
      const wanted = (spec.timings || {})[state];
      if (wanted && clip.duration > 0) action.setEffectiveTimeScale(clip.duration / wanted);
      else if (config.speed) action.setEffectiveTimeScale(config.speed);

      // Locomotion is the exception: its speed is not fixed, it follows how
      // fast the character is actually travelling, or the feet skate.
      if (state === 'walk') action.userData = { gait: config.gait || 1 };

      actions[state] = action;
    }

    // A state with no clip falls back to one that exists, so a half-delivered
    // character animates rather than freezing in its bind pose.
    for (const [state, fallback] of Object.entries(spec.fallbacks || {})) {
      if (!actions[state] && actions[fallback]) actions[state] = actions[fallback];
    }
  } else {
    const mounted = mountHead(gltf.scene, spec);
    holder = mounted.holder;
    head = mounted.head;
    const built = buildPlaceholderBody(spec);
    parts = built.parts;
    facing.add(built.group);
    facing.add(holder);
  }

  let state = 'idle';
  let stateTime = 0;
  let phase = 0;      // walk-cycle phase, kept across states so gait is continuous

  return {
    root,
    facing,
    head,
    get state() { return state; },

    /**
     * Faces +1 (right) or -1 (left).
     *
     * Both the heads and the rigged biped are authored facing +Z, which is
     * straight at the camera. Turning them a quarter turn puts them side-on,
     * facing along the belt they walk down — which is the whole point of the
     * genre: you have to be able to see which way a character is about to
     * swing, and a character facing the camera is facing nowhere.
     */
    setFacing(dir) {
      facing.rotation.y = dir >= 0 ? Math.PI / 2 : -Math.PI / 2;
    },

    play(next) {
      if (next === state) return;
      if (actions) {
        const from = actions[state];
        const to = actions[next];
        if (to) {
          const previous = from && from !== to ? from : null;
          if (previous) previous.fadeOut(0.10);
          to.reset().setEffectiveWeight(1).fadeIn(0.10).play();
        }
      }
      state = next;
      stateTime = 0;
    },

    /** States the model had no clip for — reported so a gap is visible. */
    get missingClips() { return missing; },

    /**
     * @param {number} dt seconds
     * @param {number} speed 0..1, how fast the actor is travelling — drives the
     *   gait so a character that is barely moving does not sprint on the spot.
     */
    update(dt, speed = 0) {
      stateTime += dt;
      if (mixer) {
        /*
         * Tie the gait to the ground speed. A walk cycle played at a fixed
         * rate while the character moves at a different one is the classic
         * skating look, and it is the first thing anyone notices.
         */
        const gait = actions && actions.walk;
        if (gait && state === 'walk') {
          const base = (gait.userData && gait.userData.gait) || 1;
          gait.setEffectiveTimeScale(base * Math.max(0.35, speed));
        }
        mixer.update(dt);
        return;
      }
      if (!parts) return;

      phase += dt * (4 + speed * 6);

      const { armL, armR, legL, legR, torso } = { ...parts, torso: parts.torso };
      if (!holder) return;
      const reset = () => {
        armL.rotation.set(0, 0, 0); armR.rotation.set(0, 0, 0);
        legL.rotation.set(0, 0, 0); legR.rotation.set(0, 0, 0);
        holder.rotation.set(0, 0, 0);
        torso.rotation.set(0, 0, 0);
        holder.position.y = 0.62 + (spec.headOffsetY || 0);
      };
      reset();

      switch (state) {
        case 'walk': {
          const swing = Math.sin(phase) * (0.35 + speed * 0.35);
          legL.rotation.x = swing;
          legR.rotation.x = -swing;
          armL.rotation.x = -swing * 0.7;
          armR.rotation.x = swing * 0.7;
          holder.position.y += Math.abs(Math.sin(phase)) * 0.02;
          break;
        }
        case 'punch': {
          // Out fast, back slow: a punch that returns at the speed it left
          // reads as a wave.
          const t = Math.min(1, stateTime / 0.26);
          const reach = t < 0.35 ? t / 0.35 : 1 - (t - 0.35) / 0.65;
          armR.rotation.x = -1.5 * reach;
          torso.rotation.y = -0.35 * reach;
          holder.rotation.y = -0.2 * reach;
          break;
        }
        case 'kick': {
          const t = Math.min(1, stateTime / 0.34);
          const reach = t < 0.4 ? t / 0.4 : 1 - (t - 0.4) / 0.6;
          legR.rotation.x = -1.6 * reach;
          torso.rotation.x = 0.25 * reach;
          armL.rotation.x = 0.6 * reach;
          break;
        }
        case 'hit': {
          const t = Math.min(1, stateTime / 0.22);
          const recoil = Math.sin(t * Math.PI);
          torso.rotation.x = -0.4 * recoil;
          holder.rotation.x = -0.5 * recoil;
          armL.rotation.x = 0.5 * recoil;
          armR.rotation.x = 0.5 * recoil;
          break;
        }
        case 'down': {
          const t = Math.min(1, stateTime / 0.3);
          root.children[0].rotation.z = 0; // facing group keeps its yaw
          torso.rotation.x = -1.35 * t;
          holder.rotation.x = -1.2 * t;
          holder.position.y = 0.62 - 0.34 * t;
          legL.rotation.x = 0.9 * t;
          legR.rotation.x = 0.7 * t;
          break;
        }
        default: {
          // Idle: breathing, and a slow sway so a standing character is not a
          // statue.
          const b = Math.sin(stateTime * 2.2);
          holder.position.y += b * 0.012;
          armL.rotation.x = b * 0.06;
          armR.rotation.x = -b * 0.06;
          torso.rotation.z = Math.sin(stateTime * 1.1) * 0.02;
        }
      }
    }
  };
}

export { UNIT };
