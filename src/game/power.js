import * as THREE from 'three';
import { createActor } from './actor.js';

/*
 * Rage, and what Niulai does with it.
 *
 * A brawler needs a moment where the player stops losing. Three wolves and a
 * Cart on the same screen is a situation the ordinary moveset cannot answer —
 * you can only fight one of them at a time — so the meter is the promise that
 * being surrounded eventually pays for itself.
 *
 * It fills from *both* halves of a fight: landing a hit, and taking one. Only
 * rewarding aggression would punish a player who is already losing, which is
 * exactly who needs the button; only rewarding damage taken would make the
 * super a consolation prize. Both, weighted toward being hit, means a bad
 * exchange is still progress toward a good one.
 *
 * Spending it: Niulai plants his feet, shouts for his mother, and ten of them
 * come through the stage in parallel lines. Every enemy in a lane gets run
 * over. It is the classic panic button — a screen-clearing move that costs the
 * whole meter and leaves you standing still for a second to earn it.
 *
 * The move lives in the registry, not here. A character without a `power` block
 * has no meter, no bar and no key, which is the honest way to ship a roster
 * where one fighter's super is finished and the other's is not.
 */

/*
 * The lanes run a little wider than the belt itself.
 *
 * The belt is three units deep and the camera is a long lens, so five lanes
 * inside it land almost on top of each other on screen and the "parallel lines"
 * read as one clump. Half a unit of overspill on each side spreads them
 * visibly, and costs nothing: everything that can be hit is clamped inside the
 * belt, so the outermost lanes still catch anything standing at its edge.
 */
const LANE_SPILL = 0.45;

export class Power {
  /**
   * @param {object} spec the hero's `power` block from the registry
   * @param {object} host the Game — needs scene, specs, gltfs, assetBase, camera
   */
  constructor(spec, host) {
    this.spec = spec;
    this.host = host;
    this.meter = 0;
    this.max = 100;
    this.casting = 0;      // seconds left in the summon pose
    this.released = false; // whether this cast's herd has already been let go
    this.herd = [];
    this.casts = 0;

    /*
     * The shout, loaded up front. Fetching it at the moment of the cast would
     * put the sound behind a network round trip and land it after the herd,
     * which is worse than silence.
     */
    this.shout = null;
    if (spec.shout && typeof Audio !== 'undefined') {
      try {
        this.shout = new Audio(`${host.assetBase}${spec.shout}`);
        this.shout.preload = 'auto';
      } catch { this.shout = null; }
    }
  }

  get ready() { return this.meter >= this.max && this.casting <= 0; }
  get fraction() { return Math.min(1, this.meter / this.max); }

  /** Rage from something that happened in the fight. */
  gain(what) {
    if (this.casting > 0) return;
    const by = (this.spec.gain || {})[what] || 0;
    this.meter = Math.min(this.max, this.meter + by);
  }

  /**
   * Spends the meter. Returns whether it went off, so a press that could not
   * pay for itself is not silently swallowed by the caller.
   */
  cast(player) {
    if (!this.ready || !player.canAct) return false;
    this.meter = 0;
    this.casting = this.spec.cast || 1.0;
    this.released = false;
    this.casts += 1;
    player.pose = 'summon';
    player.velocity.set(0, 0, 0);
    player.blocking = false;

    /*
     * Untouchable while casting. Without it, a wolf that happens to swing
     * during the second the player is locked in place takes the whole meter
     * away and gives nothing for it, which teaches players never to use the
     * move at the only time it is worth using — when they are surrounded.
     */
    player.invulnerable = Math.max(player.invulnerable, this.casting + 0.1);

    if (this.shout) {
      // A rejected play() is an autoplay policy, not a defect: the game is
      // still perfectly playable in silence, so it must never throw.
      try { this.shout.currentTime = 0; this.shout.play().catch(() => {}); } catch { /* silent */ }
    }
    return true;
  }

  /**
   * Lets the herd go: `count` cows spread over `lanes` parallel lines, in as
   * many ranks as it takes, all of them entering from the left of the picture
   * and leaving to the right of it.
   */
  release() {
    const { host, spec } = this;
    const count = spec.count || 10;
    const lanes = Math.max(1, spec.lanes || 5);
    const near = host.beltNear + LANE_SPILL;
    const far = host.beltFar - LANE_SPILL;
    const left = host.camera.position.x - 10;

    for (let i = 0; i < count; i++) {
      const lane = i % lanes;
      const rank = Math.floor(i / lanes);
      const z = lanes === 1 ? 0 : far + ((near - far) * lane) / (lanes - 1);
      const actor = createActor(host.specs[spec.summon], host.gltfs[spec.summon]);
      // Ranks are spaced far enough apart to read as two waves rather than a
      // wall, and far enough that the second one arrives well after the first
      // one's hit has been counted.
      actor.root.position.set(left - rank * 4.2 - Math.random() * 0.6, 0, z);
      actor.setFacing(1);
      actor.play('walk');

      /*
       * Ten copies of one clip started on the same frame gallop in lockstep,
       * and a herd moving as one rigid body reads as a mistake rather than a
       * stampede. A random offset into the cycle, a little size and a little
       * speed are enough to make them look like ten animals instead of one
       * animal drawn ten times.
       */
      actor.update(Math.random() * 0.6, 1);
      const size = 0.9 + Math.random() * 0.25;
      actor.root.scale.setScalar(size);

      host.scene.add(actor.root);
      this.herd.push({
        actor,
        hit: new Set(),
        speed: 0.92 + Math.random() * 0.16,
        from: actor.root.position.x
      });
    }
  }

  update(dt, player, enemies) {
    if (this.casting > 0) {
      this.casting -= dt;
      const elapsed = (this.spec.cast || 1.0) - this.casting;
      if (!this.released && elapsed >= (this.spec.release || 0.45)) {
        this.released = true;
        this.release();
      }
      if (this.casting <= 0) {
        this.casting = 0;
        player.pose = null;
      }
    }

    if (!this.herd.length) return;
    const speed = this.spec.speed || 15;
    const damage = this.spec.damage || 18;
    const finish = this.host.camera.position.x + 12;
    /*
     * Legs at the speed the legs are actually carrying her.
     *
     * The gallop was authored to look right at `gallopAt`; playing it at full
     * rate while the herd crosses at a quarter of that is the skating look the
     * rest of the game goes out of its way to avoid. The actor floors the gait
     * so nobody freezes mid-stride.
     */
    const gait = speed / (this.spec.gallopAt || 15);

    for (const cow of this.herd) {
      const at = cow.actor.root.position;
      at.x += speed * cow.speed * dt;
      cow.actor.update(dt, gait * cow.speed);

      for (const enemy of enemies) {
        if (enemy.dead || cow.hit.has(enemy)) continue;
        const dx = Math.abs(enemy.position.x - at.x) - (enemy.hurtRadius || 0);
        const dz = Math.abs(enemy.position.z - at.z) - (enemy.hurtDepth || 0);
        if (dx > 0.55 || dz > 0.55) continue;
        cow.hit.add(enemy);
        /*
         * The herd ignores invulnerability frames.
         *
         * Those exist to stop one fast attack registering twice, and for a wolf
         * — narrow enough to stand in a single lane — they change nothing here.
         * They matter for anything wide: the Cart spans several lanes, so three
         * or four cows reach it on the same frame, and the first one's i-frames
         * would swallow the rest. Measured, that is the difference between a
         * super that takes half the boss's health and one that takes a sixth.
         * The move is defined as one hit per cow; frame timing does not get a
         * vote.
         */
        enemy.invulnerable = 0;
        enemy.takeHit(damage, 1);
      }
    }

    /*
     * Retire on distance as well as on leaving the picture.
     *
     * `finish` is measured from the camera, and the camera follows the player.
     * That was safe while the herd outran anyone — but at the speed it crosses
     * at now, a player walking right moves the finish line away faster than the
     * cows advance on it, and a cow that can never reach it never leaves the
     * scene. One more cast, ten more, for ever.
     */
    const range = this.spec.range || 30;
    const spent = (cow) => cow.actor.root.position.x > finish ||
      cow.actor.root.position.x - cow.from > range;
    const gone = this.herd.filter(spent);
    if (gone.length) {
      for (const cow of gone) this.host.scene.remove(cow.actor.root);
      this.herd = this.herd.filter((cow) => !spent(cow));
    }
  }

  /** Clears the field — a round that ends mid-stampede must not leave cows in
   * the scene for the next one. */
  clear() {
    for (const cow of this.herd) this.host.scene.remove(cow.actor.root);
    this.herd = [];
    this.casting = 0;
    this.released = false;
  }
}
