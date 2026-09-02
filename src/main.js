import { Game } from './game/game.js';
import { chooseCharacter } from './select.js';

/*
 * Bootstrap: build the game, wire the HUD, run the loop.
 *
 * `window.__niulaiFight` is deliberately exposed. The smoke test drives the
 * game through it — pressing buttons and reading state — because a brawler
 * that renders beautifully and cannot land a punch still fails, and only
 * playing it finds that out.
 */

const canvas = document.getElementById('view');
const hud = {
  health: document.getElementById('health'),
  lives: document.getElementById('lives'),
  score: document.getElementById('score'),
  stage: document.getElementById('stage'),
  banner: document.getElementById('banner'),
  who: document.getElementById('who')
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

  if (state.over) {
    hud.banner.textContent = state.won
      ? `${state.playerNameChinese || ''}赢了  ·  ${(state.playerName || '').toUpperCase()} WINS`.trim()
      : 'GAME OVER';
    hud.banner.hidden = false;
  } else if (state.enemies > 0) {
    hud.banner.hidden = true;
  }
}

const select = document.getElementById('select');

/*
 * The test harness needs to exist before a human has chosen anything, so the
 * global is published immediately with just `choose`. Everything else appears
 * on it once a character is picked and the game has loaded.
 */
let resolveChoice;
const chosen = new Promise((resolve) => { resolveChoice = resolve; });
globalThis.__niulaiFight = { choose: (id) => resolveChoice(id) };

document.getElementById('loading').hidden = true;
chooseCharacter('assets/', document.getElementById('roster')).then(resolveChoice);

const playerId = await chosen;
select.hidden = true;
document.getElementById('loading').hidden = false;

const game = new Game(canvas, { onState: paint, playerId });

function fit() {
  const width = canvas.clientWidth || window.innerWidth;
  const height = canvas.clientHeight || window.innerHeight;
  game.resize(width, height);
}

await game.load();
fit();
window.addEventListener('resize', fit);

// On-screen buttons, so the game is playable on a phone.
for (const button of document.querySelectorAll('[data-action]')) {
  const action = button.dataset.action;
  const press = (event) => { event.preventDefault(); game.input.press(action); };
  const release = () => game.input.release(action);
  button.addEventListener('pointerdown', press);
  button.addEventListener('pointerup', release);
  button.addEventListener('pointerleave', release);
  button.addEventListener('pointercancel', release);
}

let previous = performance.now();
let raf = 0;
function frame(now) {
  raf = requestAnimationFrame(frame);
  const dt = (now - previous) / 1000;
  previous = now;
  game.update(dt);
  game.render();
  paint(game.snapshot());
}
raf = requestAnimationFrame(frame);

document.getElementById('loading').hidden = true;

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
