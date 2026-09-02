import { Game } from './game/game.js';
import { chooseCharacter } from './select.js';
import { soundBank } from './game/sound.js';

/*
 * Bootstrap: choose a fighter, play a round, offer another.
 *
 * Written as a loop rather than a single run, because a brawler that ends and
 * then requires a page reload to play again is asking the player to do the
 * browser's job. Losing is supposed to send you straight back in.
 *
 * `window.__niulaiFight` is deliberately exposed. The tests drive the game
 * through it — pressing buttons and reading state — because a brawler that
 * renders beautifully and cannot land a punch still fails, and only playing it
 * finds that out.
 */

const canvas = document.getElementById('view');
const selectScreen = document.getElementById('select');
const roster = document.getElementById('roster');
const loading = document.getElementById('loading');

const hud = {
  health: document.getElementById('health'),
  lives: document.getElementById('lives'),
  score: document.getElementById('score'),
  stage: document.getElementById('stage'),
  banner: document.getElementById('banner'),
  who: document.getElementById('who'),
  hint: document.getElementById('hint'),
  rageWrap: document.getElementById('ragewrap'),
  rageLabel: document.getElementById('ragelabel'),
  rage: document.getElementById('rage'),
  padPower: document.getElementById('padpower'),
  bossRow: document.getElementById('bossrow'),
  bossName: document.getElementById('bossname'),
  bossHealth: document.getElementById('bosshealth')
};

function paint(state) {
  if (state.playerName) {
    hud.who.textContent = `${state.playerName.toUpperCase()} ${state.playerNameChinese || ''}`.trim();
  }
  hud.health.style.width = `${(state.health / state.maxHealth) * 100}%`;
  hud.health.classList.toggle('low', state.health <= state.maxHealth * 0.3);
  hud.lives.textContent = '🐮'.repeat(Math.max(0, state.lives));
  hud.score.textContent = String(state.score).padStart(6, '0');
  hud.stage.textContent = `${state.stage}/${state.stages}`;

  /*
   * The rage meter, and the key that spends it, both appear only for a fighter
   * that has a super. Baola's is not designed yet, so she gets neither — a bar
   * that fills and does nothing is a worse promise than no bar.
   */
  const rage = state.rage;
  hud.rageWrap.hidden = !rage;
  hud.padPower.hidden = !rage;
  if (rage) {
    hud.rageLabel.textContent = rage.active
      ? `${rage.name} ${Math.ceil(rage.seconds)}s`
      : (rage.ready ? `${rage.name} READY` : rage.name);
    hud.rage.style.width = `${rage.fraction * 100}%`;
    hud.rageWrap.classList.toggle('ready', rage.ready);
    // A running transformation drains the same bar, so it needs its own colour
    // or a half-full bar means two different things.
    hud.rageWrap.classList.toggle('super', Boolean(rage.active));
    hud.padPower.textContent = rage.name.slice(0, 1);
  }
  hud.hint.textContent = '← → move · ↑ ↓ step up and down · J punch · K kick · ' +
    'L hold to block' + (rage ? ` · M ${rage.name} when the bar is full` : '');
  // The controls are no use once the run is over, and they sit directly under
  // the banner.
  hud.hint.hidden = Boolean(state.over);

  /*
   * The boss bar only exists while there is a boss. Its wind-up gets its own
   * treatment: the player is watching the fight, not the interface, so the tell
   * has to be loud enough to catch out of the corner of an eye — the cart
   * rearing back is the real signal and this is the backup.
   */
  const boss = state.boss;
  hud.bossRow.hidden = !boss;
  if (boss) {
    const winding = boss.phase === 'wind';
    hud.bossName.textContent = winding
      ? `${boss.name.toUpperCase()} ${boss.nameChinese} — CHARGING`.trim()
      : `${boss.name.toUpperCase()} ${boss.nameChinese}`.trim();
    hud.bossHealth.style.width = `${Math.max(0, (boss.health / boss.maxHealth) * 100)}%`;
    hud.bossRow.classList.toggle('winding', winding);
  }

  if (state.over) {
    const headline = state.won
      ? `${state.playerNameChinese || ''}赢了 · ${(state.playerName || '').toUpperCase()} WINS`.trim()
      : 'GAME OVER';
    hud.banner.innerHTML = '';
    const big = document.createElement('div');
    big.textContent = headline;
    const small = document.createElement('div');
    small.className = 'again';
    small.textContent = 'R  play again      ·      C  choose a fighter';
    hud.banner.append(big, small);
    hud.banner.classList.toggle('won', Boolean(state.won));
    hud.banner.hidden = false;
  } else {
    hud.banner.hidden = true;
  }
}

/*
 * The music switch. Wired once rather than per visit to the roster — the button
 * is part of the page, not part of the screen that keeps being rebuilt, and
 * listeners that stack up would toggle it twice on the second round.
 */
const sounds = soundBank('assets/');
const musicButton = document.getElementById('music');
function paintMusic(on) {
  musicButton.textContent = on ? '♪ MUSIC ON' : '♪ MUSIC OFF';
  musicButton.setAttribute('aria-pressed', String(on));
}
paintMusic(sounds.musicOn);
musicButton.addEventListener('click', () => paintMusic(sounds.toggleMusic()));

/* The harness needs a handle before a human has chosen anything — and the
 * sound bank outlives every round, so it hangs here rather than off the game. */
let offerChoice = null;
globalThis.__niulaiFight = {
  sounds,
  choose(id) { if (offerChoice) offerChoice(id); }
};

/** Shows the select screen and resolves with the chosen character's id. */
function pickFighter() {
  roster.innerHTML = '';
  selectScreen.hidden = false;
  loading.hidden = true;
  // Asked for every time the roster appears, because the first attempt is the
  // one autoplay policy is most likely to refuse.
  sounds.startMusic('theme');

  return new Promise((resolve) => {
    let done = false;
    // The confirmation lives here rather than in the roster, because a fighter
    // can also be chosen by keyboard or by the test harness and all three
    // routes come through this one function.
    const settle = (id) => {
      if (done) return;
      done = true;
      offerChoice = null;
      sounds.play('confirm');
      resolve(id);
    };
    offerChoice = settle;
    chooseCharacter('assets/', roster).then(settle);
  });
}

/**
 * Plays one round. Resolves with what to do next: 'again' to replay with the
 * same fighter, 'select' to go back to the roster.
 */
async function playRound(playerId) {
  selectScreen.hidden = true;
  loading.hidden = false;
  hud.banner.hidden = true;

  const game = new Game(canvas, { onState: paint, playerId });

  function fit() {
    game.resize(canvas.clientWidth || window.innerWidth, canvas.clientHeight || window.innerHeight);
  }
  await game.load();
  fit();
  window.addEventListener('resize', fit);

  for (const button of document.querySelectorAll('[data-action]')) {
    const action = button.dataset.action;
    button.onpointerdown = (event) => { event.preventDefault(); game.input.press(action); };
    button.onpointerup = () => game.input.release(action);
    button.onpointerleave = () => game.input.release(action);
    button.onpointercancel = () => game.input.release(action);
  }

  let raf = 0;
  let previous = performance.now();
  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = (now - previous) / 1000;
    previous = now;
    game.update(dt);
    game.render();
    paint(game.snapshot());
  }
  raf = requestAnimationFrame(frame);
  loading.hidden = true;

  Object.assign(globalThis.__niulaiFight, {
    game,
    /** Advances the simulation deterministically, for tests. */
    step(seconds, slice = 1 / 60) {
      for (let t = 0; t < seconds; t += slice) game.update(slice);
      game.render();
      return game.snapshot();
    },
    press(action) { game.input.press(action); },
    release(action) { game.input.release(action); },
    stop() { cancelAnimationFrame(raf); }
  });

  /*
   * Wait for the round to end and for the player to say what happens next.
   * The keys are only listened for once the game is actually over, so R during
   * a fight does nothing rather than throwing away a run in progress.
   */
  const next = await new Promise((resolve) => {
    function finish(choice) {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onPointer);
      resolve(choice);
    }
    function onKey(event) {
      if (!game.over) return;
      const key = event.key.toLowerCase();
      if (key === 'r' || key === 'enter') { event.preventDefault(); finish('again'); }
      else if (key === 'c' || key === 'escape') { event.preventDefault(); finish('select'); }
    }
    // A tap anywhere also plays again, so the on-screen pad does not need a
    // button that exists for one moment in a round.
    function onPointer() { if (game.over) finish('again'); }

    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onPointer);
    globalThis.__niulaiFight.finish = finish;   // for tests
  });

  cancelAnimationFrame(raf);
  window.removeEventListener('resize', fit);
  hud.banner.hidden = true;
  game.dispose();
  delete globalThis.__niulaiFight.game;

  return next;
}

let fighter = await pickFighter();
for (;;) {
  const next = await playRound(fighter);
  if (next === 'select') fighter = await pickFighter();
}
