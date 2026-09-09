import { Game } from './game/game.js';
import { chooseCharacter } from './select.js';
import { soundBank } from './game/sound.js';
import { DIFFICULTIES, difficultyById } from './game/difficulty.js';
import { board, savedName, tidyName, sameRun } from './game/scores.js';

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
const levels = document.getElementById('levels');
const tutorialButton = document.getElementById('tutorial');
const endlessButton = document.getElementById('endless');
const scenes = document.getElementById('scenes');
const over = {
  card: document.getElementById('over'),
  score: document.getElementById('finalscore'),
  rank: document.getElementById('finalrank'),
  form: document.getElementById('signature'),
  name: document.getElementById('yourname'),
  save: document.getElementById('save'),
  where: document.getElementById('boardwhere'),
  ranks: document.getElementById('ranks')
};
const tip = {
  card: document.getElementById('tip'),
  text: document.querySelector('#tip b'),
  of: document.querySelector('#tip .of'),
  skip: document.getElementById('tip-skip')
};

/* Which half of every prompt to show. The same condition the stylesheet uses to
 * put the touch pad on screen, because the pad is what the wording names. */
const usingTouch = globalThis.matchMedia
  ? matchMedia('(hover: none), (pointer: coarse)').matches
  : false;

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
  bossHealth: document.getElementById('bosshealth'),
  difficulty: document.getElementById('difficulty'),
  loop: document.getElementById('loop')
};

function paint(state) {
  if (state.playerName) {
    hud.who.textContent = `${state.playerName.toUpperCase()} ${state.playerNameChinese || ''}`.trim();
  }
  hud.health.style.width = `${(state.health / state.maxHealth) * 100}%`;
  hud.health.classList.toggle('low', state.health <= state.maxHealth * 0.3);
  hud.lives.textContent = '🐮'.repeat(Math.max(0, state.lives));
  hud.score.textContent = String(state.score).padStart(6, '0');
  // An endless run has no total to be a fraction of.
  hud.stage.textContent = state.stages ? `${state.stage}/${state.stages}` : `${state.stage}/∞`;

  /* The lap, for the moment one ends and the next starts under the player. */
  const flashing = Boolean(state.loopFlash) && !state.over;
  hud.loop.hidden = !flashing;
  if (flashing) {
    hud.loop.innerHTML = '';
    const big = document.createElement('div');
    big.textContent = `LOOP ${state.loop + 1}`;
    const small = document.createElement('small');
    small.textContent = 'SAME LIVES · SAME SCORE · KEEP GOING';
    hud.loop.append(big, small);
  }
  // Named in the HUD, not just on the screen you chose it from: "3/9" means
  // something quite different from "3/5" and the player should not have to
  // work out which run they are in.
  hud.difficulty.textContent = state.difficultyName || '';

  /*
   * The tutorial prompt, painted from the same snapshot as everything else so
   * it cannot disagree with the game about which step is being asked for.
   */
  const teaching = state.tutorial;
  tip.card.hidden = !teaching;
  if (teaching) {
    tip.text.textContent = usingTouch ? teaching.touch : teaching.text;
    tip.of.textContent = teaching.lesson ? `${teaching.lesson} / ${teaching.lessons}` : '';
  }

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
    'L hold to block' + (rage ? ` · M ${rage.name} when the bar is full` : '') + ' · P pause';
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

  /*
   * The board comes up once, on the frame the run ends, and stays until the
   * next round clears it. Painted from `over` rather than from here on every
   * frame: it is a screen, not a meter.
   */
  if (state.over && !signed) offerRun(state);
  if (!state.over) hideBoard();
  over.card.hidden = !boardUp;
  /*
   * The touch pad is put away with the run. It does nothing once the fight is
   * over, it sits exactly where the board does on a phone, and leaving it
   * there means a thumb reaching for the name box can land on the punch button
   * behind it.
   */
  pad.hidden = Boolean(state.over);

  if (state.over) {
    const headline = state.won
      ? `${state.playerNameChinese || ''}赢了 · ${(state.playerName || '').toUpperCase()} WINS`.trim()
      : 'GAME OVER';
    // Just the headline: the two keys are printed at the bottom of the board,
    // and saying them twice on one screen is noise.
    hud.banner.textContent = headline;
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
const tools = {
  music: document.getElementById('t-music'),
  pause: document.getElementById('t-pause'),
  home: document.getElementById('t-home')
};
const pausedScreen = document.getElementById('paused');
const pad = document.getElementById('pad');

/* Two switches for one setting: the roster's and the one in the fight. Both are
 * painted from the same state so neither can disagree with what you can hear. */
function paintMusic(on) {
  musicButton.textContent = on ? '♪ MUSIC ON' : '♪ MUSIC OFF';
  musicButton.setAttribute('aria-pressed', String(on));
  tools.music.textContent = on ? '♪' : '🔇';
  tools.music.setAttribute('aria-label', on ? 'music on' : 'music off');
  tools.music.setAttribute('aria-pressed', String(on));
  tools.music.classList.toggle('off', !on);
}
paintMusic(sounds.musicOn);
musicButton.addEventListener('click', () => paintMusic(sounds.toggleMusic()));

/*
 * Difficulty. Chosen on the roster screen, remembered between visits, and read
 * when a round starts — so it applies from the next round rather than changing
 * the level under a fight already in progress.
 */
const LEVEL_KEY = 'niulai-fight.difficulty';
let difficulty = DIFFICULTIES[0].id;
try {
  const saved = localStorage.getItem(LEVEL_KEY);
  if (saved) difficulty = difficultyById(saved).id;   // unknown ids fall back
} catch { /* private mode: play on Easy */ }

const levelButtons = DIFFICULTIES.map((level) => {
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.level = level.id;
  button.innerHTML = '<span class="name"></span><span class="zh"></span>' +
    '<span class="blurb"></span>';
  button.querySelector('.name').textContent = level.name;
  button.querySelector('.zh').textContent = level.nameChinese || '';
  button.querySelector('.blurb').textContent = level.blurb || '';
  button.addEventListener('click', () => setDifficulty(level.id));
  button.addEventListener('pointerenter', () => sounds.play('select'));
  levels.appendChild(button);
  return button;
});

function setDifficulty(id) {
  difficulty = difficultyById(id).id;
  for (const button of levelButtons) {
    button.setAttribute('aria-pressed', String(button.dataset.level === difficulty));
  }
  try { localStorage.setItem(LEVEL_KEY, difficulty); } catch { /* ignore */ }
  return difficulty;
}
setDifficulty(difficulty);

/*
 * The end of a run: what it was worth, where that puts it, and the board.
 *
 * Everything here hangs off one adapter, so the day there is a server the only
 * thing that changes is which board this is. The screen never assumes the board
 * is the world's — it prints what the board says it is.
 */
const ranking = board();
/* The two keys are no use to a thumb; on a phone the whole screen outside the
 * card is the play-again button, so that is what it says. */
document.querySelector('#over .again').textContent = usingTouch
  ? 'TAP OUTSIDE TO PLAY AGAIN'
  : 'R play again · C choose a fighter';
let signed = null;      // the run being offered to the board, until it is saved
let boardUp = false;    // whether the card is on screen yet
let boardTimer = 0;

/*
 * A loss has nothing to look at, so the board comes straight up. A win has a
 * hero doing backflips in the middle of the picture, and dropping a table of
 * numbers over him the instant he lands is a poor way to congratulate anyone.
 * The celebration loops for ever, so the wait costs nothing.
 */
const CELEBRATE = 2600;

function showBoard(run, after) {
  clearTimeout(boardTimer);
  boardTimer = setTimeout(() => {
    // The round can end and be restarted inside the pause; only the run this
    // timer was started for is allowed to put the card up. It puts it up
    // itself rather than waiting for the next frame to notice, because the
    // frame is not guaranteed to be running — a paused round still ends.
    if (!signed || signed.run !== run) return;
    boardUp = true;
    over.card.hidden = false;
  }, after);
}

function hideBoard() {
  clearTimeout(boardTimer);
  boardUp = false;
  over.card.hidden = true;
}

/** One row: place, name, points, and enough of the run to mean something. */
function rankRow(entry, place, mine) {
  const row = document.createElement('li');
  if (mine) row.className = 'you';
  const at = document.createElement('span');
  at.className = 'at';
  at.textContent = `${place}.`;
  const who = document.createElement('span');
  who.className = 'who';
  who.textContent = entry.name || 'ANON';
  const run = document.createElement('span');
  run.className = 'run';
  run.textContent = [entry.difficulty && entry.difficulty.toUpperCase(),
    entry.endless ? `∞ ${entry.stage}` : `STAGE ${entry.stage}`]
    .filter(Boolean).join(' · ');
  const pts = document.createElement('span');
  pts.className = 'pts';
  pts.textContent = String(entry.score).padStart(6, '0');
  row.append(at, who, run, pts);
  return row;
}

/**
 * Draws the board with this run in its place.
 *
 * The run is shown whether or not it has been saved, because a rank nobody can
 * see until they commit to it is not an answer to "how did I do" — and if it
 * lands outside the ten on screen, it is stitched on under a gap rather than
 * left off.
 */
async function paintBoard(run, place) {
  const top = await ranking.top(10);
  over.where.textContent =
    `RANKING 排行榜 · ${ranking.where}${ranking.whereChinese ? ` ${ranking.whereChinese}` : ''}`;
  over.ranks.innerHTML = '';

  const mineOf = (entry) => sameRun(entry, run) ||
    Boolean(signed && signed.entry && sameRun(entry, signed.entry));
  const shown = top.some(mineOf);
  top.forEach((entry, i) => over.ranks.append(rankRow(entry, i + 1, mineOf(entry))));
  if (!shown) {
    if (top.length) {
      const gap = document.createElement('li');
      gap.className = 'gap';
      gap.textContent = '·  ·  ·';
      over.ranks.append(gap);
    }
    over.ranks.append(rankRow(run, place, true));
  }
}

/** Offers the finished run to the board, and shows where it stands. */
async function offerRun(state) {
  const run = {
    name: savedName(),
    score: state.score,
    stage: state.stage,
    fighter: state.player,
    difficulty: state.difficulty,
    endless: Boolean(!state.stages),
    won: Boolean(state.won),
    at: Date.now()
  };
  signed = { run, saved: false, entry: null };
  over.score.textContent = String(run.score).padStart(6, '0');
  over.name.value = run.name;
  over.name.disabled = false;
  over.save.disabled = false;
  over.save.textContent = 'SAVE';

  const { rank, total } = await ranking.standing(run);
  // A round that ended while this one was still being drawn has moved on.
  if (!signed || signed.run !== run) return;
  over.rank.textContent = `RANK ${rank} OF ${total}`;
  await paintBoard(run, rank);
  showBoard(run, run.won ? CELEBRATE : 0);
}

/*
 * Saving. The name is optional — the board takes ANON — and the whole point of
 * the button is that nothing leaves the run until somebody presses it.
 */
over.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!signed || signed.saved) return;
  signed.saved = true;
  over.name.disabled = true;
  over.save.disabled = true;
  const result = await ranking.submit({ ...signed.run, name: tidyName(over.name.value) });
  signed.entry = result.entry;
  over.save.textContent = 'SAVED';
  over.rank.textContent = `RANK ${result.rank} OF ${result.total}`;
  await paintBoard(result.entry, result.rank);
});

/*
 * The two ways this screen could throw the run away by accident. A tap anywhere
 * plays again and R restarts, and both of those are perfectly reasonable until
 * somebody is typing their name into the middle of them.
 */
over.card.addEventListener('pointerdown', (event) => event.stopPropagation());

/*
 * The backdrop, and whether the level ever ends. Both are chosen here and read
 * when a round starts, so neither can change the world under a fight already
 * in progress.
 */
const SCENE_KEY = 'niulai-fight.background';
const ENDLESS_KEY = 'niulai-fight.endless';
let background = 'orchard-day';
let endless = false;
try {
  background = localStorage.getItem(SCENE_KEY) || background;
  endless = localStorage.getItem(ENDLESS_KEY) === 'on';
} catch { /* private mode: the default orchard, and a level that ends */ }

const sceneButtons = new Map();
function setBackground(id) {
  if (sceneButtons.size && !sceneButtons.has(id)) return background;   // a stale saved id
  background = id;
  for (const [key, button] of sceneButtons) {
    button.setAttribute('aria-pressed', String(key === background));
  }
  try { localStorage.setItem(SCENE_KEY, background); } catch { /* ignore */ }
  return background;
}

/* Painted from the same registry the game loads, so the roster cannot offer a
 * backdrop the game does not have. */
fetch('assets/scenes/index.json').then((r) => r.json()).then((registry) => {
  for (const scene of registry) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.scene = scene.id;
    const image = document.createElement('img');
    image.src = `assets/scenes/${scene.thumb || scene.file}`;
    image.alt = '';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = scene.name;
    button.append(image, name);
    button.title = `${scene.name} ${scene.nameChinese || ''}`.trim();
    button.addEventListener('click', () => setBackground(scene.id));
    button.addEventListener('pointerenter', () => sounds.play('select'));
    scenes.appendChild(button);
    sceneButtons.set(scene.id, button);
  }
  // Re-run now that the buttons exist: this is what lights the saved one, and
  // what puts a saved id that no longer ships back on the default.
  setBackground(sceneButtons.has(background) ? background : registry[0].id);
}).catch(() => { /* no picker; the game still has its default */ });

function setEndless(on) {
  endless = Boolean(on);
  endlessButton.textContent = endless ? '∞ INFINITE ON' : '∞ INFINITE OFF';
  endlessButton.setAttribute('aria-pressed', String(endless));
  try { localStorage.setItem(ENDLESS_KEY, endless ? 'on' : 'off'); } catch { /* ignore */ }
  return endless;
}
setEndless(endless);
endlessButton.addEventListener('click', () => setEndless(!endless));

/*
 * The tutorial. On for a new player and off ever after — it is a thing you do
 * once, and a game that offers to teach you again every time you open it is
 * calling you a beginner. Finishing it and skipping it end the same way, since
 * a player who says they do not need it has said so.
 */
const TUTORIAL_KEY = 'niulai-fight.tutorial';
let tutorialOn = true;
try {
  tutorialOn = localStorage.getItem(TUTORIAL_KEY) !== 'off';
} catch { /* private mode: teach them, it costs one round */ }

function setTutorial(on) {
  tutorialOn = Boolean(on);
  tutorialButton.textContent = tutorialOn ? '? TUTORIAL ON' : '? TUTORIAL OFF';
  tutorialButton.setAttribute('aria-pressed', String(tutorialOn));
  try { localStorage.setItem(TUTORIAL_KEY, tutorialOn ? 'on' : 'off'); } catch { /* ignore */ }
  return tutorialOn;
}
setTutorial(tutorialOn);
tutorialButton.addEventListener('click', () => setTutorial(!tutorialOn));

/*
 * In-game controls. Wired once, like the roster's switch, because they are part
 * of the page rather than of the round — a listener added per round would fire
 * twice on the second one. What they act on is the round that happens to be
 * running, which is what `paused` and `endRound` are for.
 */
let paused = false;
let endRound = null;
let currentGame = null;

function setPaused(on) {
  paused = Boolean(on) && Boolean(endRound);
  pausedScreen.hidden = !paused;
  tools.pause.textContent = paused ? '▶' : '❚❚';
  tools.pause.setAttribute('aria-label', paused ? 'resume' : 'pause');
  tools.pause.setAttribute('aria-pressed', String(paused));
}

/* The buttons sit inside a window-level "tap anywhere to play again" listener,
 * so a click on one of them must not also end the round it belongs to. */
for (const button of Object.values(tools)) {
  button.addEventListener('pointerdown', (event) => event.stopPropagation());
}
tools.music.addEventListener('click', () => paintMusic(sounds.toggleMusic()));
tools.pause.addEventListener('click', () => setPaused(!paused));
/* Home is the roster, not another round of the same one: a player who wants
 * out mid-fight wants to change something — the fighter, the difficulty, the
 * backdrop — and every one of those lives on that screen. Playing the same
 * round again is what the end of a run offers. */
tools.home.addEventListener('click', () => {
  if (endRound) endRound('select');
});
window.addEventListener('keydown', (event) => {
  // Only while a round is actually running: P on the roster should do nothing.
  if (!endRound) return;
  const key = event.key.toLowerCase();
  if (key === 'p') {
    event.preventDefault();
    setPaused(!paused);
  } else if (key === 'escape') {
    // Only while it is running, so Escape still belongs to the end-of-round
    // menu the moment there is one.
    if (skipTutorial()) event.preventDefault();
  }
});

/** Ends the lesson early, from the button or from the key. */
function skipTutorial() {
  if (!currentGame || !currentGame.tutorial || currentGame.tutorial.finished) return false;
  currentGame.tutorial.skip();
  paint(currentGame.snapshot());
  return true;
}
tip.skip.addEventListener('click', () => skipTutorial());

/* The harness needs a handle before a human has chosen anything — and the
 * sound bank outlives every round, so it hangs here rather than off the game. */
let offerChoice = null;
globalThis.__niulaiFight = {
  sounds,
  choose(id) { if (offerChoice) offerChoice(id); },
  get difficulty() { return difficulty; },
  setDifficulty(id) { return setDifficulty(id); },
  get tutorial() { return tutorialOn; },
  setTutorial(on) { return setTutorial(on); },
  get background() { return background; },
  setBackground(id) { return setBackground(id); },
  get endless() { return endless; },
  setEndless(on) { return setEndless(on); }
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
    /*
     * Choosing from anywhere else goes through the roster's own pick, which is
     * what stops the turning portraits. Resolving around it left their
     * renderers running, and a browser holds only so many WebGL contexts before
     * it starts refusing to make more — after half a dozen trips home, the next
     * round would not start at all.
     */
    let pickFromRoster = null;
    offerChoice = (id) => (pickFromRoster ? pickFromRoster(id) : settle(id));
    chooseCharacter('assets/', roster, (pick) => { pickFromRoster = pick; }).then(settle);
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

  const game = new Game(canvas, {
    onState: paint, playerId, difficulty, background, endless,
    tutorial: tutorialOn,
    // Finished or skipped, it does not come back. Written the moment it ends
    // rather than when the round does, so quitting halfway through the round
    // still counts as having been taught.
    onTutorialDone: () => setTutorial(false)
  });
  currentGame = game;
  signed = null;          // this round's run has not happened yet
  hideBoard();

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
    // Paused stops the clock, not the picture: the scene stays on screen behind
    // the overlay rather than going black, and nothing accumulates to be caught
    // up on when it resumes, because the frame still runs and dt still resets.
    if (!paused) game.update(dt);
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
    stop() { cancelAnimationFrame(raf); },
    /* The other half of stop(). Pause lives in the real frame loop — it is the
     * clock that stops, not the picture — so the only honest way to test it is
     * to let that loop run and watch the world stand still while time passes. */
    run() { cancelAnimationFrame(raf); previous = performance.now(); raf = requestAnimationFrame(frame); }
  });

  /*
   * Wait for the round to end and for the player to say what happens next.
   * The keys are only listened for once the game is actually over, so R during
   * a fight does nothing rather than throwing away a run in progress.
   */
  setPaused(false);
  const next = await new Promise((resolve) => {
    endRound = finish;
    function finish(choice) {
      endRound = null;
      setPaused(false);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onPointer);
      resolve(choice);
    }
    function onKey(event) {
      if (!game.over) return;
      /*
       * R plays again and Enter plays again — both perfectly reasonable until
       * somebody is typing REN or RACHEL into the name box in the middle of
       * them. A keystroke aimed at a text field belongs to that field.
       */
      if (event.target && event.target.closest && event.target.closest('#over')) return;
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
  currentGame = null;
  tip.card.hidden = true;
  hud.loop.hidden = true;
  hideBoard();
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
