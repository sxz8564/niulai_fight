/*
 * Keyboard and touch, reduced to the four things the game asks about: which
 * way you are pushing, and whether punch or kick was pressed this frame.
 *
 * Presses are edge-triggered and cleared by the game each frame, so holding a
 * key does not machine-gun.
 */

const KEYS = {
  ArrowLeft: 'left', KeyA: 'left',
  ArrowRight: 'right', KeyD: 'right',
  ArrowUp: 'up', KeyW: 'up',
  ArrowDown: 'down', KeyS: 'down',
  KeyJ: 'punch', Space: 'punch',
  KeyK: 'kick',
  // The super. M for mama, which is what it makes him shout — a key nobody has
  // to be told twice. U sits above J for anyone already on the punch row.
  KeyM: 'power', KeyU: 'power',
  // Block is held rather than tapped, so it gets keys that are comfortable to
  // hold down while still steering with the other hand.
  KeyL: 'block', ShiftLeft: 'block', ShiftRight: 'block'
};

export function createInput(target = window) {
  const held = new Set();
  const pressed = new Set();

  function down(event) {
    const action = KEYS[event.code];
    if (!action) return;
    // Space and the arrows scroll the page otherwise, which is disorienting
    // in a game that is already moving.
    event.preventDefault();
    if (!held.has(action)) pressed.add(action);
    held.add(action);
  }
  function up(event) {
    const action = KEYS[event.code];
    if (action) held.delete(action);
  }
  // A window that loses focus mid-run would otherwise keep the character
  // walking into the scenery for ever.
  function blur() { held.clear(); }

  target.addEventListener('keydown', down);
  target.addEventListener('keyup', up);
  target.addEventListener('blur', blur);

  return {
    axis() {
      return {
        x: (held.has('right') ? 1 : 0) - (held.has('left') ? 1 : 0),
        z: (held.has('down') ? 1 : 0) - (held.has('up') ? 1 : 0)
      };
    },
    /** True while the key is down — for actions that are held, not tapped. */
    holding(action) { return held.has(action); },
    consume(action) {
      if (!pressed.has(action)) return false;
      pressed.delete(action);
      return true;
    },
    /** For the on-screen buttons and for tests. */
    press(action) { pressed.add(action); held.add(action); },
    release(action) { held.delete(action); },
    endFrame() { pressed.clear(); },
    dispose() {
      target.removeEventListener('keydown', down);
      target.removeEventListener('keyup', up);
      target.removeEventListener('blur', blur);
    }
  };
}
