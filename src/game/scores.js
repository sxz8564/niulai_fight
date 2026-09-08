/*
 * The ranking, and where it is kept.
 *
 * A board is two operations — put a run on it, and read it back in order — so
 * that is the whole interface. `localBoard()` is the one that ships: every run
 * this browser has finished, in this browser, and nowhere else. A remote board
 * is the same two operations against somebody's server, which is why they are
 * async and why the board says what it is rather than the screen assuming.
 *
 * Nothing here decides what a name is allowed to be beyond a length and a line
 * of text, and nothing here can stop a determined player editing their own
 * scores: it is their browser. A board that mattered would be validated by the
 * server that keeps it, not by the game that posts to it.
 */

const KEY = 'niulai-fight.scores';
const NAME_KEY = 'niulai-fight.name';
const KEEP = 50;          // more than anyone reads, small enough to store
export const NAME_LIMIT = 12;

/** One line of text, short enough to fit the board, or nothing. */
export function tidyName(raw) {
  return String(raw == null ? '' : raw)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_LIMIT);
}

function read() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(saved) ? saved.filter((row) => row && Number.isFinite(row.score)) : [];
  } catch {
    return [];      // private mode, or something else wrote here
  }
}

function write(rows) {
  try { localStorage.setItem(KEY, JSON.stringify(rows)); } catch { /* ignore */ }
}

/*
 * Highest first, and the older run wins a tie. Arcades have always done it that
 * way and it is the fairer half of an arbitrary choice: the player who got
 * there first got there first.
 */
function order(rows) {
  return [...rows].sort((a, b) => b.score - a.score || (a.at || 0) - (b.at || 0));
}

/**
 * Where a run stands: one more than the number of runs that beat it. The run
 * itself is excluded by identity, so this answers the same question whether or
 * not it has already been put on the board — which is the only reason the
 * screen can show a rank before anybody has decided to save it.
 */
export function rankOf(rows, run) {
  return rows.filter((row) => row !== run && (row.score > run.score ||
    (row.score === run.score && (row.at || 0) < (run.at || 0)))).length + 1;
}

/**
 * Whether two rows are the same run.
 *
 * By value, not by identity: a board hands back rows it has read from storage
 * or from a server, so the object that comes out is never the object that went
 * in. `at` is a millisecond stamp, which is enough on its own for one browser;
 * the other two are there for the day a server is merging runs from many.
 */
export function sameRun(a, b) {
  return Boolean(a && b && a.at === b.at && a.score === b.score && a.name === b.name);
}

/** The name this browser used last, so nobody types it twice. */
export function savedName() {
  try { return tidyName(localStorage.getItem(NAME_KEY) || ''); } catch { return ''; }
}

export function rememberName(name) {
  try { localStorage.setItem(NAME_KEY, tidyName(name)); } catch { /* ignore */ }
}

/**
 * The board in this browser.
 *
 * `where` is what the screen puts under the title, and it is the honest half of
 * the feature: a board of one machine's runs must not be presented as the
 * world's.
 */
export function localBoard() {
  return {
    id: 'local',
    where: 'ON THIS DEVICE',
    whereChinese: '本机',

    async top(limit = 10) {
      return order(read()).slice(0, limit);
    },

    /** Where this run would land, if it were saved. */
    async standing(run) {
      const rows = read();
      return { rank: rankOf(rows, run), total: rows.length + 1 };
    },

    async submit(run) {
      const rows = read();
      const entry = { ...run, name: tidyName(run.name) || 'ANON', at: run.at || Date.now() };
      rows.push(entry);
      const kept = order(rows).slice(0, KEEP);
      write(kept);
      rememberName(entry.name);
      return { rank: rankOf(rows, entry), total: rows.length, entry, top: kept.slice(0, 10) };
    }
  };
}

/*
 * The seam a server goes through.
 *
 * Left unwired on purpose. A world board needs an origin in `host_permissions`,
 * a privacy policy that says what is collected, a store listing that agrees
 * with both, and somebody's money keeping it up — none of which is a decision
 * this file gets to make. When there is one, it implements `top`, `standing`
 * and `submit` against it, says so in `where`, and everything above the seam
 * carries on unchanged.
 */
export function board() {
  return localBoard();
}
