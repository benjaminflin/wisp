'use strict';

/**
 * Settings window.
 *
 * The main process owns all state; this file renders a snapshot of it and
 * sends intents back. Nothing here talks to the worker or Ollama directly.
 */

const el = (id) => document.getElementById(id);

let snapshot = null;
let settings = null;
let capturingShortcut = false;
let saveTimer = null;

// --------------------------------------------------------------- shortcuts

const MOD_SYMBOLS = { Command: '⌘', Control: '⌃', Alt: '⌥', Shift: '⇧' };
const KEY_SYMBOLS = {
  Space: 'Space',
  Up: '↑',
  Down: '↓',
  Left: '←',
  Right: '→',
  Return: '↩',
  Enter: '↩',
  Tab: '⇥',
  Escape: '⎋',
  Backspace: '⌫',
  Delete: '⌦',
};

function prettyShortcut(accelerator) {
  if (!accelerator) return '';
  return String(accelerator)
    .split('+')
    .map((part) => MOD_SYMBOLS[part] || KEY_SYMBOLS[part] || part)
    .join('');
}

/** Translates a DOM key event into an Electron accelerator key name. */
function acceleratorKey(event) {
  const { key, code } = event;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(key)) return key;
  if (key === ' ') return 'Space';
  const map = {
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Enter: 'Return',
    Escape: 'Escape',
    Tab: 'Tab',
    Backspace: 'Backspace',
    Delete: 'Delete',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
  };
  if (map[key]) return map[key];
  if (key.length === 1) return key.toUpperCase();
  return null;
}

function setupShortcutCapture() {
  const input = el('toggleShortcut');

  input.addEventListener('focus', () => {
    capturingShortcut = true;
    input.classList.add('capturing');
    input.value = 'Press keys…';
  });

  input.addEventListener('blur', () => {
    capturingShortcut = false;
    input.classList.remove('capturing');
    input.value = prettyShortcut(settings.toggleShortcut);
  });

  input.addEventListener('keydown', (event) => {
    if (!capturingShortcut) return;
    event.preventDefault();

    const modifiers = [];
    if (event.metaKey) modifiers.push('Command');
    if (event.ctrlKey) modifiers.push('Control');
    if (event.altKey) modifiers.push('Alt');
    if (event.shiftKey) modifiers.push('Shift');

    const key = acceleratorKey(event);
    if (!key) {
      input.value = modifiers.map((m) => MOD_SYMBOLS[m]).join('') || 'Press keys…';
      return;
    }
    if (!modifiers.length) {
      input.value = 'Needs ⌘ ⌃ ⌥ or ⇧';
      return;
    }
    const accelerator = [...modifiers, key].join('+');
    input.value = prettyShortcut(accelerator);
    input.blur();
    persist({ toggleShortcut: accelerator });
  });
}

// ------------------------------------------------------------------ saving

function persist(patch) {
  clearTimeout(saveTimer);
  return new Promise((resolve) => {
    saveTimer = setTimeout(async () => {
      const result = await window.wisp.saveSettings(patch);
      settings = result.settings;
      if (result.error) {
        flashHint(result.error);
        render(snapshot);
      }
      resolve(result);
    }, 120);
  });
}

function flashHint(message) {
  const hint = el('statusHint');
  hint.textContent = message;
  hint.style.color = 'var(--bad)';
  setTimeout(() => {
    hint.style.color = '';
  }, 4000);
}

/** Binds a form control to a settings key. */
function bind(id, key, { type = 'value', transform } = {}) {
  const node = el(id);
  const eventName = type === 'checkbox' ? 'change' : type === 'input' ? 'input' : 'change';
  node.addEventListener(eventName, () => {
    let value;
    if (type === 'checkbox') value = node.checked;
    else if (type === 'number') value = Number(node.value);
    else value = node.value;
    if (transform) value = transform(value);
    persist({ [key]: value });
  });
}

// ----------------------------------------------------------------- render

function setDot(id, level) {
  el(id).className = `dot${level ? ` dot--${level}` : ''}`;
}

function render(next) {
  if (next) snapshot = next;
  if (!snapshot) return;
  const s = snapshot;
  settings = s.settings;

  // top bar
  const pill = el('pill');
  const phaseLabels = {
    idle: 'Idle',
    recording: s.latchArmed ? 'Latched' : 'Recording',
    transcribing: 'Transcribing',
    error: 'Problem',
  };
  pill.textContent = phaseLabels[s.phase] || s.phase;
  pill.className = `pill pill--${
    s.phase === 'recording' ? 'recording' : s.phase === 'transcribing' ? 'working' : s.phase === 'error' ? 'error' : 'idle'
  }`;
  const toggle = el('btnToggle');
  const busy = s.phase === 'recording' || s.phase === 'transcribing';
  toggle.textContent = s.phase === 'recording' ? 'Stop' : s.phase === 'transcribing' ? 'Working…' : 'Start dictating';
  toggle.disabled = s.phase === 'transcribing';

  // status rows
  setDot('dotWorker', s.worker.ready ? 'good' : s.worker.error ? 'bad' : 'warn');
  el('statusWorker').textContent = s.worker.ready
    ? `ready · pid ${s.worker.pid ?? '—'}`
    : s.worker.error || 'starting…';

  const modelName = s.model.name.split('/').pop();
  const downloadPct = s.model.progress && s.model.progress.pct;
  setDot('dotModel', s.model.state === 'loaded' ? 'good' : s.model.state === 'unloaded' ? '' : 'warn');
  el('statusModel').textContent =
    s.model.state === 'loaded'
      ? `${modelName} · loaded in ${s.model.loadSeconds ?? '?'}s`
      : s.model.state === 'downloading'
        ? `downloading ${modelName}${downloadPct != null ? ` — ${downloadPct}%` : '…'}`
        : s.model.state === 'loading'
          ? `loading ${modelName}…`
          : 'not loaded';

  setDot('dotOllama', s.ollama.state === 'ok' ? 'good' : s.ollama.state === 'error' ? 'bad' : 'warn');
  el('statusOllama').textContent =
    s.ollama.state === 'ok'
      ? `${s.settings.ollamaModel} · ${s.ollama.models.length} model(s)`
      : s.ollama.state === 'checking'
        ? 'checking…'
        : s.ollama.state === 'error'
          ? s.ollama.error || 'unreachable'
          : 'not checked';

  const holdMode = s.settings.triggerMode !== 'toggle';
  setDot(
    'dotAccessibility',
    !holdMode ? '' : s.accessibility.trusted ? (s.holdHookActive ? 'good' : 'warn') : 'bad'
  );
  el('statusAccessibility').textContent = !holdMode
    ? 'not needed in tap mode'
    : s.accessibility.trusted
      ? s.holdHookActive
        ? 'granted — hold key is live'
        : 'granted, but the input hook is not running'
      : 'not granted — the hold key is disabled';

  setDot('dotMic', s.mic.ok === null ? '' : s.mic.ok ? 'good' : 'bad');
  el('statusMic').textContent = s.mic.device || 'not tested';
  el('statusHint').textContent = s.hint || '';

  const promptHint = el('cleanupPromptHint');
  if (promptHint) {
    promptHint.textContent = String(s.settings.cleanupPrompt || '').trim()
      ? 'Using your custom prompt. “Reset to default” restores the built-in wording.'
      : 'This is the built-in prompt. Edit it to make it yours, or leave it alone.';
  }

  // Say exactly which app to tick. macOS attributes the grant to the process
  // that launched Wisp, so when started from a terminal the useful answer is
  // usually the terminal, not Wisp.
  const target = s.accessibility.target;
  const accessibilityHint = el('accessibilityHint');
  if (!holdMode || (s.accessibility.trusted && s.holdHookActive)) {
    accessibilityHint.textContent = '';
  } else if (!target) {
    accessibilityHint.textContent = 'System Settings → Privacy & Security → Accessibility.';
  } else {
    const name = target.suggestion.split('/').pop().replace(/\.app$/, '');
    accessibilityHint.textContent = s.accessibility.trusted
      ? 'Accessibility is granted, but the input hook is not running. Press “Check again”, then relaunch Wisp.'
      : `In System Settings → Privacy & Security → Accessibility, enable “${name}”.` +
        (target.packaged
          ? ''
          : ' Wisp was started by another app, so macOS lists that app rather than Wisp itself.');
  }

  // history
  renderHistory(s.history);
  el('dataPath').textContent = `Settings and transcripts: ${s.dataDir}`;
}

function renderHistory(history) {
  const list = el('history');
  list.textContent = '';
  if (!history || !history.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Nothing yet. Dictate something.';
    list.append(li);
    return;
  }
  for (const entry of history) {
    const li = document.createElement('li');

    const when = document.createElement('span');
    when.className = 'when';
    when.textContent = entry.time;

    const what = document.createElement('span');
    what.className = 'what';
    what.textContent = entry.text;
    if (entry.edited && entry.raw && entry.raw !== entry.text) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = 'edited';
      badge.title = `Raw: ${entry.raw}`;
      what.append(badge);
    }

    const copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = 'Copy';
    copy.addEventListener('click', async () => {
      const ok = await window.wisp.copyTranscript(entry.text);
      copy.textContent = ok ? 'Copied' : 'Failed';
      setTimeout(() => {
        copy.textContent = 'Copy';
      }, 1200);
    });

    li.append(when, what, copy);
    list.append(li);
  }
}

// ------------------------------------------------------------- form state

function applySettingsToForm(s) {
  // Never stomp on a field the user is currently editing: state snapshots
  // arrive asynchronously and would otherwise swallow keystrokes.
  const put = (id, value, prop = 'value') => {
    const node = el(id);
    if (node === document.activeElement) return;
    node[prop] = value;
  };

  put('triggerMode', s.triggerMode);
  put('holdKey', s.holdKey);
  if (document.activeElement !== el('toggleShortcut')) {
    put('toggleShortcut', prettyShortcut(s.toggleShortcut));
  }
  put('holdLatchMs', s.holdLatchMs);
  put('whisperModel', s.whisperModel);
  put('language', s.language);
  put('vocabulary', s.vocabulary);
  put('silenceFloor', s.silenceFloor);
  put('silenceFloorValue', Number(s.silenceFloor).toFixed(4), 'textContent');
  put('maxSeconds', s.maxSeconds);
  put('cleanupEnabled', s.cleanupEnabled, 'checked');
  put('ollamaUrl', s.ollamaUrl);
  put('ollamaModel', s.ollamaModel);
  // Show the prompt actually in use: the custom one, or the built-in default
  // when none has been set.
  put('cleanupPrompt', String(s.cleanupPrompt || '').trim() || s.defaultCleanupPrompt || '');
  put('inputDevice', s.inputDevice === null ? '' : String(s.inputDevice));
  put('copyToClipboard', s.copyToClipboard, 'checked');
  put('autoPaste', s.autoPaste, 'checked');
  put('pasteDelayMs', s.pasteDelayMs);
  put('playSounds', s.playSounds, 'checked');
  put('showHud', s.showHud, 'checked');
  put('launchAtLogin', s.launchAtLogin, 'checked');
  put('keepTranscripts', s.keepTranscripts, 'checked');
}

function populateStaticOptions(s) {
  const holdKey = el('holdKey');
  holdKey.textContent = '';
  for (const key of s.holdKeys) {
    const option = document.createElement('option');
    option.value = key.id;
    option.textContent = key.label;
    holdKey.append(option);
  }

  const model = el('whisperModel');
  model.textContent = '';
  for (const entry of s.whisperModels) {
    const option = document.createElement('option');
    option.value = entry.id;
    option.textContent = entry.label;
    model.append(option);
  }
}

function populateDevices(devices) {
  const select = el('inputDevice');
  const current = select.value;
  select.textContent = '';
  const system = document.createElement('option');
  system.value = '';
  system.textContent = 'System default';
  select.append(system);
  for (const device of devices) {
    const option = document.createElement('option');
    option.value = String(device.index);
    option.textContent = `${device.name}${device.is_default ? ' (default)' : ''}`;
    select.append(option);
  }
  select.value = current;
}

function populateOllamaModels(models) {
  const list = el('ollamaModelList');
  list.textContent = '';
  for (const name of models) {
    const option = document.createElement('option');
    option.value = name;
    list.append(option);
  }
}

// ------------------------------------------------------------------ wiring

function wire() {
  bind('triggerMode', 'triggerMode');
  bind('holdKey', 'holdKey');
  bind('holdLatchMs', 'holdLatchMs', { type: 'number' });
  bind('whisperModel', 'whisperModel');
  bind('language', 'language');
  bind('vocabulary', 'vocabulary', { type: 'input' });
  bind('silenceFloor', 'silenceFloor', {
    type: 'input',
    transform: Number,
  });
  el('silenceFloor').addEventListener('input', () => {
    el('silenceFloorValue').textContent = Number(el('silenceFloor').value).toFixed(4);
  });
  bind('maxSeconds', 'maxSeconds', { type: 'number' });
  bind('cleanupEnabled', 'cleanupEnabled', { type: 'checkbox' });
  bind('ollamaUrl', 'ollamaUrl');
  bind('ollamaModel', 'ollamaModel');
  bind('cleanupPrompt', 'cleanupPrompt', { type: 'input' });
  bind('copyToClipboard', 'copyToClipboard', { type: 'checkbox' });
  bind('autoPaste', 'autoPaste', { type: 'checkbox' });
  bind('pasteDelayMs', 'pasteDelayMs', { type: 'number' });
  bind('playSounds', 'playSounds', { type: 'checkbox' });
  bind('showHud', 'showHud', { type: 'checkbox' });
  bind('launchAtLogin', 'launchAtLogin', { type: 'checkbox' });
  bind('keepTranscripts', 'keepTranscripts', { type: 'checkbox' });

  bind('inputDevice', 'inputDevice', {
    transform: (value) => (value === '' ? null : Number(value)),
  });

  el('btnToggle').addEventListener('click', () => {
    if (snapshot.phase === 'recording') window.wisp.stop();
    else window.wisp.start();
  });

  el('btnReloadModel').addEventListener('click', async (event) => {
    event.target.disabled = true;
    event.target.textContent = 'Loading…';
    await window.wisp.reloadModel();
    event.target.disabled = false;
    event.target.textContent = 'Reload model';
  });

  el('btnCheckOllama').addEventListener('click', async () => {
    const result = await window.wisp.checkOllama();
    if (result.models) populateOllamaModels(result.models);
  });

  el('btnAccessibility').addEventListener('click', async () => {
    const target = await window.wisp.openAccessibility();
    if (snapshot) {
      snapshot.accessibility.target = target;
      render(snapshot);
    }
  });

  el('btnRecheckAccessibility').addEventListener('click', async () => {
    const result = await window.wisp.recheckAccessibility();
    flashHint(
      result.trusted
        ? 'Accessibility is granted for this app.'
        : 'Still not granted — macOS may need Wisp relaunched after you enable it.'
    );
    render(await window.wisp.getState());
  });

  el('btnResetPrompt').addEventListener('click', async () => {
    // Emptying the setting is what "use the built-in prompt" means, so this
    // does not paste the default text in as a custom prompt.
    const field = el('cleanupPrompt');
    field.value = snapshot ? snapshot.defaultCleanupPrompt || '' : '';
    await persist({ cleanupPrompt: '' });
  });

  el('btnTestCleanup').addEventListener('click', async () => {
    const input = el('testInput').value.trim();
    if (!input) return;
    const output = el('testOutput');
    output.textContent = 'Thinking…';
    const result = await window.wisp.testCleanup(input);
    output.textContent = result.text || `(no output) ${result.reason || ''}`;
  });

  el('btnOpenData').addEventListener('click', () => window.wisp.openExternal(`file://${snapshot.dataDir}`));
  el('btnDiagnostics').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const report = await window.wisp.diagnostics();
    const ok = await window.wisp.copyTranscript(report);
    button.textContent = ok ? 'Copied' : 'Copy failed';
    setTimeout(() => {
      button.textContent = 'Copy diagnostics';
    }, 1400);
  });
  el('btnReset').addEventListener('click', async () => {
    const result = await window.wisp.resetSettings();
    settings = result.settings;
    render(await window.wisp.getState());
  });

  el('btnClearHistory').addEventListener('click', () => window.wisp.clearHistory());
}

// -------------------------------------------------------------------- boot

async function boot() {
  const state = await window.wisp.getState();
  snapshot = state;
  populateStaticOptions(state);
  applySettingsToForm(state.settings);
  setupShortcutCapture();
  wire();
  render(state);

  const devices = await window.wisp.listDevices();
  populateDevices(devices.devices || []);

  const ollama = await window.wisp.checkOllama();
  if (ollama.models) populateOllamaModels(ollama.models);

  window.wisp.onEvent((event) => {
    if (event.type === 'level') {
      const scaled = Math.min(100, Math.round(Math.sqrt(event.rms) * 260));
      el('levelBar').style.width = `${snapshot.phase === 'recording' ? scaled : 0}%`;
      return;
    }
    if (event.type === 'state') {
      snapshot = event.state;
      render(event.state);
      el('levelBar').style.width = '0%';
      if (event.state.phase === 'idle') {
        applySettingsToForm(event.state.settings);
      }
      return;
    }
    if (event.type === 'devices') populateDevices(event.devices || []);
    if (event.type === 'ollamaModels') populateOllamaModels(event.models || []);
  });
}

boot();
