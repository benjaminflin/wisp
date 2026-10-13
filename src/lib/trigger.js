'use strict';

/**
 * Global input handling.
 *
 * Two ways in:
 *   - Electron's globalShortcut, for a normal chord like Cmd+Shift+Space.
 *     No special macOS permission required.
 *   - A low-level hook (uiohook-napi), so a bare modifier key can be *held*
 *     like a walkie-talkie. This needs Accessibility permission.
 *
 * A bare modifier cannot be expressed as an Electron accelerator, which is the
 * whole reason the native hook exists.
 */

const { EventEmitter } = require('events');

/** Keys a user may hold to dictate, in the order we present them. */
const HOLD_KEYS = [
  { id: 'AltRight', label: 'Right Option (⌥)', glyph: '⌥', recommended: true },
  { id: 'MetaRight', label: 'Right Command (⌘)', glyph: '⌘' },
  { id: 'ControlRight', label: 'Right Control (⌃)', glyph: '⌃' },
  { id: 'ShiftRight', label: 'Right Shift (⇧)', glyph: '⇧' },
  { id: 'AltLeft', label: 'Left Option (⌥)' },
  { id: 'MetaLeft', label: 'Left Command (⌘)' },
  { id: 'ControlLeft', label: 'Left Control (⌃)' },
];

/**
 * Fires 'down' when every key in the set is held and 'up' as soon as the set
 * is broken. Emitting on the *set* rather than a single key is what lets the
 * same code drive single-modifier and combination triggers.
 */
class HoldTrigger extends EventEmitter {
  constructor() {
    super();
    this.codes = new Set();
    this.pressed = new Set();
    this.active = false;
    this.keycodes = [];
    this.boundDown = (e) => this.onKeyDown(e);
    this.boundUp = (e) => this.onKeyUp(e);
    this.uio = null;
    this.startedAt = Date.now();
    this.keyEventCount = 0;
  }

  /** Resolves logical key names to platform keycodes. */
  static resolveKeycodes(names) {
    let uio;
    try {
      uio = require('uiohook-napi');
    } catch {
      return { error: 'uiohook-napi is not installed' };
    }
    const table = uio.UiohookKey || {};
    const codes = [];
    for (const name of names) {
      const code = table[name];
      if (typeof code !== 'number') return { error: `unknown key: ${name}` };
      codes.push(code);
    }
    return { codes, uio };
  }

  start(names) {
    this.stop();
    const resolved = HoldTrigger.resolveKeycodes(names);
    if (resolved.error) return { ok: false, error: resolved.error };

    this.uio = resolved.uio;
    this.keycodes = resolved.codes;
    this.codes = new Set(resolved.codes);
    this.pressed = new Set();
    this.active = false;

    const { uIOhook } = this.uio;
    uIOhook.on('keydown', this.boundDown);
    uIOhook.on('keyup', this.boundUp);
    try {
      uIOhook.start();
    } catch (err) {
      return { ok: false, error: `input hook failed: ${err.message}` };
    }
    return { ok: true, keycodes: this.keycodes };
  }

  onKeyDown(e) {
    this.keyEventCount += 1;
    if (!this.codes.has(e.keycode)) return;
    if (this.pressed.has(e.keycode)) return; // ignore auto-repeat
    this.pressed.add(e.keycode);
    if (!this.active && this.keycodes.every((c) => this.pressed.has(c))) {
      this.active = true;
      this.emit('down');
    }
  }

  onKeyUp(e) {
    this.keyEventCount += 1;
    if (!this.codes.has(e.keycode)) return;
    this.pressed.delete(e.keycode);
    if (this.active && !this.keycodes.every((c) => this.pressed.has(c))) {
      this.active = false;
      this.emit('up');
    }
  }

  /**
   * Whether the hook is actually receiving events. macOS silently delivers
   * nothing until Accessibility access is granted, so "no events yet" is the
   * only honest signal we have.
   */
  isReceivingEvents() {
    return this.keyEventCount > 0;
  }

  stop() {
    if (!this.uio) return;
    const { uIOhook } = this.uio;
    try {
      uIOhook.off('keydown', this.boundDown);
      uIOhook.off('keyup', this.boundUp);
    } catch {
      /* ignore */
    }
    this.uio = null;
    this.active = false;
    this.pressed.clear();
  }
}

module.exports = { HoldTrigger, HOLD_KEYS };
