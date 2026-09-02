/*
 * The Cart — the thing at the end of the level.
 *
 * The wolves are a crowd problem: several of them, each individually easy, and
 * the skill is in not letting them surround you. A boss has to be a different
 * question or it is just a wolf with more health, so this one is a timing
 * problem instead. It has exactly one attack and it announces it:
 *
 *   stalk    rolls after you, slowly. Too slow to catch anyone who keeps
 *            moving, which is the point — it is not trying to catch you, it is
 *            trying to line you up.
 *   wind     stops dead for a second, rears back and shakes. This is the whole
 *            fight. One second is long enough to react to and short enough to
 *            be frightening.
 *   charge   straight down the belt at six times its rolling speed, in the lane
 *            it locked in during the wind-up. Enormous damage on contact.
 *   recover  overshoots, stalls, and sits there. The only window to hurt it,
 *            and it takes double damage in it.
 *
 * The charge holds its Z, and that is the design rather than a simplification:
 * it means the answer is to step off the line, which is the one mechanic the
 * whole game is built around and the one a player can go the entire level
 * without ever needing. Blocking works too, and costs you a third of the
 * damage; stepping aside costs nothing. The boss is where the belt stops being
 * decoration.
 */

export const STALK_MIN = 1.9;    // closer than this and it backs off to line up
export const STALK_MAX = 4.8;    // further and it closes first
export const LANE = 0.5;         // how squarely lined up in Z before it commits
export const WIND_TIME = 1.0;    // the pause. The request, and the whole tell.
export const CHARGE_SPEED = 12.5;
export const CHARGE_DISTANCE = 5.6;
export const CHARGE_TIMEOUT = 1.2;
export const RECOVER_TIME = 1.5;
export const PUNISH = 2;         // damage multiplier while it is stalled
export const COOLDOWN = 0.7;     // after a recovery, before it may line up again

export class Boss {
  /**
   * @param {import('./fighter.js').Fighter} fighter the body it drives
   * @param {{min: number, max: number}} arena how far it may travel in X
   */
  constructor(fighter, arena) {
    this.fighter = fighter;
    this.arena = arena;
    this.phase = 'stalk';
    this.timer = COOLDOWN;
    this.chargeDir = -1;
    this.chargeFrom = 0;
    this.hasHit = false;    // one hit per charge, however long it is in you
    this.charges = 0;
  }

  get vulnerable() { return this.phase === 'recover'; }

  enter(phase) {
    this.phase = phase;
    this.timer = { stalk: COOLDOWN, wind: WIND_TIME, charge: CHARGE_TIMEOUT, recover: RECOVER_TIME }[phase];
    this.fighter.vulnerability = phase === 'recover' ? PUNISH : 1;
  }

  update(dt, player) {
    const f = this.fighter;

    // Wrecked, or going down. Nothing below applies, and leaving the velocity
    // set would drive the wreck off down the belt.
    if (f.dead || f.downTimer > 0) {
      f.velocity.set(0, 0, 0);
      f.pose = null;
      return;
    }

    this.timer -= dt;
    const dx = player.position.x - f.position.x;
    const dz = player.position.z - f.position.z;
    const away = Math.abs(dx);

    switch (this.phase) {
      case 'wind': {
        // It may still turn while winding up — the pause is a warning, not a
        // free hit — but it cannot move.
        f.pose = 'wind';
        f.facing = dx >= 0 ? 1 : -1;
        f.velocity.set(0, 0, 0);
        if (this.timer <= 0) {
          this.chargeDir = f.facing;
          this.chargeFrom = f.position.x;
          this.hasHit = false;
          this.charges += 1;
          this.enter('charge');
        }
        break;
      }

      case 'charge': {
        f.pose = 'charge';
        f.facing = this.chargeDir;
        // No Z component at all. A charge that tracked the player would be
        // unavoidable, and there would be nothing to learn.
        f.velocity.set(this.chargeDir * CHARGE_SPEED, 0, 0);
        const travelled = Math.abs(f.position.x - this.chargeFrom);
        const wall = this.chargeDir > 0
          ? f.position.x >= this.arena.max
          : f.position.x <= this.arena.min;
        if (travelled >= CHARGE_DISTANCE || wall || this.timer <= 0) this.enter('recover');
        break;
      }

      case 'recover': {
        f.pose = 'recover';
        f.velocity.set(0, 0, 0);
        if (this.timer <= 0) this.enter('stalk');
        break;
      }

      default: {
        f.pose = null;
        f.facing = dx >= 0 ? 1 : -1;

        /*
         * Hold a stand-off distance rather than closing all the way. Sitting on
         * top of the player would mean every charge starts already touching
         * them, which is not an attack anyone can answer.
         */
        const towards = away > STALK_MAX ? Math.sign(dx)
          : away < STALK_MIN ? -Math.sign(dx)
            : 0;
        f.velocity.set(towards * f.speed, 0,
          Math.sign(dz) * Math.min(1, Math.abs(dz) * 2) * f.speed * 0.85);

        const lined = away >= STALK_MIN && away <= STALK_MAX && Math.abs(dz) < LANE;
        if (lined && this.timer <= 0) this.enter('wind');
      }
    }
  }

  /**
   * The charge itself, as a hit. Not the usual striking-frames test: this is a
   * two-tonne body moving through space, so what matters is whether it is
   * touching you, and it hurts once per charge rather than once per frame.
   *
   * @returns {boolean} whether it connected
   */
  ram(player) {
    if (this.phase !== 'charge' || this.hasHit) return false;
    const f = this.fighter;
    const dx = Math.abs(player.position.x - f.position.x);
    const dz = Math.abs(player.position.z - f.position.z);
    if (dx > f.hurtRadius + 0.34 || dz > (f.hurtDepth || 0.72)) return false;
    // `chargeDir` is the direction the blow travels, which is what decides
    // whether a raised guard is facing it.
    if (!player.takeHit(f.damage, this.chargeDir)) return false;
    this.hasHit = true;
    return true;
  }
}
