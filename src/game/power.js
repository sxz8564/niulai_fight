import * as THREE from 'three';
import { createActor } from './actor.js';

/*
 * Rage, and the two different things it buys.
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
 * What it buys depends on who is holding it, and the two are deliberately not
 * the same move with different numbers:
 *
 *   summon      Niulai plants his feet, shouts for his mother, and ten of them
 *               come through the stage in parallel lines, running down every
 *               enemy in a lane. The classic panic button: it costs the whole
 *               meter and a second of standing still, and it answers the one
 *               situation the moveset cannot — being surrounded.
 *
 *   transform   Baola becomes something else for seven seconds. Double damage
 *               out, half damage in, and no pause at all: she keeps playing,
 *               and what she does with the seven seconds is hers. It answers
 *               the opposite problem — a fight she is losing on attrition,
 *               where what she needs is not the screen cleared but a window in
 *               which trading hits is finally in her favour.
 *
 * Both live in the registry rather than here, down to which one a character
 * gets. A character without a `power` block has no meter, no bar and no key.
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
    this.kind = spec.kind || 'summon';
    this.meter = 0;
    this.max = 100;
    this.casts = 0;

    // summon
    this.casting = 0;      // seconds left in the summon pose
    this.released = false; // whether this cast's herd has already been let go
    this.herd = [];

    // transform
    this.remaining = 0;    // seconds left as the other thing
    this.was = null;       // the actor to go back to
    this.wasDamage = 0;
    this.small = 1;        // her own size, as a fraction of the form's

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

  get ready() { return this.meter >= this.max && !this.active; }
  get active() { return this.casting > 0 || this.remaining > 0; }

  /*
   * What the bar shows. While a transformation is running it is not a meter
   * any more, it is a clock — the same bar draining is how the player knows how
   * many of the seven seconds are left without being given a second widget.
   */
  get fraction() {
    if (this.remaining > 0) return this.remaining / (this.spec.seconds || 7);
    return Math.min(1, this.meter / this.max);
  }

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
    this.casts += 1;
    this.shoutNow();
    if (this.kind === 'transform') return this.become(player);

    this.casting = this.spec.cast || 1.0;
    this.released = false;
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
    return true;
  }

  /** A rejected play() is an autoplay policy, not a defect: the game is still
   * perfectly playable in silence, so it must never throw. */
  shoutNow() {
    if (!this.shout) return;
    try { this.shout.currentTime = 0; this.shout.play().catch(() => {}); } catch { /* silent */ }
  }

  /*
   * Becomes the other thing.
   *
   * The swap is of the actor, not the Fighter: health, position, facing, the
   * meter and every rule about hitstun stay exactly where they were, and only
   * the body doing it changes. `root` has to move with `actor` because
   * `Fighter.position` reads through it — a swap that forgot would leave her
   * fighting from wherever she happened to be standing when the model changed.
   */
  become(player) {
    const id = this.spec.into;
    const spec = this.host.specs[id];
    if (!spec) throw new Error(`No form called "${id}" in the registry`);

    const actor = createActor(spec, this.host.gltfs[id]);
    actor.root.position.copy(player.root.position);
    actor.setFacing(player.facing);
    actor.play(player.actor.state);   // carry the pose across, so nothing snaps

    /*
     * Start the new body at exactly her size and let it grow into its own.
     *
     * Swapping straight to full size reads as a glitch rather than a
     * transformation: one frame she is a leopard cub, the next a jaguar warrior
     * a third again as tall, and nothing on screen connects the two. Beginning
     * at the size the old body was standing at means the only thing that
     * changes on the swap frame is the mesh, and the growth that follows is the
     * part the player actually watches.
     */
    const mine = this.host.specs[this.host.playerId];
    this.small = (mine && mine.scale ? mine.scale : 1) / (spec.scale || 1);
    actor.root.scale.setScalar(this.small);

    this.host.scene.remove(player.root);
    this.host.scene.add(actor.root);
    this.was = player.actor;
    player.actor = actor;
    player.root = actor.root;

    this.wasDamage = player.damage;
    player.damage = player.damage * (this.spec.damage || 2);
    player.vulnerability = this.spec.toughness ?? 0.5;
    this.remaining = this.spec.seconds || 7;
    return true;
  }

  /*
   * How big the swapped-in body is right now.
   *
   * Growing and shrinking both happen *inside* the seven seconds rather than
   * around them, so the number on the bar is the number of seconds she is
   * actually stronger for. The way up overshoots a little and settles — a
   * transformation should look like something happening to her, not like a
   * slider being dragged — and the way down is a plain ease, because the end of
   * a super wants no fanfare at all.
   */
  size(left) {
    const total = this.spec.seconds || 7;
    const up = this.spec.grow ?? 0.45;
    const down = this.spec.shrink ?? 0.3;
    const elapsed = total - left;

    let k = 1;
    if (elapsed < up) {
      const t = elapsed / up;
      const c1 = 1.70158;
      k = 1 + (c1 + 1) * (t - 1) ** 3 + c1 * (t - 1) ** 2;   // ease out, past 1
    } else if (left < down) {
      const t = Math.max(0, left / down);
      k = t * t * (3 - 2 * t);
    }
    return this.small + (1 - this.small) * k;
  }

  /** Back to herself, wherever she has got to. */
  revert(player) {
    if (!this.was) { this.remaining = 0; return; }
    const actor = this.was;
    actor.root.position.copy(player.root.position);
    actor.setFacing(player.facing);
    this.host.scene.remove(player.root);
    this.host.scene.add(actor.root);
    player.actor = actor;
    player.root = actor.root;
    player.root.scale.setScalar(1);
    actor.play(player.dead || player.downTimer > 0 ? 'down' : 'idle');

    player.damage = this.wasDamage;
    player.vulnerability = 1;
    this.was = null;
    this.remaining = 0;
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
    if (this.remaining > 0) {
      this.remaining -= dt;
      if (this.remaining > 0) player.root.scale.setScalar(this.size(this.remaining));
      else this.revert(player);
    }

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
    // Before the scene is torn down or a round ends: a form left swapped in
    // would take the original's place in the scene graph with it.
    if (this.was) this.revert(this.host.player);
  }
}
