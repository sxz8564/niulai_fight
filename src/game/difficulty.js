/*
 * Three ways through the same orchard.
 *
 * Easy is the game exactly as it was before there was a choice — five stages,
 * wolves that go down in three of Niulai's punches — so nobody's idea of what
 * this game is changes underneath them. Normal and Hard are that fight with
 * more of it: wolves that take more hits, and more gates between the first one
 * and the Cart.
 *
 * Two knobs and no more. Faster wolves or harder-hitting ones would change what
 * the game asks of a player; more health and more stages only ask for more of
 * what they are already doing, which is the difference a difficulty setting is
 * supposed to make.
 */

/*
 * Where the gates stand, and how many wolves are waiting at each. The level is
 * built by taking the first `stages` of these — so every difficulty opens with
 * the same three fights, and the harder ones keep going afterwards. The last
 * gate a run uses is always the Cart's, wherever it falls.
 */
const GATE_X = [10, 26, 44, 62, 80, 98, 116, 134, 152];
const COUNT = [2, 3, 3, 4];      // and four a gate from there on
const BOSS_COUNT = 2;            // wolves keeping you honest during the Cart

export const DIFFICULTIES = [
  {
    id: 'easy',
    name: 'EASY',
    nameChinese: '简单',
    blurb: '5 stages · wolves go down quickly',
    stages: 5,
    wolf: { health: 34 },
    // Multiplies the Cart's own health from the registry, so the boss grows
    // with the run rather than being three different entries in the model list.
    boss: 1
  },
  {
    id: 'normal',
    name: 'NORMAL',
    nameChinese: '普通',
    blurb: '7 stages · wolves take an extra hit',
    stages: 7,
    wolf: { health: 46 },
    boss: 1.4
  },
  {
    id: 'hard',
    name: 'HARD',
    nameChinese: '困难',
    blurb: '9 stages · wolves take two more',
    stages: 9,
    wolf: { health: 60 },
    boss: 1.8
  }
];

/** The named difficulty, or Easy — an unknown id is a saved setting from an
 * older build, not a reason to refuse to start. */
export function difficultyById(id) {
  return DIFFICULTIES.find((level) => level.id === id) || DIFFICULTIES[0];
}

/**
 * The gates for one difficulty. A fresh array of fresh objects every time:
 * `opened` is written to as a wave triggers, and a shared list would hand the
 * next run a level whose gates were all open already — every fight skipped.
 */
export function gatesFor(level) {
  const stages = Math.min(level.stages, GATE_X.length);
  return GATE_X.slice(0, stages).map((x, i) => (
    i === stages - 1
      ? { x, count: BOSS_COUNT, boss: 'cart' }
      : { x, count: COUNT[i] ?? COUNT[COUNT.length - 1] }
  ));
}
