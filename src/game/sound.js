/*
 * The sound bank.
 *
 * Everything is one short file played through an <audio> element, which for a
 * handful of impacts is the whole job — no mixer, no graph, no library.
 *
 * Two details that are not optional:
 *
 *   Voices. One element per sound cuts itself off, so two punches a tenth of a
 *   second apart become one punch. Each sound gets a few elements played round
 *   robin, which is the cheapest possible polyphony and is enough for a game
 *   where the loudest moment is three wolves going down at once.
 *
 *   Silence is not failure. Autoplay policy blocks anything before the first
 *   real interaction, a muted tab rejects play() outright, and a missing file
 *   is a missing file. None of that should reach the game loop, so every path
 *   here swallows its own errors and the caller never has to care.
 */

const DEFAULT_VOICES = 3;
const DEFAULT_VOLUME = 0.6;

/* Where the music preference lives. Per browser, per install; it survives a
 * reload, which is the only thing anyone expects of it. */
const MUSIC_KEY = 'niulai-fight.music';

export class Sounds {
  constructor(base = 'assets/') {
    this.base = base;
    this.bank = new Map();
    this.loading = null;
  }

  /** Reads the manifest and pre-rolls every voice. Safe to call repeatedly. */
  load() {
    if (this.loading) return this.loading;
    this.loading = fetch(`${this.base}audio/index.json`)
      .then((response) => response.json())
      .then((manifest) => {
        if (typeof Audio === 'undefined') return this;
        for (const [name, entry] of Object.entries(manifest)) {
          const config = typeof entry === 'string' ? { file: entry } : entry;
          this.add(name, config);
        }
        return this;
      })
      .catch(() => this);   // a game with no sound is still a game
    return this.loading;
  }

  /**
   * Puts one sound in the bank, replacing whatever was under that name.
   *
   * Used by the manifest above and, at the start of a round, for the sounds
   * that belong to whoever is being played — the same name means the current
   * hero's voice, so switching fighters replaces it rather than accumulating.
   */
  add(name, entry) {
    if (typeof Audio === 'undefined') return this;
    const config = typeof entry === 'string' ? { file: entry } : entry;
    // A looping track is one element that keeps its place. Giving it voices
    // would mean the music restarting on top of itself.
    const count = config.loop ? 1 : (config.voices || DEFAULT_VOICES);
    const voices = [];
    for (let i = 0; i < count; i++) {
      const audio = new Audio(`${this.base}audio/${config.file}`);
      audio.preload = 'auto';
      audio.volume = config.volume ?? DEFAULT_VOLUME;
      audio.loop = Boolean(config.loop);
      voices.push(audio);
    }
    this.bank.set(name, { voices, next: 0, loop: Boolean(config.loop) });
    return this;
  }

  /** @returns {boolean} whether a voice was actually started. */
  play(name) {
    const sound = this.bank.get(name);
    if (!sound) return false;
    const audio = sound.voices[sound.next];
    sound.next = (sound.next + 1) % sound.voices.length;
    try {
      audio.currentTime = 0;
      const started = audio.play();
      if (started && started.catch) started.catch(() => {});
      return true;
    } catch {
      return false;
    }
  }

  /** The names it knows, for anything that wants to check its own wiring. */
  get names() { return [...this.bank.keys()]; }

  /* ------------------------------------------------------------- the music --
   *
   * One looping track, one switch, and a preference that survives a reload.
   * On unless it has been turned off: a game that opens silent looks broken to
   * someone who never finds the button.
   */

  get musicOn() {
    if (this.wanted === undefined) {
      let saved = null;
      try { saved = localStorage.getItem(MUSIC_KEY); } catch { /* private mode */ }
      this.wanted = saved !== 'off';
    }
    return this.wanted;
  }

  /** @returns {boolean} the new state, so a caller can paint a label with it. */
  setMusic(on) {
    this.wanted = Boolean(on);
    try { localStorage.setItem(MUSIC_KEY, this.wanted ? 'on' : 'off'); } catch { /* ignore */ }
    if (this.wanted) this.startMusic(this.track); else this.stopMusic();
    return this.wanted;
  }

  toggleMusic() { return this.setMusic(!this.musicOn); }

  /**
   * Starts the loop, if it is wanted and the browser will have it.
   *
   * It usually will not, the first time: autoplay policy refuses audio before a
   * page has been interacted with, and the select screen appears before anyone
   * has done anything. Rather than treating that as failure, a refusal arms a
   * one-shot listener and the music comes in on the first click or keypress —
   * which, on a screen whose entire job is to be clicked, is a moment away.
   */
  startMusic(name = 'theme') {
    this.track = name;
    if (!this.musicOn) return false;
    const sound = this.bank.get(name);
    if (!sound) {
      /*
       * The manifest is usually still in the air the first time this is asked.
       * The roster appears the instant the page does, well before a fetch comes
       * back, and returning quietly here meant the music never started and the
       * gesture fallback below was never even armed — silent, with nothing to
       * suggest anything had gone wrong.
       */
      if (this.loading) {
        this.loading.then(() => { if (this.bank.get(name)) this.startMusic(name); });
      }
      return false;
    }
    const audio = sound.voices[0];
    if (!audio.paused) return true;
    try {
      const started = audio.play();
      if (started && started.catch) started.catch(() => this.waitForAGesture());
    } catch {
      this.waitForAGesture();
    }
    return true;
  }

  stopMusic() {
    for (const sound of this.bank.values()) {
      if (!sound.loop) continue;
      try { sound.voices[0].pause(); } catch { /* ignore */ }
    }
  }

  waitForAGesture() {
    if (this.armed || typeof window === 'undefined') return;
    this.armed = true;
    const go = () => {
      window.removeEventListener('pointerdown', go);
      window.removeEventListener('keydown', go);
      this.armed = false;
      this.startMusic(this.track);
    };
    window.addEventListener('pointerdown', go);
    window.addEventListener('keydown', go);
  }

  /** Whether the loop is actually running, for anything checking its wiring. */
  get musicPlaying() {
    const sound = this.bank.get(this.track || 'theme');
    return Boolean(sound && !sound.voices[0].paused);
  }
}

/*
 * One bank for the whole page. The select screen and the game both want it, and
 * a round ending must not throw the sounds away — a player who restarts four
 * times should not download the same punch four times, or hear the first one
 * arrive late.
 */
let shared = null;
export function soundBank(base) {
  if (!shared) {
    shared = new Sounds(base);
    shared.load();
  }
  return shared;
}
