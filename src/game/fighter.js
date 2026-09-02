import * as THREE from 'three';
import { clampToBelt } from './stage.js';

/*
 * Everything that can be hit. Player and enemy both wrap one of these, so the
 * rules about being knocked back, going down and getting up are written once
 * and cannot drift apart between the two.
 *
 * The belt-scroller convention this follows: an attack lands only if the two
 * fighters are close in X *and* nearly level in Z. Being a metre upstage is a
 * miss, which is what makes stepping up and down the belt worth doing rather
 * than a cosmetic extra axis.
 */

export const REACH_X = 0.95;
export const REACH_Z = 0.55;

/* How long each action takes, unless a character overrides it. The same
 * numbers drive the animation speed in actor.js, so a character with a slower
 * punch animates slower rather than sliding out of sync with itself. */
export const DEFAULT_TIMINGS = { punch: 0.26, kick: 0.34, hit: 0.22, down: 1.1 };

export class Fighter {
  constructor(actor, options) {
    this.actor = actor;
    this.root = actor.root;
    this.maxHealth = options.health;
    this.health = options.health;
    this.speed = options.speed;
    this.damage = options.damage;
    this.facing = options.facing ?? 1;
    this.team = options.team;
    this.timings = { ...DEFAULT_TIMINGS, ...(options.timings || {}) };

    /*
     * Size and weight. A wolf and a two-tonne cart cannot share one number:
     * the cart is wider than a punch's reach, so a hit box measured centre to
     * centre would make it literally unhittable, and a shove that moves a wolf
     * should not move a vehicle at all.
     */
    this.radius = options.radius ?? 0.22;        // half the space it occupies
    this.hurtRadius = options.hurtRadius ?? 0;   // extra reach *onto* it
    this.hurtDepth = options.hurtDepth ?? 0;     // how far across the belt it fills
    this.knockback = options.knockback ?? 1;     // how far a hit shifts it
    this.immovable = options.immovable ?? false; // whether a shove moves it
    this.armored = options.armored ?? false;     // whether a hit interrupts it
    this.vulnerability = 1;                      // damage multiplier, set per phase
    this.pose = null;                            // overrides idle/walk when set

    this.velocity = new THREE.Vector3();
    this.attackTimer = 0;      // >0 while an attack is playing
    this.attackKind = null;
    this.hasLanded = false;    // one hit per swing
    this.stunTimer = 0;
    this.downTimer = 0;
    this.invulnerable = 0;
    this.dead = false;
    this.blocking = false;
  }

  /* What a block is worth. Not immunity: chip damage keeps a turtling player
   * from simply holding the button and waiting the wave out, and the reduced
   * knockback is what makes blocking feel like standing your ground. */
  static BLOCK_DAMAGE = 0.2;
  static BLOCK_KNOCKBACK = 0.35;

  get position() { return this.root.position; }
  get busy() { return this.attackTimer > 0 || this.stunTimer > 0 || this.downTimer > 0; }
  get canAct() { return !this.dead && !this.busy; }

  attack(kind = 'punch') {
    if (!this.canAct) return false;
    this.attackKind = kind;
    this.attackTimer = this.timings[kind] || DEFAULT_TIMINGS.punch;
    this.hasLanded = false;
    this.actor.play(kind);
    return true;
  }

  /** True while the attack is in the frames that can connect. */
  get striking() {
    if (this.attackTimer <= 0 || this.hasLanded) return false;
    const total = this.timings[this.attackKind] || DEFAULT_TIMINGS.punch;
    const elapsed = total - this.attackTimer;
    return elapsed > total * 0.25 && elapsed < total * 0.7;
  }

  /*
   * Reach is measured to the target's edge, not its centre. Everything on the
   * field used to be about the same size, so centre to centre was the same
   * thing; a boss that is three times wider than a wolf is not, and measuring
   * it the old way puts its centre further away than an arm can reach while
   * its bodywork is in the player's face.
   */
  inRange(other) {
    const dx = (other.position.x - this.position.x) * this.facing;
    const dz = Math.abs(other.position.z - this.position.z);
    const edge = other.hurtRadius || 0;
    return dx > 0 && dx < REACH_X + edge && dz < REACH_Z + edge * 0.5;
  }

  takeHit(damage, fromDirection) {
    if (this.dead || this.invulnerable > 0 || this.downTimer > 0) return false;

    /*
     * A block only works against what you are facing. `fromDirection` is the
     * direction the blow travels, so a hit that lands while you face into it
     * is one you are looking at; a hit travelling the same way you face came
     * from behind you, and a raised guard is no use there. That asymmetry is
     * the point — blocking should be a decision about where you are looking,
     * not a button that switches damage off.
     */
    const guarded = this.blocking && fromDirection === -this.facing;
    if (guarded) {
      this.health -= damage * Fighter.BLOCK_DAMAGE;
      this.invulnerable = 0.18;
      this.velocity.x = fromDirection * 3.4 * Fighter.BLOCK_KNOCKBACK;
      if (this.health > 0) return true;   // a blocked hit never knocks down
      this.health = 1;
      return true;
    }

    this.health -= damage * this.vulnerability;
    this.invulnerable = 0.18;
    this.velocity.x = fromDirection * 3.4 * this.knockback;

    if (this.health <= 0) {
      this.health = 0;
      this.downTimer = this.timings.down;
      this.actor.play('down');
      this.velocity.x = fromDirection * 5.0 * this.knockback;
      return true;
    }

    /*
     * Armour: the hit lands and hurts, but does not stop what is already
     * happening. A charging vehicle that a jab could halt would make the whole
     * fight a matter of mashing punch at the right moment, and there would be
     * no reason ever to move. The actor still jolts, so the player can see the
     * damage they are doing.
     */
    if (this.armored) {
      if (this.actor.jolt) this.actor.jolt();
      return true;
    }
    this.stunTimer = this.timings.hit;
    this.actor.play('hit');
    return true;
  }

  update(dt) {
    if (this.invulnerable > 0) this.invulnerable -= dt;

    if (this.downTimer > 0) {
      this.downTimer -= dt;
      // Knockback slides out under friction while down.
      this.velocity.x *= 0.86;
      this.position.x += this.velocity.x * dt;
      if (this.downTimer <= 0) {
        if (this.health <= 0) { this.dead = true; }
        else { this.actor.play('idle'); }
      }
      clampToBelt(this.position);
      this.actor.update(dt, 0);
      return;
    }

    if (this.stunTimer > 0) {
      this.stunTimer -= dt;
      this.velocity.x *= 0.82;
      this.position.x += this.velocity.x * dt;
      if (this.stunTimer <= 0) this.actor.play('idle');
      clampToBelt(this.position);
      this.actor.update(dt, 0);
      return;
    }

    if (this.attackTimer > 0) {
      this.attackTimer -= dt;
      if (this.attackTimer <= 0) this.actor.play('idle');
      this.actor.update(dt, 0);
      return;
    }

    // Free movement, set by whoever drives this fighter.
    const moving = this.velocity.lengthSq() > 1e-4;
    this.position.x += this.velocity.x * dt;
    this.position.z += this.velocity.z * dt;
    clampToBelt(this.position);

    this.actor.setFacing(this.facing);
    this.actor.play(this.pose || (this.blocking ? 'block' : (moving ? 'walk' : 'idle')));
    this.actor.update(dt, Math.min(1, this.velocity.length() / this.speed));
  }
}

/**
 * Stops two fighters standing inside each other.
 *
 * The gap they keep is the sum of their radii, so a big body takes up the room
 * it looks like it takes up. An immovable one absorbs none of the push: walking
 * into a cart moves you, not the cart.
 */
export function separate(a, b, radius) {
  const gap = radius ?? ((a.radius ?? 0.22) + (b.radius ?? 0.22));
  const dx = b.position.x - a.position.x;
  const dz = (b.position.z - a.position.z) * 1.8;   // the belt is shallow
  const d2 = dx * dx + dz * dz;
  if (d2 > gap * gap || d2 < 1e-6) return;
  if (a.immovable && b.immovable) return;
  const d = Math.sqrt(d2);
  const overlap = gap - d;
  const nx = dx / d;
  const share = a.immovable ? 0 : (b.immovable ? 1 : 0.5);
  a.position.x -= nx * overlap * share;
  b.position.x += nx * overlap * (1 - share);
}
