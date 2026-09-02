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

    this.velocity = new THREE.Vector3();
    this.attackTimer = 0;      // >0 while an attack is playing
    this.attackKind = null;
    this.hasLanded = false;    // one hit per swing
    this.stunTimer = 0;
    this.downTimer = 0;
    this.invulnerable = 0;
    this.dead = false;
  }

  get position() { return this.root.position; }
  get busy() { return this.attackTimer > 0 || this.stunTimer > 0 || this.downTimer > 0; }
  get canAct() { return !this.dead && !this.busy; }

  attack(kind = 'punch') {
    if (!this.canAct) return false;
    this.attackKind = kind;
    this.attackTimer = kind === 'kick' ? 0.34 : 0.26;
    this.hasLanded = false;
    this.actor.play(kind);
    return true;
  }

  /** True while the attack is in the frames that can connect. */
  get striking() {
    if (this.attackTimer <= 0 || this.hasLanded) return false;
    const total = this.attackKind === 'kick' ? 0.34 : 0.26;
    const elapsed = total - this.attackTimer;
    return elapsed > total * 0.25 && elapsed < total * 0.7;
  }

  inRange(other) {
    const dx = (other.position.x - this.position.x) * this.facing;
    const dz = Math.abs(other.position.z - this.position.z);
    return dx > 0 && dx < REACH_X && dz < REACH_Z;
  }

  takeHit(damage, fromDirection) {
    if (this.dead || this.invulnerable > 0 || this.downTimer > 0) return false;
    this.health -= damage;
    this.invulnerable = 0.18;
    this.velocity.x = fromDirection * 3.4;

    if (this.health <= 0) {
      this.health = 0;
      this.downTimer = 1.1;
      this.actor.play('down');
      this.velocity.x = fromDirection * 5.0;
      return true;
    }
    this.stunTimer = 0.22;
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
    this.actor.play(moving ? 'walk' : 'idle');
    this.actor.update(dt, Math.min(1, this.velocity.length() / this.speed));
  }
}

/** Stops two fighters standing inside each other. */
export function separate(a, b, radius = 0.44) {
  const dx = b.position.x - a.position.x;
  const dz = (b.position.z - a.position.z) * 1.8;   // the belt is shallow
  const d2 = dx * dx + dz * dz;
  if (d2 > radius * radius || d2 < 1e-6) return;
  const d = Math.sqrt(d2);
  const push = (radius - d) / 2;
  const nx = dx / d;
  a.position.x -= nx * push;
  b.position.x += nx * push;
}
