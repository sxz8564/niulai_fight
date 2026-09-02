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
          const voices = [];
          for (let i = 0; i < (config.voices || DEFAULT_VOICES); i++) {
            const audio = new Audio(`${this.base}audio/${config.file}`);
            audio.preload = 'auto';
            audio.volume = config.volume ?? DEFAULT_VOLUME;
            voices.push(audio);
          }
          this.bank.set(name, { voices, next: 0 });
        }
        return this;
      })
      .catch(() => this);   // a game with no sound is still a game
    return this.loading;
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
