/*
 * The first two minutes, for someone who has never played it.
 *
 * A brawler is six verbs and a keyboard nobody handed them a diagram for, and
 * the control line along the top of the screen is read by roughly nobody. So
 * this asks for one key at a time and waits — not a page of text with an OK
 * button, but a prompt that will not go away until the thing it names has
 * actually happened. A player who has finished it has already done everything
 * the game will ask of them.
 *
 * Nothing here reads the keyboard. Every step watches the world instead: where
 * the fighter is, what they are swinging, whether they are behind a guard. The
 * difference matters on a phone, where the same six verbs arrive from the
 * on-screen pad and no key is ever pressed at all — which is also why every
 * step carries two wordings. "Press J" is no help to a thumb.
 */

/*
 * Far enough to have room to walk, and short of `gate.x - 6`, which is where
 * the first wave is triggered. Learning which key punches is not something to
 * be doing with two wolves already on you.
 */
export const HOLD_AT = 3.8;

const STEPS = [
  {
    id: 'right',
    text: 'Walk right — → or D',
    touch: 'Walk right — hold ▶',
    begin: (t, game) => { t.mark = game.player.position.x; },
    done: (t, game) => game.player.position.x - t.mark >= 1.8
  },
  {
    id: 'left',
    text: 'And back the other way — ← or A',
    touch: 'And back the other way — hold ◀',
    begin: (t, game) => { t.mark = game.player.position.x; },
    done: (t, game) => t.mark - game.player.position.x >= 1.4
  },
  {
    /*
     * The one that has to be taught rather than mentioned. A player who never
     * finds the third axis fights every wave standing in a queue, and the
     * whole answer to being surrounded — and to the Cart's charge — is to
     * step off the line.
     */
    id: 'lane',
    text: 'Step up and down the field — ↑ ↓',
    touch: 'Step up and down the field — ▲ ▼',
    begin: (t, game) => { t.mark = game.player.position.z; },
    done: (t, game) => Math.abs(game.player.position.z - t.mark) >= 0.8
  },
  {
    id: 'punch',
    text: 'Punch — J or Space',
    touch: 'Punch — tap P',
    done: (t, game) => game.player.attackTimer > 0 && game.player.attackKind === 'punch'
  },
  {
    id: 'kick',
    text: 'Kick — K',
    touch: 'Kick — tap K',
    done: (t, game) => game.player.attackTimer > 0 && game.player.attackKind === 'kick'
  },
  {
    /*
     * Held, not tapped, so it is timed rather than watched for once: a player
     * who taps it has not learned the thing the step is for.
     */
    id: 'block',
    text: 'Hold to block — L or Shift',
    touch: 'Hold to block — hold B',
    begin: (t) => { t.held = 0; },
    done: (t, game, dt) => {
      t.held = game.player.blocking ? t.held + dt : 0;
      return t.held >= 0.5;
    }
  },
  {
    // The send-off, and the only step that is not a lesson: the wall comes
    // down here so "head right" is something the player can actually do.
    id: 'go',
    free: true,
    text: 'That is everything. Head right — the wolves are waiting.',
    done: (t) => t.time >= 3.5
  }
];

/** How many steps are lessons — the send-off is not one, and counting it would
 * put the player at 7/7 while still being told something. */
const LESSONS = STEPS.filter((step) => !step.free).length;

/** The wording of every step, for tests and for anything that wants to show
 * the controls outside a running game. */
export function steps() {
  return STEPS.map(({ id, text, touch, free }) => ({ id, text, touch: touch || text, free }));
}

export class Tutorial {
  /** @param onFinish called once, when it is done or skipped. */
  constructor(onFinish = () => {}) {
    this.onFinish = onFinish;
    this.index = 0;
    this.time = 0;
    this.mark = 0;
    this.held = 0;
    this.finished = false;
    this.entered = false;
  }

  get step() { return this.finished ? null : STEPS[this.index] || null; }

  /** True while the player is being kept short of the first gate. */
  get holding() {
    const step = this.step;
    return Boolean(step) && !step.free;
  }

  /** @returns true when the step changed, so the caller can repaint. */
  update(dt, game) {
    const step = this.step;
    if (!step) return false;

    if (!this.entered) {
      this.entered = true;
      this.time = 0;
      if (step.begin) step.begin(this, game);
    }
    this.time += dt;

    // dt is passed on because a held step is measured in seconds, not in
    // whether the button happened to be down on the frame we looked.
    if (!step.done(this, game, dt)) return false;

    this.index += 1;
    this.entered = false;
    if (this.index >= STEPS.length) this.finish();
    else game.sounds.play('confirm');
    return true;
  }

  /** Cut it short. Deliberately the same ending as finishing it: a player who
   * says they do not need this should not be asked again next round. */
  skip() {
    if (!this.finished) this.finish();
  }

  finish() {
    this.finished = true;
    this.onFinish();
  }

  state() {
    const step = this.step;
    if (!step) return null;
    return {
      text: step.text,
      // Falls back rather than repeating itself: the send-off names no control
      // at all, so it reads the same in either hand.
      touch: step.touch || step.text,
      lesson: step.free ? null : Math.min(this.index + 1, LESSONS),
      lessons: LESSONS
    };
  }
}
