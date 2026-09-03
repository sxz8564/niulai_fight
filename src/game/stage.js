import * as THREE from 'three';

/*
 * The ground the fight happens on, and everything decorating it.
 *
 * A belt-scroller is 3D but not free: the fighters live on a strip of ground —
 * the "belt" — bounded in Z, and the camera travels along X. BELT_NEAR and
 * BELT_FAR are the edges of that strip and every actor is clamped to them.
 */

export const BELT_NEAR = 1.6;   // toward the camera
export const BELT_FAR = -1.4;   // away from it
export const STAGE_START = -4;  // where the level begins
export const STAGE_END = 86;    // where the level stops

const TREE_COLORS = ['#3f6d3a', '#4b7a3f', '#356034', '#5b8a45'];

function tree(rng, x, z, kind) {
  const group = new THREE.Group();
  const trunkH = 1.2 + rng() * 1.6;
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.09, 0.14, trunkH, 7),
    new THREE.MeshStandardMaterial({ color: '#6b4a2f', roughness: 1 }));
  trunk.position.y = trunkH / 2;
  trunk.castShadow = true;
  group.add(trunk);

  const colour = TREE_COLORS[Math.floor(rng() * TREE_COLORS.length)];
  const material = new THREE.MeshStandardMaterial({ color: colour, roughness: 1 });
  if (kind === 'pine') {
    for (let i = 0; i < 3; i++) {
      const r = 0.85 - i * 0.2;
      const cone = new THREE.Mesh(new THREE.ConeGeometry(r, 1.0, 8), material);
      cone.position.y = trunkH + i * 0.5;
      cone.castShadow = true;
      group.add(cone);
    }
  } else {
    const blob = new THREE.Mesh(new THREE.IcosahedronGeometry(0.85 + rng() * 0.35, 1), material);
    blob.position.y = trunkH + 0.5;
    blob.scale.y = 0.8;
    blob.castShadow = true;
    group.add(blob);
  }
  group.position.set(x, 0, z);
  return group;
}

/** Deterministic noise, so the same level looks the same every run. */
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function buildStage(scene, textures) {
  const rng = seeded(20260901);

  // Ground: grass strip the fight happens on, with darker earth behind it so
  // the playable belt reads as a distinct band rather than an endless field.
  const grass = new THREE.Mesh(
    new THREE.PlaneGeometry(STAGE_END + 40, 44),
    new THREE.MeshStandardMaterial({ color: '#6f8f4a', roughness: 1 }));
  grass.rotation.x = -Math.PI / 2;
  grass.position.set(STAGE_END / 2 - 6, 0, -6);
  grass.receiveShadow = true;
  scene.add(grass);

  const path = new THREE.Mesh(
    new THREE.PlaneGeometry(STAGE_END + 40, BELT_NEAR - BELT_FAR + 0.6),
    new THREE.MeshStandardMaterial({ color: '#87a05a', roughness: 1 }));
  path.rotation.x = -Math.PI / 2;
  path.position.set(STAGE_END / 2 - 6, 0.01, (BELT_NEAR + BELT_FAR) / 2);
  path.receiveShadow = true;
  scene.add(path);

  // Trees, thinned out inside the belt so they never stand where a fight is.
  const trees = new THREE.Group();
  for (let x = -8; x < STAGE_END + 16; x += 1.6 + rng() * 1.8) {
    trees.add(tree(rng, x + rng() * 0.8, BELT_FAR - 1.2 - rng() * 7, rng() < 0.5 ? 'pine' : 'round'));
  }
  // Low bushes on the near side: depth in front of the action without
  // standing in front of it.
  const bushMat = new THREE.MeshStandardMaterial({ color: '#4d7038', roughness: 1 });
  for (let x = -8; x < STAGE_END + 16; x += 2.4 + rng() * 3.4) {
    const bush = new THREE.Mesh(new THREE.IcosahedronGeometry(0.26 + rng() * 0.22, 0), bushMat);
    bush.position.set(x, 0.2, BELT_NEAR + 0.9 + rng() * 2.6);
    bush.scale.y = 0.7;
    bush.castShadow = true;
    trees.add(bush);
  }
  scene.add(trees);

  // Grass tufts on the belt itself, low enough to run through.
  const tuftGeo = new THREE.ConeGeometry(0.09, 0.28, 4);
  const tuftMat = new THREE.MeshStandardMaterial({ color: '#5f7f3c', roughness: 1 });
  const tufts = new THREE.InstancedMesh(tuftGeo, tuftMat, 420);
  const m = new THREE.Matrix4();
  for (let i = 0; i < 420; i++) {
    m.makeTranslation(-6 + rng() * (STAGE_END + 20), 0.14,
      BELT_FAR - 1 + rng() * (BELT_NEAR - BELT_FAR + 2.4));
    tufts.setMatrixAt(i, m);
  }
  tufts.instanceMatrix.needsUpdate = true;
  scene.add(tufts);

  /*
   * The painted backdrop, on a plane far behind everything. It is one of the
   * scenes the filter ships, which keeps the two products looking related and
   * costs nothing to draw.
   */
  if (textures.backdrop) {
    textures.backdrop.colorSpace = THREE.SRGBColorSpace;
    textures.backdrop.wrapS = THREE.RepeatWrapping;
    textures.backdrop.repeat.set(6, 1);
    const sky = new THREE.Mesh(
      new THREE.PlaneGeometry(STAGE_END + 80, 22),
      new THREE.MeshBasicMaterial({ map: textures.backdrop, depthWrite: false }));
    sky.position.set(STAGE_END / 2 - 6, 8, -18);
    scene.add(sky);
  }

  return { trees, tufts };
}

/** Keeps an actor on the belt and inside the level. */
export function clampToBelt(position) {
  position.z = Math.min(BELT_NEAR, Math.max(BELT_FAR, position.z));
  position.x = Math.max(STAGE_START, Math.min(STAGE_END, position.x));
}
