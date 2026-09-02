import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { createActor } from './actor.js';
import { Fighter, separate } from './fighter.js';
import { Boss } from './boss.js';
import { Power } from './power.js';
import { soundBank } from './sound.js';
import { buildStage, clampToBelt, BELT_NEAR, BELT_FAR, STAGE_END } from './stage.js';
import { createInput } from './input.js';

/*
 * Niulai Fight — a belt-scroller in the shape of the Famicom brawlers: walk
 * right, the screen stops, wolves arrive, clear them, the screen lets you on.
 *
 * The gate is the whole structure. Without it a player simply runs past every
 * fight, and with it the level becomes a sequence of small arenas.
 */

/*
 * The level. Copied per game rather than used directly: `opened` is written to
 * as a wave is triggered, and a shared array would hand the next run a level
 * whose gates were all open already — every fight skipped.
 */
const GATES = [
  { x: 10, count: 2 },
  { x: 26, count: 3 },
  { x: 44, count: 3 },
  { x: 62, count: 4 },
  // The last gate is the Cart, with two wolves to keep the player honest while
  // they are trying to watch it. More than two and the boss stops being the
  // thing you are paying attention to.
  { x: STAGE_END - 6, count: 2, boss: 'cart' }
];

export class Game {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.assetBase = options.assetBase || 'assets/';
    this.playerId = options.playerId || 'niulai';
    this.onState = options.onState || (() => {});
    this.enemies = [];
    this.boss = null;
    this.power = null;          // set in load(), if the chosen hero has one
    this.beltNear = BELT_NEAR;
    this.beltFar = BELT_FAR;
    this.gates = GATES.map((gate) => ({ ...gate }));
    this.gateIndex = 0;
    this.score = 0;
    this.lives = 3;
    this.over = false;
    this.won = false;
    this.time = 0;
    this.cheerTime = 0;
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
    this.sounds = soundBank(this.assetBase);

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

    const hero = this.specs[this.playerId];
    if (!hero) throw new Error(`No character called "${this.playerId}" in the registry`);
    // Stats live beside the clips, so a new hero is a registry entry rather
    // than a change here.
    this.player = this.spawnFighter(this.playerId, { x: 0, z: 0.2 }, {
      ...(hero.stats || { health: 100, speed: 4.1, damage: 12 }), team: 'player'
    });
    /*
     * A super is a registry entry, like everything else about a character. A
     * hero with no `power` block gets no meter, no bar and no key — which is
     * the honest way to ship a roster where one fighter's super is finished and
     * the other's is not, rather than a bar that fills and does nothing.
     */
    if (hero.power) this.power = new Power(hero.power, this);
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
      ...(spec.body || {}), ...stats, facing: stats.facing ?? 1, timings: spec.timings,
      onDown: () => this.sounds.play('fall')
    });
    actor.setFacing(fighter.facing);
    return fighter;
  }

  get gate() { return this.gates[this.gateIndex] || null; }

  /** The registry entry for the body the player is currently in, if it is not
   * their own. */
  get form() {
    if (!this.power || this.power.remaining <= 0) return null;
    return this.specs[this.power.spec.into] || null;
  }

  /** The furthest right the camera — and so the player — may currently go. */
  get boundary() {
    return this.gate ? this.gate.x : STAGE_END;
  }

  update(dt) {
    dt = Math.min(dt, 1 / 20);   // a long stall must not teleport anyone
    this.time += dt;
    if (this.over) {
      if (this.won) this.cheer(dt);
      return;
    }

    this.drivePlayer(dt);
    this.driveSpawns(dt);
    // The boss is in `enemies` so that the gate counts it, but it is not driven
    // by the wolf brain — that would have it stopping to throw punches it has
    // no animation for, and overwriting the charge every frame.
    for (const enemy of this.enemies) {
      if (this.boss && enemy === this.boss.fighter) continue;
      this.driveEnemy(enemy, dt);
    }
    if (this.boss) this.boss.update(dt, this.player);
    if (this.power) this.power.update(dt, this.player, this.enemies);

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

    /*
     * Mid-summon he is a statue: feet planted, no steering, no swinging. The
     * second it costs is what the move is paid for with, and letting the player
     * walk out of it would make a screen-clearing attack free.
     */
    if (this.power && this.power.casting > 0) {
      p.velocity.set(0, 0, 0);
      p.blocking = false;
      this.buffered = null;
      return;
    }

    if (!p.canAct) { p.blocking = false; return; }

    if (this.input.consume('power') && this.power) {
      if (this.power.cast(p)) return;
    }

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
          const landed = enemy.takeHit(this.player.damage, this.player.facing);
          this.player.hasLanded = true;
          /*
           * On contact, not on the swing, and only for the player, and only
           * when the hit actually registered. A heavy impact under a punch that
           * missed is a lie, one under a punch the target's invulnerability ate
           * is a smaller lie, and the wolves throwing the same sound back would
           * turn a crowd into noise — the point of these is that the player can
           * hear their own hits land.
           */
          if (landed) this.sounds.play(this.player.attackKind === 'kick' ? 'kick' : 'punch');
          this.score += 100;
          if (this.power) this.power.gain('dealt');
          break;    // one target per swing, like the originals
        }
      }
    }
    for (const enemy of this.enemies) {
      if (enemy.striking && enemy.inRange(this.player)) {
        if (this.player.takeHit(enemy.damage, enemy.facing)) {
          enemy.hasLanded = true;
          if (this.power) this.power.gain('taken');
        }
      }
    }
    // The Cart does not swing at anything; it runs you over. That is contact
    // damage, not a strike, so it is tested by overlap rather than by frames.
    if (this.boss && this.boss.ram(this.player) && this.power) this.power.gain('taken');
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
      if (this.power) this.power.gain('killed');
    }
    if (this.boss && this.boss.fighter.dead) this.boss = null;
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
      if (gate.boss) this.spawnBoss(gate);
      this.onState(this.snapshot());
      return;
    }
    if (gate.opened && this.spawnQueue === 0 && this.enemies.length === 0) {
      this.gateIndex += 1;
      if (this.gateIndex >= this.gates.length) {
        this.over = true;
        this.won = true;
        this.celebrate();
      }
      this.onState(this.snapshot());
    }
  }

  /*
   * Rolls the Cart in from the right of the gate.
   *
   * It is an enemy like any other — it goes in `this.enemies`, so the gate's
   * own "is the field clear" test counts it and the level cannot advance past a
   * boss that is still alive — and the Boss object beside it is only the thing
   * that decides what it does with its turn.
   */
  spawnBoss(gate) {
    const spec = this.specs[gate.boss];
    if (!spec) throw new Error(`No boss called "${gate.boss}" in the registry`);
    const fighter = this.spawnFighter(gate.boss, { x: gate.x + 3.5, z: 0.1 }, {
      ...(spec.stats || {}), team: 'enemy', facing: -1
    });
    this.enemies.push(fighter);
    this.bossSpec = spec;
    this.boss = new Boss(fighter, { min: gate.x - 15, max: gate.x + 4 });
    return this.boss;
  }

  /*
   * The one moment in the game that is not a fight.
   *
   * Everything stops when `over` is set — which, for a loss, is right: the
   * player is on the floor and the run is finished. For a win it left the hero
   * standing perfectly still under a banner congratulating him, which is a
   * strange way to end four minutes of work. So a win hands the frame over to
   * `cheer()` instead of stopping it.
   */
  celebrate() {
    const p = this.player;
    p.velocity.set(0, 0, 0);
    p.attackTimer = 0;
    p.stunTimer = 0;
    p.downTimer = 0;
    p.blocking = false;
    p.pose = null;
    p.facing = 1;
    // Side-on, the ordinary way the game is framed. A backflip seen head-on is
    // a shape that gets smaller and larger again; the whole rotation only reads
    // from the side.
    p.actor.setFacing(1);
    // A character with no celebration keeps its idle rather than freezing in
    // whatever pose the last punch left it in.
    p.actor.play(p.actor.has('win') ? 'win' : 'idle');
    this.cheerTime = 0;
  }

  /** Runs the celebration: the hero, anything still crossing the field, and a
   * camera that comes in to watch rather than staying at fighting distance. */
  cheer(dt) {
    this.cheerTime += dt;
    // Cows already on their way keep going. Winning mid-stampede and having the
    // herd blink out of existence would be a worse ending than either.
    if (this.power) this.power.update(dt, this.player, this.enemies);
    // Re-asserted rather than set once: a summon finishing during the
    // celebration clears the pose it was holding.
    this.player.actor.play(this.player.actor.has('win') ? 'win' : 'idle');
    this.player.actor.update(dt, 0);

    /*
     * Come in and look at him properly. The look-at point is the centre of the
     * picture, so aiming it at the hero's middle rather than at head height is
     * what puts him in the middle of the frame instead of at the bottom of it —
     * and the banner has moved to the top of the screen to leave him the room.
     * High enough to clear the backflip, which takes him well off the ground.
     */
    const close = 6.4;
    this.camera.position.z += (close - this.camera.position.z) * Math.min(1, dt * 1.1);
    this.camera.position.y += (1.95 - this.camera.position.y) * Math.min(1, dt * 1.1);
    this.camera.position.x += (this.player.position.x - this.camera.position.x) * Math.min(1, dt * 1.6);
    this.camera.lookAt(this.player.position.x, 0.78, 0);
    this.sun.position.set(this.camera.position.x + 6, 12, 8);
    this.sun.target.position.set(this.camera.position.x, 0, 0);
    this.input.endFrame();
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
    /*
     * Pull back for the boss. A charge is five and a half units long and the
     * ordinary framing is about seven wide, so at the normal distance the Cart
     * would spend most of its attack off the side of the screen — the player
     * would see it leave and see it arrive and never see it coming. Easing
     * rather than cutting, because a hard jump reads as a bug.
     */
    const back = this.boss ? 13.6 : 9.4;
    this.camera.position.z += (back - this.camera.position.z) * Math.min(1, dt * 2.2);

    /*
     * The camera trails the player but never shows behind the gate, so the wall
     * the player runs into is a wall the picture agrees with.
     *
     * With a boss it frames both of them instead — the midpoint, not the
     * player. Trailing the player put the Cart at the very edge of the picture
     * at exactly the moment it rears back to charge, which is the one moment
     * the whole fight depends on being able to see. The player is still kept
     * within half a screen of the centre, so backing away from the boss can
     * never walk them out of their own shot.
     */
    let target = this.player.position.x;
    if (this.boss) {
      const mid = (this.player.position.x + this.boss.fighter.position.x) / 2;
      target = Math.max(target - 3.2, Math.min(target + 3.2, mid));
    }
    const lead = this.boss ? 2.0 : 2.2;
    target = Math.max(0, Math.min(target, this.boundary - lead));
    this.camera.position.x += (target - this.camera.position.x) * Math.min(1, dt * 3.2);
    this.camera.lookAt(this.camera.position.x + 0.6, 1.0, 0);
    this.sun.position.set(this.camera.position.x + 6, 12, 8);
    this.sun.target.position.set(this.camera.position.x, 0, 0);
  }

  snapshot() {
    return {
      player: this.playerId,
      // While a form is swapped in, the HUD names the thing on screen rather
      // than the character who chose it — the seven seconds are the point.
      playerName: this.form ? this.form.name : (this.specs ? this.specs[this.playerId].name : this.playerId),
      playerNameChinese: this.form
        ? (this.form.nameChinese || '')
        : (this.specs ? this.specs[this.playerId].nameChinese : ''),
      health: this.player ? this.player.health : 0,
      maxHealth: this.player ? this.player.maxHealth : 100,
      lives: this.lives,
      score: this.score,
      enemies: this.enemies.length,
      // Clamped: clearing the last gate walks the index one past the end, which
      // is how the game knows it is won — but "STAGE 6/5" on the winning screen
      // reads as a bug to everyone who sees it.
      stage: Math.min(this.gateIndex + 1, this.gates.length),
      stages: this.gates.length,
      over: this.over,
      won: this.won,
      cheering: this.over && this.won,
      rage: this.power ? {
        name: this.power.spec.name,
        nameChinese: this.power.spec.nameChinese || '',
        fraction: this.power.fraction,
        ready: this.power.ready,
        casting: this.power.casting > 0,
        // A running transformation turns the bar into a clock, so the HUD needs
        // to know which of the two it is drawing.
        active: this.power.remaining > 0,
        seconds: this.power.remaining
      } : null,
      boss: this.boss && !this.boss.fighter.dead ? {
        name: this.bossSpec.name,
        nameChinese: this.bossSpec.nameChinese || '',
        health: this.boss.fighter.health,
        maxHealth: this.boss.fighter.maxHealth,
        phase: this.boss.phase
      } : null,
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

  /**
   * Releases the renderer and the input listeners. A browser allows only a
   * handful of WebGL contexts at once, so a game that is finished with has to
   * give its one back or a few restarts will exhaust them.
   */
  dispose() {
    if (this.power) this.power.clear();
    this.input.dispose();
    this.scene.traverse((node) => {
      if (node.geometry) node.geometry.dispose();
      for (const material of [].concat(node.material || [])) {
        for (const key of Object.keys(material)) {
          const value = material[key];
          if (value && value.isTexture) value.dispose();
        }
        material.dispose();
      }
    });
    this.renderer.dispose();
  }
}
