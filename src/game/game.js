import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { createActor } from './actor.js';
import { Fighter, separate } from './fighter.js';
import { buildStage, clampToBelt, BELT_NEAR, BELT_FAR, STAGE_END } from './stage.js';
import { createInput } from './input.js';

/*
 * Niulai Fight — a belt-scroller in the shape of the Famicom brawlers: walk
 * right, the screen stops, wolves arrive, clear them, the screen lets you on.
 *
 * The gate is the whole structure. Without it a player simply runs past every
 * fight, and with it the level becomes a sequence of small arenas.
 */

const GATES = [
  { x: 10, count: 2 },
  { x: 26, count: 3 },
  { x: 44, count: 3 },
  { x: 62, count: 4 },
  { x: STAGE_END - 6, count: 5 }
];

export class Game {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.assetBase = options.assetBase || 'assets/';
    this.onState = options.onState || (() => {});
    this.enemies = [];
    this.gateIndex = 0;
    this.score = 0;
    this.lives = 3;
    this.over = false;
    this.won = false;
    this.time = 0;
    this.spawnQueue = 0;
    this.spawnTimer = 0;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(2, globalThis.devicePixelRatio || 1));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#cfe3f2');
    this.scene.fog = new THREE.Fog('#cfe3f2', 22, 46);

    /*
     * A near-orthographic long lens. A wide perspective camera makes a
     * belt-scroller read as a corridor going away from you; a long lens keeps
     * the strip flat and side-on, which is what the Famicom games looked like.
     */
    this.camera = new THREE.PerspectiveCamera(24, 16 / 9, 0.1, 120);
    this.camera.position.set(0, 2.5, 9.4);
    this.camera.lookAt(0, 1.0, 0);

    this.input = createInput(options.inputTarget || globalThis.window);
  }

  async load() {
    const loader = new GLTFLoader();

    /*
     * One retry per asset. Everything here is local — bundled in the
     * extension, or served off disk — so a failure is a transient rather than
     * a missing file, and the cost of not retrying is a game that starts with
     * an invisible character. Failing on the second attempt still throws,
     * because a file that is genuinely absent should be loud.
     */
    const twice = async (attempt) => {
      try { return await attempt(); }
      catch { return await attempt(); }
    };

    const registry = await twice(() =>
      fetch(`${this.assetBase}models/index.json`).then((r) => r.json()));
    this.specs = Object.fromEntries(registry.map((s) => [s.id, s]));

    const gltfs = await Promise.all(registry.map(async (spec) =>
      [spec.id, await twice(() => loader.loadAsync(`${this.assetBase}models/${spec.file}`))]));
    this.gltfs = Object.fromEntries(gltfs);

    const backdrop = await new THREE.TextureLoader()
      .loadAsync(`${this.assetBase}scenes/orchard-day.webp`).catch(() => null);

    this.lights();
    buildStage(this.scene, { backdrop });

    this.player = this.spawnFighter('niulai', { x: 0, z: 0.2 }, {
      health: 100, speed: 4.1, damage: 12, team: 'player'
    });
    this.onState(this.snapshot());
    return this;
  }

  lights() {
    this.scene.add(new THREE.HemisphereLight('#dfefff', '#5a6b3a', 1.05));
    const sun = new THREE.DirectionalLight('#fff4dd', 1.5);
    sun.position.set(6, 12, 8);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    const s = 14;
    sun.shadow.camera.left = -s; sun.shadow.camera.right = s;
    sun.shadow.camera.top = s; sun.shadow.camera.bottom = -s;
    this.sun = sun;
    this.scene.add(sun);
    this.scene.add(sun.target);
  }

  spawnFighter(id, at, stats) {
    const spec = this.specs[id];
    const actor = createActor(spec, this.gltfs[id]);
    actor.root.position.set(at.x, 0, at.z);
    this.scene.add(actor.root);
    const fighter = new Fighter(actor, {
      ...stats, facing: stats.facing ?? 1, timings: spec.timings
    });
    actor.setFacing(fighter.facing);
    return fighter;
  }

  get gate() { return GATES[this.gateIndex] || null; }

  /** The furthest right the camera — and so the player — may currently go. */
  get boundary() {
    return this.gate ? this.gate.x : STAGE_END;
  }

  update(dt) {
    dt = Math.min(dt, 1 / 20);   // a long stall must not teleport anyone
    this.time += dt;
    if (this.over) return;

    this.drivePlayer(dt);
    this.driveSpawns(dt);
    for (const enemy of this.enemies) this.driveEnemy(enemy, dt);

    this.player.update(dt);
    for (const enemy of this.enemies) enemy.update(dt);

    this.resolveHits();
    this.collide();
    this.cull();
    this.advanceGate();
    this.moveCamera(dt);
    this.input.endFrame();
  }

  drivePlayer(dt) {
    const p = this.player;

    /*
     * Buffer the attack button before doing anything else, including while the
     * player is being hit. Without this, a press during hitstun or during the
     * tail of your own last swing is thrown away, and the game feels like it
     * is ignoring you at exactly the moment you are pressing hardest. Every
     * brawler worth playing buffers a few frames; this holds a press for a
     * quarter of a second and spends it the instant the player can act.
     */
    if (this.input.consume('punch')) this.buffered = { kind: 'punch', life: 0.25 };
    else if (this.input.consume('kick')) this.buffered = { kind: 'kick', life: 0.25 };
    if (this.buffered) {
      this.buffered.life -= dt;
      if (this.buffered.life <= 0) this.buffered = null;
    }

    if (p.dead) {
      if (p.downTimer <= 0) this.loseLife();
      return;
    }
    if (!p.canAct) { p.blocking = false; return; }

    /*
     * Blocking is held, and it costs you everything else: no moving, no
     * swinging. Without that price a player would simply hold it all the time,
     * and a defence with no downside is not a decision.
     */
    p.blocking = this.input.holding('block');
    if (p.blocking) {
      this.buffered = null;
      p.velocity.set(0, 0, 0);
      return;
    }

    if (this.buffered) {
      const kind = this.buffered.kind;
      this.buffered = null;
      p.attack(kind);
      return;
    }

    const axis = this.input.axis();
    p.velocity.set(axis.x * p.speed, 0, axis.z * p.speed * 0.72);
    if (axis.x !== 0) p.facing = axis.x > 0 ? 1 : -1;

    // The gate is a wall the player cannot walk through while wolves are up.
    const limit = this.boundary;
    if (p.position.x + p.velocity.x * dt > limit) {
      p.position.x = Math.min(p.position.x, limit);
      if (p.velocity.x > 0) p.velocity.x = 0;
    }
  }

  driveSpawns(dt) {
    if (this.spawnQueue <= 0) return;
    this.spawnTimer -= dt;
    if (this.spawnTimer > 0) return;
    this.spawnTimer = 0.45;
    this.spawnQueue -= 1;

    // Wolves come in from whichever side has room, just off-camera.
    const fromRight = this.enemies.length % 2 === 0 || this.player.position.x < 4;
    const x = this.player.position.x + (fromRight ? 9 : -9);
    const z = BELT_FAR + Math.random() * (BELT_NEAR - BELT_FAR);
    const enemy = this.spawnFighter('wolfwolf', { x, z }, {
      health: 34, speed: 2.5, damage: 8, team: 'enemy', facing: fromRight ? -1 : 1
    });
    enemy.thinkTimer = Math.random() * 0.5;
    this.enemies.push(enemy);
  }

  driveEnemy(enemy, dt) {
    if (enemy.dead || !enemy.canAct) return;
    const p = this.player;
    const dx = p.position.x - enemy.position.x;
    const dz = p.position.z - enemy.position.z;
    enemy.facing = dx >= 0 ? 1 : -1;

    enemy.thinkTimer -= dt;

    /*
     * Wolves close to just outside arm's reach, line up in Z, then swing. The
     * stand-off distance is what stops four of them piling onto the same pixel
     * and killing the player instantly.
     */
    const want = 0.72;
    const near = Math.abs(dx) < want + 0.2 && Math.abs(dz) < 0.4;

    if (near && enemy.thinkTimer <= 0) {
      enemy.attack('punch');
      enemy.thinkTimer = 0.8 + Math.random() * 0.9;
      enemy.velocity.set(0, 0, 0);
      return;
    }

    const towards = Math.sign(dx) * (Math.abs(dx) > want ? 1 : -0.4);
    enemy.velocity.set(towards * enemy.speed, 0, Math.sign(dz) * Math.min(1, Math.abs(dz) * 3) * enemy.speed * 0.6);
  }

  resolveHits() {
    if (this.player.striking) {
      for (const enemy of this.enemies) {
        if (enemy.dead) continue;
        if (this.player.inRange(enemy)) {
          enemy.takeHit(this.player.damage, this.player.facing);
          this.player.hasLanded = true;
          this.score += 100;
          break;    // one target per swing, like the originals
        }
      }
    }
    for (const enemy of this.enemies) {
      if (enemy.striking && enemy.inRange(this.player)) {
        if (this.player.takeHit(enemy.damage, enemy.facing)) enemy.hasLanded = true;
      }
    }
  }

  collide() {
    for (let i = 0; i < this.enemies.length; i++) {
      separate(this.player, this.enemies[i]);
      for (let j = i + 1; j < this.enemies.length; j++) separate(this.enemies[i], this.enemies[j]);
    }
    clampToBelt(this.player.position);
    for (const enemy of this.enemies) clampToBelt(enemy.position);

    /*
     * The gate has to hold against everything, not just walking into it.
     * drivePlayer stops the player steering past the boundary, but a shove
     * from a wolf and the knockback from a hit both move the player
     * afterwards and neither goes through that check — so the player could be
     * pushed through the one wall the whole level structure depends on.
     * Clamping here, after everything that can move anyone, is the only place
     * that holds.
     */
    if (this.player.position.x > this.boundary) {
      this.player.position.x = this.boundary;
      if (this.player.velocity.x > 0) this.player.velocity.x = 0;
    }
  }

  cull() {
    const gone = this.enemies.filter((e) => e.dead);
    if (!gone.length) return;
    for (const enemy of gone) {
      this.scene.remove(enemy.root);
      this.score += 400;
    }
    this.enemies = this.enemies.filter((e) => !e.dead);
    this.onState(this.snapshot());
  }

  advanceGate() {
    const gate = this.gate;
    if (!gate) return;
    const reached = this.player.position.x > gate.x - 6;
    if (reached && !gate.opened && this.spawnQueue === 0 && this.enemies.length === 0) {
      gate.opened = true;
      this.spawnQueue = gate.count;
      this.spawnTimer = 0.2;
      this.onState(this.snapshot());
      return;
    }
    if (gate.opened && this.spawnQueue === 0 && this.enemies.length === 0) {
      this.gateIndex += 1;
      if (this.gateIndex >= GATES.length) {
        this.over = true;
        this.won = true;
      }
      this.onState(this.snapshot());
    }
  }

  loseLife() {
    this.lives -= 1;
    if (this.lives <= 0) {
      this.over = true;
      this.won = false;
      this.onState(this.snapshot());
      return;
    }
    // Back on your feet where you fell, with a moment of grace.
    this.player.health = this.player.maxHealth;
    this.player.dead = false;
    this.player.downTimer = 0;
    this.player.stunTimer = 0;
    this.player.invulnerable = 1.6;
    this.player.actor.play('idle');
    this.onState(this.snapshot());
  }

  moveCamera(dt) {
    // The camera trails the player but never shows behind the gate, so the
    // wall the player runs into is a wall the picture agrees with.
    const target = Math.max(0, Math.min(this.player.position.x, this.boundary - 2.2));
    this.camera.position.x += (target - this.camera.position.x) * Math.min(1, dt * 3.2);
    this.camera.lookAt(this.camera.position.x + 0.6, 1.0, 0);
    this.sun.position.set(this.camera.position.x + 6, 12, 8);
    this.sun.target.position.set(this.camera.position.x, 0, 0);
  }

  snapshot() {
    return {
      health: this.player ? this.player.health : 0,
      maxHealth: this.player ? this.player.maxHealth : 100,
      lives: this.lives,
      score: this.score,
      enemies: this.enemies.length,
      stage: this.gateIndex + 1,
      stages: GATES.length,
      over: this.over,
      won: this.won,
      x: this.player ? this.player.position.x : 0
    };
  }

  resize(width, height) {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}
