'use strict';

/**
 * Settings live in a single JSON file under the app's data directory.
 *
 * Every value is validated on the way in and on the way out, so a hand-edited
 * or corrupt file degrades to defaults instead of breaking the app.
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

/** Curated MLX Whisper builds, all verified to exist on the Hub. */
const WHISPER_MODELS = [
  {
    id: 'mlx-community/whisper-large-v3-turbo',
    label: 'Large v3 Turbo — most accurate (~1.6 GB)',
  },
  {
    id: 'mlx-community/whisper-large-v3-turbo-8bit',
    label: 'Large v3 Turbo 8-bit — faster, half the memory (~800 MB)',
  },
  { id: 'mlx-community/whisper-medium-mlx', label: 'Medium — balanced (~1.5 GB)' },
  { id: 'mlx-community/whisper-small-mlx', label: 'Small — quick (~500 MB)' },
  { id: 'mlx-community/whisper-base-mlx', label: 'Base — fastest usable (~150 MB)' },
  { id: 'mlx-community/whisper-tiny', label: 'Tiny — instant, least accurate (~75 MB)' },
];

const TRIGGER_MODES = ['hold', 'toggle', 'both'];

const DEFAULTS = {
  // trigger
  triggerMode: 'hold',
  holdKey: 'AltRight',
  toggleShortcut: 'Command+Shift+Space',
  holdLatchMs: 350,

  // transcription
  whisperModel: 'mlx-community/whisper-large-v3-turbo',
  language: 'en',
  vocabulary: '',
  // Per-20ms-frame energy threshold. Steady room tone never reaches it while
  // speech is bursty, so only a small active fraction is needed to proceed.
  silenceFloor: 0.005,
  maxSeconds: 300,

  // cleanup
  cleanupEnabled: true,
  ollamaUrl: 'http://127.0.0.1:11434',
  ollamaModel: 'qwen2.5:7b',
  cleanupTimeoutMs: 90000,
  // Empty means "use the prompt built into src/lib/qwen.js". Keeping the
  // default text out of here means improvements to it still reach anyone who
  // has opened the settings window.
  cleanupPrompt: '',

  // audio & output
  inputDevice: null,
  copyToClipboard: true,
  // Off by default: pasting into the focused app is intrusive, and it also
  // needs Accessibility access on top of what the hold key already asks for.
  autoPaste: false,
  pasteDelayMs: 120,
  playSounds: true,
  showHud: true,

  // general
  launchAtLogin: false,
  keepTranscripts: true,
};

let cache = null;
let resolvedPath = null;

function dataDir() {
  if (process.env.WISP_DATA_DIR) return process.env.WISP_DATA_DIR;
  return app.getPath('userData');
}

function settingsPath() {
  if (!resolvedPath) resolvedPath = path.join(dataDir(), 'settings.json');
  return resolvedPath;
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function sanitize(raw, base = DEFAULTS) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const out = { ...base };

  const str = (key, max = 400) => {
    if (typeof input[key] === 'string') out[key] = input[key].slice(0, max);
  };
  const bool = (key) => {
    if (typeof input[key] === 'boolean') out[key] = input[key];
  };

  if (TRIGGER_MODES.includes(input.triggerMode)) out.triggerMode = input.triggerMode;
  str('holdKey', 40);
  str('toggleShortcut', 80);
  out.holdLatchMs = clampNumber(input.holdLatchMs, 0, 1500, base.holdLatchMs);

  if (typeof input.whisperModel === 'string' && /^[\w.-]+\/[\w.-]+$/.test(input.whisperModel)) {
    out.whisperModel = input.whisperModel;
  }
  if (input.language === 'auto' || /^[a-z]{2}$/.test(input.language || '')) {
    out.language = input.language;
  }
  str('vocabulary', 600);
  out.silenceFloor = clampNumber(input.silenceFloor, 0, 0.05, base.silenceFloor);
  out.maxSeconds = clampNumber(input.maxSeconds, 5, 1800, base.maxSeconds);

  bool('cleanupEnabled');
  if (typeof input.ollamaUrl === 'string' && /^https?:\/\//.test(input.ollamaUrl)) {
    out.ollamaUrl = input.ollamaUrl.replace(/\/+$/, '').slice(0, 200);
  }
  str('ollamaModel', 120);
  str('cleanupPrompt', 8000);
  out.cleanupTimeoutMs = clampNumber(input.cleanupTimeoutMs, 5000, 300000, base.cleanupTimeoutMs);

  if (input.inputDevice === null || Number.isInteger(input.inputDevice)) {
    out.inputDevice = input.inputDevice;
  }
  bool('copyToClipboard');
  bool('autoPaste');
  out.pasteDelayMs = clampNumber(input.pasteDelayMs, 0, 2000, base.pasteDelayMs);
  bool('playSounds');
  bool('showHud');

  bool('launchAtLogin');
  bool('keepTranscripts');

  return out;
}

function read() {
  if (cache) return cache;
  try {
    const text = fs.readFileSync(settingsPath(), 'utf8');
    cache = sanitize(JSON.parse(text));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('[wisp] settings unreadable, using defaults:', err.message);
    }
    cache = { ...DEFAULTS };
  }
  return cache;
}

function write(patch) {
  const next = sanitize(patch, read());
  cache = next;
  const file = settingsPath();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  } catch (err) {
    console.error('[wisp] could not save settings:', err.message);
  }
  return next;
}

function reset() {
  cache = null;
  resolvedPath = null;
  return write({ ...DEFAULTS });
}

module.exports = {
  DEFAULTS,
  WHISPER_MODELS,
  TRIGGER_MODES,
  dataDir,
  settingsPath,
  read,
  write,
  reset,
  sanitize,
};
