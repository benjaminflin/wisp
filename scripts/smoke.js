#!/usr/bin/env node
'use strict';

/**
 * End-to-end smoke test for everything except the Electron shell.
 *
 * Exercises the same Worker and Qwen code paths the app uses, so a green run
 * means the capture engine, Whisper, and Ollama are all wired correctly.
 *
 *   node scripts/smoke.js            # quiet: speech is rendered to a file
 *   node scripts/smoke.js --with-mic # also exercise the live microphone
 */

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const { Worker } = require('../src/lib/worker');
const qwen = require('../src/lib/qwen');

const ROOT = path.join(__dirname, '..');
const WITH_MIC = process.argv.includes('--with-mic');
const MODEL = process.env.WISP_MODEL || 'mlx-community/whisper-large-v3-turbo';
const SPOKEN =
  'Schedule a review for Thursday at two pm, um, and scratch that, make it Friday at ten am.';

const QWEN_SETTINGS = {
  cleanupEnabled: true,
  ollamaUrl: process.env.WISP_OLLAMA_URL || 'http://127.0.0.1:11434',
  ollamaModel: process.env.WISP_OLLAMA_MODEL || 'qwen2.5:7b',
  cleanupTimeoutMs: 120000,
};

const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  const mark = ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  ${mark}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(worker, event, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for '${event}'`)), timeoutMs);
    worker.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

async function main() {
  console.log('\n\x1b[1mWisp smoke test\x1b[0m\n');
  const worker = new Worker({ projectRoot: ROOT });
  worker.on('log', (line) => {
    if (/error|traceback|exception/i.test(line)) console.log(`     \x1b[31m[worker]\x1b[0m ${line}`);
  });

  const ready = waitFor(worker, 'ready', 30000);
  worker.start();

  try {
    const hello = await ready;
    check('capture worker starts and reports ready', Boolean(hello.pid), `pid ${hello.pid}, python ${hello.python}`);
  } catch (err) {
    check('capture worker starts and reports ready', false, err.message);
    await worker.stop();
    return finish();
  }

  try {
    const devices = await worker.request('devices', {}, 15000);
    const inputs = devices.devices || [];
    check('microphone input is available', inputs.length > 0, inputs.map((d) => d.name).join(', ') || 'none found');
  } catch (err) {
    check('microphone input is available', false, err.message);
  }

  let loadSeconds = null;
  try {
    const warmed = await worker.request('warm', { model: MODEL, language: 'en', vocabulary: '' }, 30 * 60 * 1000);
    loadSeconds = warmed.elapsed;
    check('Whisper model loads', true, `${MODEL.split('/').pop()} in ${warmed.elapsed}s`);
  } catch (err) {
    check('Whisper model loads', false, err.message);
  }

  let transcript = '';
  if (WITH_MIC) {
    try {
      await worker.request('start', { device: null, max_seconds: 60, silence_floor: 0.0005 }, 20000);
      // Audible on purpose: the microphone has to hear something.
      try {
        execFileSync('say', ['-r', '165', SPOKEN], { timeout: 30000 });
      } catch {
        /* `say` is best effort */
      }
      await sleep(700);
      const result = await worker.request('stop', {}, 5 * 60 * 1000);
      transcript = (result.text || '').trim();
      check(
        'records from the microphone and transcribes it',
        transcript.length > 0,
        transcript ? `"${transcript.slice(0, 64)}${transcript.length > 64 ? '…' : ''}"` : 'empty transcript'
      );
      if (result.elapsed) {
        console.log(`     audio ${result.duration}s -> text in ${result.elapsed}s`);
      }
    } catch (err) {
      check('records from the microphone and transcribes it', false, err.message);
    }
  } else {
    // `say -o` renders speech straight to a file and never touches the speakers.
    const wav = path.join(ROOT, 'tmp', 'smoke.wav');
    try {
      fs.mkdirSync(path.dirname(wav), { recursive: true });
      execFileSync(
        'say',
        ['-o', wav, '--data-format=LEI16@16000', '--file-format=WAVE', SPOKEN],
        { timeout: 30000 }
      );
      const result = await worker.request('transcribe', { path: wav, language: 'en' }, 10 * 60 * 1000);
      transcript = (result.text || '').trim();
      check(
        'transcribes speech from an audio file',
        transcript.length > 0,
        transcript ? `"${transcript.slice(0, 64)}${transcript.length > 64 ? '…' : ''}"` : 'empty transcript'
      );
      if (result.elapsed) console.log(`     audio ${result.duration}s -> text in ${result.elapsed}s`);
    } catch (err) {
      check('transcribes speech from an audio file', false, err.message);
    }
  }

  // Qwen always gets exercised, including the case where the transcript failed.
  const sample = transcript || SPOKEN;
  try {
    const cleaned = await qwen.clean(sample, QWEN_SETTINGS);
    const applied =
      cleaned.reason === 'ok' &&
      cleaned.text.length > 0 &&
      !/\bum\b/i.test(cleaned.text) &&
      /friday/i.test(cleaned.text);
    check('Qwen cleans up and applies the spoken correction', applied, `"${cleaned.text}"`);
    if (cleaned.reason !== 'ok') console.log(`     reason: ${cleaned.reason} ${cleaned.error || ''}`);
  } catch (err) {
    check('Qwen cleans up and applies the spoken correction', false, err.message);
  }

  await worker.stop();
  return finish(loadSeconds);
}

function finish() {
  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n${failed.length === 0 ? '\x1b[32mAll checks passed\x1b[0m' : `\x1b[31m${failed.length} check(s) failed\x1b[0m`} (${results.length - failed.length}/${results.length})\n`
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\nsmoke test crashed:', err);
  process.exit(1);
});
