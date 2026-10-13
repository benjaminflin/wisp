'use strict';

/**
 * Supervises the Python capture worker and exposes it as a promise-based API.
 *
 * The worker is a long-lived child process, not a one-shot script, because
 * loading a Whisper model costs seconds. Keeping it warm is what makes
 * dictation feel instant.
 */

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

class Worker extends EventEmitter {
  constructor({ projectRoot, hfHome = null }) {
    super();
    this.projectRoot = projectRoot;
    this.hfHome = hfHome;
    this.proc = null;
    this.pending = new Map();
    this.nextId = 1;
    this.buffer = '';
    this.stopping = false;
    this.restarts = 0;
    this.ready = false;
    this.lastError = null;
    this.logLines = [];
    // Lines on stdout that were not JSON. Should always be zero; anything else
    // means a library is writing to the protocol channel.
    this.unparseable = 0;
  }

  /** Prefer the project venv; fall back to an explicit override or PATH. */
  resolvePython() {
    const candidates = [
      process.env.WISP_PYTHON,
      path.join(this.projectRoot, '.venv', 'bin', 'python'),
      path.join(this.projectRoot, 'venv', 'bin', 'python'),
    ].filter(Boolean);
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
    return 'python3';
  }

  get scriptPath() {
    return path.join(this.projectRoot, 'python', 'wisp_worker.py');
  }

  buildEnv() {
    const env = { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' };
    // Point Whisper at the cache that already holds the weights, so a packaged
    // build and a development checkout do not each download 1.6 GB.
    if (this.hfHome) {
      try {
        fs.mkdirSync(this.hfHome, { recursive: true });
      } catch {
        /* if it cannot be created, huggingface_hub will report it */
      }
      env.HF_HOME = this.hfHome;
    } else {
      const devCache = path.join(this.projectRoot, '.hf');
      if (fs.existsSync(devCache)) env.HF_HOME = devCache;
    }
    env.HF_HUB_DISABLE_TELEMETRY = '1';
    // Whisper's progress bars are noise on a pipe.
    env.TQDM_DISABLE = '1';
    return env;
  }

  start() {
    if (this.proc) return;
    this.stopping = false;
    const python = this.resolvePython();
    if (!fs.existsSync(this.scriptPath)) {
      this.emit('failed', `worker script missing at ${this.scriptPath}`);
      return;
    }
    this.emit('log', `spawning ${python} ${this.scriptPath}`);
    this.proc = spawn(python, [this.scriptPath], {
      cwd: this.projectRoot,
      env: this.buildEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => this.onStdout(chunk));

    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (chunk) => {
      for (const line of String(chunk).split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        this.logLines.push(trimmed);
        if (this.logLines.length > 300) this.logLines.shift();
        this.emit('log', trimmed);
      }
    });

    this.proc.on('error', (err) => {
      this.lastError = err.message;
      this.emit('failed', `could not start worker: ${err.message}`);
    });

    this.proc.on('exit', (code, signal) => {
      const wasPending = [...this.pending.values()];
      this.pending.clear();
      for (const p of wasPending) {
        p.reject(new Error(`worker exited (code ${code}, signal ${signal})`));
      }
      this.proc = null;
      this.ready = false;
      this.emit('exit', { code, signal });
      if (!this.stopping) this.scheduleRestart(code, signal);
    });
  }

  scheduleRestart(code, signal) {
    if (this.restarts >= 5) {
      this.emit('failed', `worker crashed repeatedly (last exit ${code}/${signal}); giving up`);
      return;
    }
    this.restarts += 1;
    const delay = Math.min(500 * 2 ** (this.restarts - 1), 5000);
    this.emit('log', `worker exited (${code}/${signal}); restarting in ${delay}ms`);
    setTimeout(() => {
      if (!this.stopping) this.start();
    }, delay);
  }

  onStdout(chunk) {
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        this.unparseable += 1;
        this.emit('log', `unparseable worker output: ${line.slice(0, 200)}`);
        continue;
      }
      this.dispatch(msg);
    }
  }

  dispatch(msg) {
    if (msg && msg.id != null && this.pending.has(msg.id)) {
      const entry = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.ok === false) entry.reject(new Error(msg.error || 'worker error'));
      else entry.resolve(msg);
      return;
    }
    if (msg && msg.event) {
      if (msg.event === 'ready') {
        this.ready = true;
        this.restarts = 0;
      }
      this.emit('event', msg);
      this.emit(msg.event, msg);
    }
  }

  request(cmd, params = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (!this.proc) return Promise.reject(new Error('worker is not running'));
    const id = this.nextId++;
    const payload = { id, cmd, ...params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`worker timed out after ${Math.round(timeoutMs / 1000)}s on '${cmd}'`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  async stop() {
    this.stopping = true;
    const proc = this.proc;
    if (!proc) return;
    try {
      proc.stdin.write(`${JSON.stringify({ id: this.nextId++, cmd: 'shutdown' })}\n`);
    } catch {
      /* already gone */
    }
    await new Promise((resolve) => {
      const killTimer = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        resolve();
      }, 3000);
      proc.once('exit', () => {
        clearTimeout(killTimer);
        resolve();
      });
    });
  }

  recentLogs() {
    return this.logLines.slice(-80);
  }
}

module.exports = { Worker };
