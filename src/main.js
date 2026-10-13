'use strict';

/**
 * Wisp — local dictation for macOS.
 *
 * Wiring:
 *   trigger  ->  Python worker (mic + Whisper)  ->  Ollama/Qwen cleanup  ->  clipboard
 *
 * This file owns the state machine. The worker is a child process, Qwen is an
 * HTTP call, and everything else is presentation.
 */

const { app, BrowserWindow, Menu, Tray, clipboard, globalShortcut, ipcMain, nativeImage, screen, shell, systemPreferences } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const settingsStore = require('./lib/settings');
const { Worker } = require('./lib/worker');
const { HoldTrigger, HOLD_KEYS } = require('./lib/trigger');
const qwen = require('./lib/qwen');

// Outside Electron, require('electron') hands back the path to the binary and
// every API is undefined. The usual cause is ELECTRON_RUN_AS_NODE being set in
// the environment, which makes the binary behave like plain Node.
if (!app || typeof app.whenReady !== 'function') {
  console.error(
    '[wisp] Wisp must be launched with Electron, not Node.\n' +
      '       If ELECTRON_RUN_AS_NODE is set in this shell, clear it first:\n\n' +
      '         env -u ELECTRON_RUN_AS_NODE npm start\n'
  );
  process.exit(1);
}

const PROJECT_ROOT = path.join(__dirname, '..');
// Packaged builds keep the Python worker and its virtualenv outside the asar
// archive, because Python cannot read from one.
const RESOURCE_ROOT = app.isPackaged ? process.resourcesPath : PROJECT_ROOT;
const HUD_WIDTH = 268;
const HUD_HEIGHT = 56;
const HUD_BOTTOM_OFFSET = 96;
const MIN_CLIP_SECONDS = 0.35;
const HISTORY_LIMIT = 50;

// ------------------------------------------------------------------- state

let worker = null;
let tray = null;
let settingsWindow = null;
let hudWindow = null;
let holdTrigger = null;
let hudHideTimer = null;

const state = {
  phase: 'idle', // idle | recording | transcribing | error
  recordingMode: null, // hold | latch | toggle
  latchArmed: false,
  holdStartedAt: 0,
  hint: '',
  worker: { ready: false, pid: null, error: null },
  model: { state: 'unloaded', name: settingsStore.DEFAULTS.whisperModel, loadSeconds: null },
  ollama: { state: 'unknown', models: [], error: null },
  accessibility: { trusted: false },
  holdHookActive: false,
  mic: { ok: null, device: null },
  lastResult: null,
};

let history = [];

// --------------------------------------------------------------- utilities

// Set by the self test so an automated run makes no sound at all.
let suppressSounds = false;

function playSound(name) {
  if (suppressSounds || !settingsStore.read().playSounds) return;
  try {
    spawn('afplay', [`/System/Library/Sounds/${name}.aiff`], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    /* sound is a nicety, never fatal */
  }
}

/**
 * Electron's clipboard API is promise-based, following the W3C
 * `navigator.clipboard` shape. Copying is the entire point of Wisp, so this
 * reports whether the text verifiably landed rather than assuming it did.
 */
async function copyToClipboard(text) {
  try {
    await clipboard.writeText(text);
    return (await clipboard.readText()) === text;
  } catch (err) {
    console.warn('[wisp] clipboard write failed:', err.message);
    return false;
  }
}

async function readClipboard() {
  try {
    return await clipboard.readText();
  } catch {
    return '';
  }
}

function historyFile() {
  return path.join(settingsStore.dataDir(), 'history.json');
}

function loadHistory() {
  try {
    const parsed = JSON.parse(fs.readFileSync(historyFile(), 'utf8'));
    if (Array.isArray(parsed)) history = parsed.slice(0, HISTORY_LIMIT);
  } catch {
    history = [];
  }
}

function saveHistory() {
  try {
    fs.mkdirSync(settingsStore.dataDir(), { recursive: true });
    fs.writeFileSync(historyFile(), `${JSON.stringify(history.slice(0, HISTORY_LIMIT), null, 2)}\n`, 'utf8');
  } catch (err) {
    console.error('[wisp] could not save history:', err.message);
  }
}

function pushHistory(entry) {
  if (!settingsStore.read().keepTranscripts) return;
  history.unshift({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, at: new Date().toISOString(), ...entry });
  history = history.slice(0, HISTORY_LIMIT);
  saveHistory();
}

function deviceName(index) {
  if (index === null || index === undefined) return 'System default';
  const found = cachedDevices.find((d) => d.index === index);
  return found ? found.name : 'System default';
}

let cachedDevices = [];

// ------------------------------------------------------------- tray icons

function trayIcon(kind) {
  const file = path.join(PROJECT_ROOT, 'assets', `tray${kind}Template.png`);
  if (!fs.existsSync(file)) return nativeImage.createEmpty();
  const image = nativeImage.createFromPath(file);
  image.setTemplateImage(true);
  return image;
}

function trayTitle() {
  if (state.phase === 'recording') return 'Recording';
  if (state.phase === 'transcribing') return 'Transcribing';
  if (state.worker.error) return 'Capture engine failed';
  return 'Idle';
}

function rebuildTray() {
  if (!tray) return;
  const iconKind = state.phase === 'recording' ? 'Recording' : state.phase === 'transcribing' ? 'Busy' : 'Idle';
  tray.setImage(trayIcon(iconKind));
  tray.setToolTip(`Wisp — ${trayTitle()}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Wisp — ${trayTitle()}`, enabled: false },
      { type: 'separator' },
      {
        label: state.phase === 'recording' ? 'Stop dictation' : 'Start dictation',
        enabled: state.phase !== 'transcribing',
        click: () => (state.phase === 'recording' ? stopRecording('tray') : startRecording('tray')),
      },
      {
        label: 'Cancel recording',
        enabled: state.phase === 'recording',
        click: () => cancelRecording(),
      },
      { type: 'separator' },
      {
        label: 'Copy last transcript',
        enabled: Boolean(state.lastResult && state.lastResult.text),
        click: () => {
          if (state.lastResult?.text) copyToClipboard(state.lastResult.text);
        },
      },
      {
        label: 'Recent transcripts',
        enabled: history.length > 0,
        submenu: history.slice(0, 10).map((entry) => ({
          label: entry.text.length > 58 ? `${entry.text.slice(0, 58)}…` : entry.text,
          click: () => copyToClipboard(entry.text),
        })),
      },
      { type: 'separator' },
      { label: 'Settings…', accelerator: 'Command+,', click: () => openSettingsWindow() },
      {
        label: 'Launch at login',
        type: 'checkbox',
        checked: settingsStore.read().launchAtLogin,
        click: (item) => {
          settingsStore.write({ launchAtLogin: item.checked });
          applyLoginItem();
          broadcast();
        },
      },
      { type: 'separator' },
      { label: 'Quit Wisp', accelerator: 'Command+Q', click: () => app.quit() },
    ])
  );
}

// ------------------------------------------------------------ status text

function hintFor() {
  if (state.worker.error) return `Capture engine problem: ${state.worker.error}`;
  if (state.phase === 'error') return state.hint;
  if (!state.accessibility.trusted && settingsStore.read().triggerMode !== 'toggle') {
    return 'The hold key needs Accessibility access — use the button above, then restart Wisp.';
  }
  if (state.ollama.state === 'error' && settingsStore.read().cleanupEnabled) {
    return 'Ollama is not reachable, so transcripts are copied unedited. Start it with: ollama serve';
  }
  if (state.worker.ready && state.model.state === 'loaded') return 'Ready. Hold your key and speak.';
  if (state.model.state === 'loading') return `Loading ${state.model.name.split('/').pop()}… the first run downloads the model.`;
  return state.hint;
}

function snapshot() {
  return {
    phase: state.phase,
    latchArmed: state.latchArmed,
    hint: hintFor(),
    worker: { ...state.worker },
    model: { ...state.model },
    ollama: { ...state.ollama },
    accessibility: { ...state.accessibility },
    mic: { ...state.mic },
    lastResult: state.lastResult,
    history: history.map((entry) => ({
      id: entry.id,
      time: new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      text: entry.text,
      raw: entry.raw,
      edited: entry.edited,
    })),
    settings: settingsStore.read(),
    whisperModels: settingsStore.WHISPER_MODELS,
    holdKeys: HOLD_KEYS,
    dataDir: settingsStore.dataDir(),
    version: app.getVersion(),
  };
}

/** Sends to a window's renderer, tolerating frames that are mid-teardown. */
function safeSend(win, payload) {
  if (!win || win.isDestroyed()) return;
  const contents = win.webContents;
  if (!contents || contents.isDestroyed() || contents.isCrashed()) return;
  try {
    contents.send('wisp:event', payload);
  } catch {
    /* the frame can be disposed between the check and the send */
  }
}

function broadcast() {
  const payload = { type: 'state', state: snapshot() };
  for (const win of BrowserWindow.getAllWindows()) safeSend(win, payload);
  rebuildTray();
}

function sendLevel(rms) {
  const payload = { type: 'level', rms };
  safeSend(settingsWindow, payload);
  if (hudWindow && !hudWindow.isDestroyed() && hudWindow.isVisible()) safeSend(hudWindow, payload);
}

function setPhase(phase, hint = '') {
  state.phase = phase;
  state.hint = hint;
  updateHud();
  broadcast();
}

// ------------------------------------------------------------------- HUD

function createHudWindow() {
  hudWindow = new BrowserWindow({
    width: HUD_WIDTH,
    height: HUD_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    hasShadow: false,
    skipTaskbar: true,
    acceptFirstMouse: false,
    backgroundColor: '#00000000',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  hudWindow.setIgnoreMouseEvents(true);
  hudWindow.setAlwaysOnTop(true, 'screen-saver');
  hudWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  hudWindow.loadFile(path.join(__dirname, 'hud', 'index.html'));
  return hudWindow;
}

function positionHud() {
  if (!hudWindow || hudWindow.isDestroyed()) return;
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { x, y, width, height } = display.workArea;
  hudWindow.setBounds({
    x: Math.round(x + (width - HUD_WIDTH) / 2),
    y: Math.round(y + height - HUD_HEIGHT - HUD_BOTTOM_OFFSET),
    width: HUD_WIDTH,
    height: HUD_HEIGHT,
  });
}

function updateHud() {
  if (!hudWindow || hudWindow.isDestroyed()) return;
  if (!settingsStore.read().showHud) {
    hudWindow.hide();
    return;
  }
  const show = state.phase !== 'idle';
  if (show) {
    positionHud();
    safeSend(hudWindow, { type: 'state', state: snapshot() });
    if (!hudWindow.isVisible()) hudWindow.showInactive();
  } else {
    // Let the previous result linger briefly before disappearing.
    clearTimeout(hudHideTimer);
    hudHideTimer = setTimeout(() => {
      if (hudWindow && !hudWindow.isDestroyed() && state.phase === 'idle') hudWindow.hide();
    }, 1400);
  }
}

// -------------------------------------------------------- settings window

function openSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 940,
    height: 800,
    minWidth: 620,
    minHeight: 520,
    title: 'Wisp Settings',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#16171b',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  settingsWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  settingsWindow.on('closed', () => {
    settingsWindow = null;
    syncDockVisibility();
  });
  // Accessibility can be granted while Wisp is running; pick it up on return
  // so the hold key starts working without a manual restart.
  settingsWindow.on('focus', () => {
    const trusted = systemPreferences.isTrustedAccessibilityClient(false);
    if (trusted !== state.accessibility.trusted) {
      registerTriggers();
      broadcast();
    }
  });
  settingsWindow.webContents.on('did-finish-load', () => {
    safeSend(settingsWindow, { type: 'state', state: snapshot() });
  });
  syncDockVisibility();
}

/** Menu-bar apps hide their Dock icon while no real window is open. */
function syncDockVisibility() {
  if (!app.dock) return;
  const visible = BrowserWindow.getAllWindows().some(
    (win) => win !== hudWindow && !win.isDestroyed() && win.isVisible()
  );
  if (visible) app.dock.show();
  else app.dock.hide();
}

// ---------------------------------------------------------------- triggers

function registerTriggers({ report = false } = {}) {
  const config = settingsStore.read();
  const problems = [];

  // Read the trust state before touching the native hook. Starting it while
  // untrusted makes macOS raise a permission dialog, so calling this on every
  // launch and settings change would nag the user repeatedly.
  state.accessibility.trusted = systemPreferences.isTrustedAccessibilityClient(false);

  globalShortcut.unregisterAll();
  if (config.triggerMode === 'toggle' || config.triggerMode === 'both') {
    try {
      const ok = globalShortcut.register(config.toggleShortcut, () => onToggleShortcut());
      if (!ok) problems.push(`macOS refused the shortcut ${config.toggleShortcut} (already taken?)`);
    } catch (err) {
      problems.push(`invalid shortcut ${config.toggleShortcut}: ${err.message}`);
    }
  }

  if (holdTrigger) holdTrigger.stop();
  state.holdHookActive = false;
  if (config.triggerMode === 'hold' || config.triggerMode === 'both') {
    holdTrigger = holdTrigger || new HoldTrigger();
    if (!holdTrigger.__wired) {
      holdTrigger.on('down', () => onHoldDown());
      holdTrigger.on('up', () => onHoldUp());
      holdTrigger.__wired = true;
    }

    if (!state.accessibility.trusted) {
      problems.push('the hold key needs Accessibility access — grant it, then restart Wisp');
    } else {
      const result = holdTrigger.start([config.holdKey]);
      if (!result.ok) problems.push(result.error);
      else state.holdHookActive = true;
    }
  }

  const error = problems.length ? problems.join('; ') : null;
  if (report) return { error };
  if (error) console.error('[wisp] trigger problem:', error);
  return { error };
}

function onHoldDown() {
  if (state.phase === 'transcribing') return;
  if (state.phase === 'recording') {
    if (state.latchArmed) stopRecording('latch-release');
    return;
  }
  state.holdStartedAt = Date.now();
  startRecording('hold');
}

function onHoldUp() {
  if (state.phase !== 'recording' || state.recordingMode !== 'hold') return;
  const held = Date.now() - state.holdStartedAt;
  const latchWindow = settingsStore.read().holdLatchMs;
  if (latchWindow > 0 && held < latchWindow) {
    // A quick tap meant "stay on until I tap again".
    state.recordingMode = 'latch';
    state.latchArmed = true;
    broadcast();
    return;
  }
  stopRecording('hold-release');
}

function onToggleShortcut() {
  if (state.phase === 'recording') stopRecording('toggle');
  else if (state.phase === 'idle') startRecording('toggle');
}

// -------------------------------------------------------------- dictation

function ensureWorker(timeoutMs = 25000) {
  if (worker && worker.ready) return Promise.resolve(true);
  if (!worker) return Promise.reject(new Error('capture engine is not available'));
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      if (worker.ready) return resolve(true);
      if (worker.lastError) return reject(new Error(worker.lastError));
      if (Date.now() - started > timeoutMs) return reject(new Error('capture engine did not start in time'));
      setTimeout(check, 150);
    };
    check();
  });
}

async function startRecording(reason) {
  if (state.phase !== 'idle') return;
  try {
    await ensureWorker();
  } catch (err) {
    setPhase('error', err.message);
    playSound('Basso');
    setTimeout(() => setPhase('idle'), 2500);
    return;
  }

  const config = settingsStore.read();
  state.recordingMode = reason === 'toggle' ? 'toggle' : 'hold';
  state.latchArmed = false;
  // Keep the key-down timestamp when the hold trigger already recorded one:
  // latch timing must measure from the physical press, not from here.
  if (!state.holdStartedAt) state.holdStartedAt = Date.now();

  try {
    await worker.request('start', {
      device: config.inputDevice,
      max_seconds: config.maxSeconds,
      silence_floor: config.silenceFloor,
    });
  } catch (err) {
    setPhase('error', `Could not open the microphone: ${err.message}`);
    playSound('Basso');
    setTimeout(() => setPhase('idle'), 3000);
    return;
  }

  playSound('Tink');
  setPhase('recording');
}

async function stopRecording(trigger) {
  if (state.phase !== 'recording') return;
  const elapsed = (Date.now() - state.holdStartedAt) / 1000;
  const wasLatched = state.latchArmed;
  state.latchArmed = false;
  state.recordingMode = null;
  state.holdStartedAt = 0;

  // A stray tap with no real audio behind it: drop it silently.
  if (!wasLatched && trigger !== 'toggle' && trigger !== 'tray' && elapsed < MIN_CLIP_SECONDS) {
    try {
      await worker.request('cancel', {}, 5000);
    } catch {
      /* ignore */
    }
    playSound('Pop');
    setPhase('idle');
    return;
  }

  setPhase('transcribing');
  playSound('Pop');

  let result;
  try {
    result = await worker.request('stop', {}, 5 * 60 * 1000);
  } catch (err) {
    setPhase('error', `Transcription failed: ${err.message}`);
    setTimeout(() => setPhase('idle'), 3000);
    return;
  }

  const raw = (result.text || '').trim();
  state.mic.ok = true;
  state.mic.device = result.device || deviceName(settingsStore.read().inputDevice);

  if (!raw) {
    state.lastResult = { text: '', raw: '', edited: false, reason: result.skipped || 'no-speech' };
    setPhase('idle', result.skipped === 'silence' ? 'Nothing heard.' : 'Nothing was transcribed.');
    setTimeout(() => setPhase('idle'), 1200);
    return;
  }

  await finishTranscript(raw, {
    transcriptMs: Math.round((result.elapsed || 0) * 1000),
    audioSeconds: result.duration,
  });
}

/**
 * The tail every transcript goes through: polish it, copy it, remember it,
 * report it. Shared so a transcript can arrive from the microphone or from an
 * audio file without duplicating the pipeline.
 */
async function finishTranscript(raw, meta = {}) {
  const config = settingsStore.read();
  const cleanup = await qwen.clean(raw, config);
  const text = cleanup.text;

  const copied = config.copyToClipboard ? await copyToClipboard(text) : false;
  if (config.copyToClipboard && !copied) {
    console.warn('[wisp] clipboard write did not stick; the transcript is still in Recent transcripts.');
  }

  state.lastResult = {
    text,
    raw,
    edited: Boolean(cleanup.edited),
    copied,
    reason: cleanup.reason,
    transcriptMs: meta.transcriptMs,
    audioSeconds: meta.audioSeconds,
  };
  pushHistory({
    text,
    raw,
    edited: Boolean(cleanup.edited),
    audioSeconds: meta.audioSeconds,
    transcriptMs: meta.transcriptMs,
  });

  if (!config.copyToClipboard) setPhase('idle', 'Transcribed.');
  else if (copied) setPhase('idle', 'Copied to clipboard.');
  else setPhase('idle', 'Transcribed, but the clipboard refused the write.');

  return state.lastResult;
}

async function cancelRecording() {
  if (state.phase !== 'recording') return;
  state.latchArmed = false;
  state.recordingMode = null;
  try {
    await worker.request('cancel', {}, 5000);
  } catch {
    /* ignore */
  }
  setPhase('idle', 'Cancelled.');
}

async function warmModel() {
  if (!worker) return;
  const config = settingsStore.read();
  state.model.state = 'loading';
  state.model.name = config.whisperModel;
  broadcast();
  try {
    const info = await worker.request(
      'warm',
      {
        model: config.whisperModel,
        language: config.language === 'auto' ? null : config.language,
        vocabulary: config.vocabulary,
      },
      30 * 60 * 1000
    );
    state.model.state = 'loaded';
    state.model.loadSeconds = info.elapsed;
  } catch (err) {
    state.model.state = 'unloaded';
    state.hint = `Model failed to load: ${err.message}`;
  }
  broadcast();
}

async function checkOllama() {
  const config = settingsStore.read();
  state.ollama.state = 'checking';
  broadcast();
  try {
    const models = await qwen.listModels({ url: config.ollamaUrl });
    state.ollama = {
      state: 'ok',
      models,
      error: models.includes(config.ollamaModel) ? null : `model ${config.ollamaModel} is not pulled yet`,
    };
  } catch (err) {
    state.ollama = { state: 'error', models: [], error: err.message };
  }
  broadcast();
  return snapshot().ollama;
}

async function refreshDevices() {
  if (!worker) return [];
  try {
    const info = await worker.request('devices', {}, 15000);
    cachedDevices = info.devices || [];
    const selected = settingsStore.read().inputDevice;
    const match = selected === null ? cachedDevices.find((d) => d.is_default) : cachedDevices.find((d) => d.index === selected);
    if (match) {
      state.mic.device = match.name;
      state.mic.ok = true;
    } else if (!cachedDevices.length) {
      state.mic.ok = false;
      state.mic.device = 'no input device found';
    }
    broadcast();
    return cachedDevices;
  } catch {
    return [];
  }
}

function applyLoginItem() {
  const config = settingsStore.read();
  try {
    app.setLoginItemSettings({ openAtLogin: config.launchAtLogin, openAsHidden: true });
  } catch (err) {
    console.error('[wisp] could not update login item:', err.message);
  }
}

// ---------------------------------------------------------------- selftest

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'ignore' });
    child.on('exit', resolve);
    child.on('error', resolve);
  });
}

/**
 * Verifies the whole stack through the running app: Whisper -> Qwen ->
 * clipboard -> history, using the same functions the trigger calls.
 *
 * Speech is rendered to a WAV file with `say -o` and transcribed from disk, so
 * running this never makes noise. Pass --with-speaker to additionally exercise
 * the live microphone, which does play audio out loud.
 */
async function runSelfTest() {
  const withSpeaker = process.argv.includes('--with-speaker');
  const results = [];
  const check = (name, ok, detail = '') => {
    results.push({ name, ok });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  };
  const skip = (name, why) => console.log(`  \x1b[33mSKIP\x1b[0m  ${name}${why ? ` (${why})` : ''}`);

  console.log('\nWisp self test');
  console.log('(writes to the system clipboard; plays no audio unless --with-speaker)\n');
  suppressSounds = true;

  const deadline = Date.now() + 10 * 60 * 1000;
  while ((!state.worker.ready || state.model.state !== 'loaded') && Date.now() < deadline) {
    await sleep(250);
  }
  check('capture worker is ready', state.worker.ready, state.worker.error || `pid ${state.worker.pid}`);
  check('Whisper model is warm', state.model.state === 'loaded', `${state.model.name} in ${state.model.loadSeconds}s`);

  // The clipboard is the product, so probe it up front: an environment that
  // blocks the pasteboard should read as a skip, not a false failure.
  const clipboardWorks = await copyToClipboard('WISP-CLIPBOARD-PROBE');
  if (clipboardWorks) console.log('  \x1b[32mPASS\x1b[0m  system clipboard is reachable');
  else skip('system clipboard is reachable', 'pasteboard blocked in this environment');

  const spoken = 'Book the studio for Monday at nine am, scratch that, Tuesday at eleven am.';
  const historyBefore = history.length;

  if (!withSpeaker) {
    // Open the microphone, capture a moment of room tone, and close it again.
    // This drives the full live-capture path without making any sound.
    try {
      await startRecording('selftest');
      check('microphone opened', state.phase === 'recording', state.mic.device || '');
      await sleep(600);
      await stopRecording('selftest');
      check('live capture path completes cleanly', state.phase === 'idle', state.mic.device || '');
    } catch (err) {
      check('live capture path completes cleanly', false, err.message);
    }
  }

  if (withSpeaker) {
    await startRecording('selftest');
    check('live recording started', state.phase === 'recording', `phase ${state.phase}`);
    await run('say', ['-r', '165', spoken]); // audible, on purpose
    await sleep(800);
    await stopRecording('selftest');
    const captured = (state.lastResult?.raw || '').trim();
    check('microphone audio was transcribed', Boolean(captured), captured ? `"${captured}"` : 'empty transcript');
  } else {
    const wav = path.join(PROJECT_ROOT, 'tmp', 'selftest.wav');
    fs.mkdirSync(path.dirname(wav), { recursive: true });
    await run('say', ['-o', wav, '--data-format=LEI16@16000', '--file-format=WAVE', spoken]);
    if (!fs.existsSync(wav)) {
      check('speech rendered to a file', false, `say did not write ${wav}`);
    } else {
      const out = await worker.request('transcribe', { path: wav }, 10 * 60 * 1000);
      const raw = (out.text || '').trim();
      check('Whisper transcribed the speech file', Boolean(raw), raw ? `"${raw}"` : 'empty transcript');
      // Everything downstream of capture runs exactly as a real dictation does.
      await finishTranscript(raw, {
        transcriptMs: Math.round((out.elapsed || 0) * 1000),
        audioSeconds: out.duration,
      });
    }
  }

  const result = state.lastResult || {};
  check(
    'Qwen applied the spoken correction',
    Boolean(result.text) && /tuesday/i.test(result.text) && !/monday/i.test(result.text),
    `"${result.text}"`
  );

  if (clipboardWorks) {
    const onClipboard = await readClipboard();
    check('transcript reached the clipboard', onClipboard.length > 0 && onClipboard === result.text, `"${onClipboard}"`);
  } else {
    skip('transcript reached the clipboard');
  }
  check('history recorded the transcript', history.length > historyBefore, `${history.length - historyBefore} new entry(ies)`);

  const failures = results.filter((r) => !r.ok);
  console.log(
    `\n${failures.length === 0 ? 'All checks passed' : `${failures.length} check(s) failed`} (${results.length - failures.length}/${results.length})\n`
  );
  return failures.length === 0;
}

// -------------------------------------------------------------------- IPC

function registerIpc() {
  ipcMain.handle('wisp:get-state', () => snapshot());
  ipcMain.handle('wisp:get-settings', () => settingsStore.read());

  ipcMain.handle('wisp:save-settings', async (_event, patch) => {
    const before = settingsStore.read();
    const after = settingsStore.write(patch || {});

    let error = null;
    const triggersChanged =
      before.triggerMode !== after.triggerMode ||
      before.holdKey !== after.holdKey ||
      before.toggleShortcut !== after.toggleShortcut;
    if (triggersChanged) {
      error = registerTriggers({ report: true }).error;
    }
    if (before.whisperModel !== after.whisperModel || before.language !== after.language || before.vocabulary !== after.vocabulary) {
      warmModel();
    }
    if (before.launchAtLogin !== after.launchAtLogin) applyLoginItem();
    if (before.inputDevice !== after.inputDevice) {
      state.mic.device = deviceName(after.inputDevice);
    }
    if (before.showHud !== after.showHud) updateHud();

    broadcast();
    return { settings: after, error };
  });

  ipcMain.handle('wisp:reset-settings', () => {
    const after = settingsStore.reset();
    registerTriggers();
    applyLoginItem();
    warmModel();
    broadcast();
    return { settings: after };
  });

  ipcMain.handle('wisp:list-devices', async () => ({ devices: await refreshDevices() }));
  ipcMain.handle('wisp:check-ollama', () => checkOllama());
  ipcMain.handle('wisp:reload-model', async () => {
    await warmModel();
    return snapshot().model;
  });

  ipcMain.handle('wisp:test-cleanup', async (_event, text) => {
    const result = await qwen.clean(text, settingsStore.read());
    return { text: result.text, reason: result.reason, edited: result.edited };
  });

  ipcMain.handle('wisp:start', () => startRecording('ipc'));
  ipcMain.handle('wisp:stop', () => stopRecording('ipc'));
  ipcMain.handle('wisp:cancel', () => cancelRecording());
  ipcMain.handle('wisp:copy', (_event, text) => copyToClipboard(String(text || '')));
  ipcMain.handle('wisp:clear-history', () => {
    history = [];
    saveHistory();
    broadcast();
    return true;
  });

  ipcMain.handle('wisp:open-accessibility', () => {
    systemPreferences.isTrustedAccessibilityClient(true); // shows the system prompt when possible
    shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
    return true;
  });

  ipcMain.handle('wisp:open-external', (_event, url) => {
    if (String(url).startsWith('file://')) shell.openPath(decodeURIComponent(String(url).slice('file://'.length)));
    else shell.openExternal(String(url));
    return true;
  });

  ipcMain.handle('wisp:quit', () => app.quit());
}

// --------------------------------------------------------------- lifecycle

function wireWorker() {
  worker = new Worker({ projectRoot: RESOURCE_ROOT });

  worker.on('ready', (msg) => {
    state.worker.ready = true;
    state.worker.pid = msg.pid;
    state.worker.error = null;
    refreshDevices();
    warmModel();
    broadcast();
  });

  worker.on('level', (msg) => sendLevel(msg.rms));

  worker.on('recording', (msg) => {
    if (msg.state === 'started') {
      state.mic.device = msg.device || state.mic.device;
      state.mic.ok = true;
    }
  });

  worker.on('autostop', () => {
    state.hint = 'Reached the maximum clip length; transcribing.';
  });

  worker.on('failed', (message) => {
    state.worker.ready = false;
    state.worker.error = message;
    broadcast();
  });

  worker.on('exit', () => {
    state.worker.ready = false;
    state.worker.pid = null;
    if (state.phase === 'recording') {
      state.phase = 'idle';
      state.latchArmed = false;
    }
    broadcast();
  });

  worker.on('log', (line) => {
    if (process.argv.includes('--dev')) console.log(`[worker] ${line}`);
  });

  worker.start();
}

// Electron resolves app.getPath('userData') from the app name; allow an
// override so the app can run entirely out of a project folder. Every writable
// location moves with it, which also keeps automated runs off the user's
// Library directory.
if (process.env.WISP_DATA_DIR) {
  app.setPath('userData', process.env.WISP_DATA_DIR);
  for (const [key, sub] of [
    ['sessionData', 'session'],
    ['cache', 'cache'],
    ['crashDumps', 'crash'],
    ['logs', 'logs'],
  ]) {
    try {
      app.setPath(key, path.join(process.env.WISP_DATA_DIR, sub));
    } catch {
      /* not every path is settable on every platform */
    }
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => openSettingsWindow());

  app.whenReady().then(async () => {
    loadHistory();
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        { role: 'appMenu' },
        { role: 'editMenu' },
        {
          label: 'Dictation',
          submenu: [
            { label: 'Start / Stop', accelerator: 'Command+Shift+Space', click: () => onToggleShortcut() },
            { label: 'Cancel', accelerator: 'Escape', click: () => cancelRecording() },
          ],
        },
        { role: 'windowMenu' },
      ])
    );

    createHudWindow();
    wireWorker();
    registerIpc();
    registerTriggers();
    applyLoginItem();

    tray = new Tray(trayIcon('Idle'));
    tray.setToolTip('Wisp');
    rebuildTray();

    state.accessibility.trusted = systemPreferences.isTrustedAccessibilityClient(false);
    syncDockVisibility();
    checkOllama();

    if (process.argv.includes('--settings')) openSettingsWindow();

    if (process.argv.includes('--selftest')) {
      runSelfTest()
        .then((ok) => app.exit(ok ? 0 : 1))
        .catch((err) => {
          console.error('[selftest] crashed:', err);
          app.exit(1);
        });
    }
  });

  // A menu-bar app stays alive with no windows.
  app.on('window-all-closed', () => {});

  app.on('activate', () => openSettingsWindow());

  app.on('before-quit', async () => {
    globalShortcut.unregisterAll();
    if (holdTrigger) holdTrigger.stop();
    if (worker) await worker.stop();
  });
}
