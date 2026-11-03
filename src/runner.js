'use strict';
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const childProcess = require('child_process');
const { EventEmitter } = require('events');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Schedules powertop measurements. Modes:
 *  adaptive   – fast interval while someone watches, idle interval otherwise
 *  continuous – fast interval always
 *  ondemand   – fast interval while someone watches, nothing otherwise
 *  paused     – only manual runs
 */
class Runner extends EventEmitter {
  constructor({ settings, reportDir, devFixture = '', parse, spawn = childProcess.spawn, now = Date.now, log = console, minGapMs = 5000, devDelayMs = 3000 }) {
    super();
    this.settings = settings;
    this.reportDir = reportDir;
    this.devFixture = devFixture;
    this.parse = parse;
    this.spawn = spawn;
    this.now = now;
    this.log = log;
    this.minGapMs = minGapMs;
    this.devDelayMs = devDelayMs;
    this.state = 'idle';
    this.viewers = 0;
    this.held = 0;
    this.holdReason = null;
    this.latest = null;
    this.lastRun = null;
    this.nextRunAt = null;
    this.measureStartedAt = null;
    this.timer = null;
    this.current = null;
    this.child = null;
    this.onSettings = () => this._schedule();
  }

  static nextDelay({ mode, viewers, lastStart, lastEnd, now, fastMs, idleMs, minGapMs = 5000 }) {
    let interval;
    if (mode === 'continuous') interval = fastMs;
    else if (mode === 'adaptive') interval = viewers > 0 ? fastMs : idleMs;
    else if (mode === 'ondemand') {
      if (viewers <= 0) return null;
      interval = fastMs;
    } else return null;
    if (lastStart === null || lastStart === undefined) return 0;
    return Math.max(0, lastStart + interval - now, (lastEnd ?? lastStart) + minGapMs - now);
  }

  start() {
    this._loadExisting();
    this.settings.on('change', this.onSettings);
    this._schedule();
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
    this.settings.removeListener('change', this.onSettings);
    if (this.child) this.child.kill('SIGKILL');
  }

  _loadExisting() {
    const file = path.join(this.reportDir, 'report.html');
    try {
      const st = fs.statSync(file);
      if (!st.size) return;
      const report = this.parse(fs.readFileSync(file, 'utf8'));
      const t = st.mtimeMs;
      this.latest = { report, mtime: t, durationMs: null };
      this.lastRun = { start: t, end: t, ok: true, error: null };
    } catch {
      /* no previous report */
    }
  }

  status() {
    const run = this.settings.get().run;
    return {
      state: this.state,
      mode: run.mode,
      viewers: this.viewers,
      held: this.held > 0,
      holdReason: this.holdReason,
      measureSec: run.measureSec,
      fastIntervalSec: run.fastIntervalSec,
      idleIntervalSec: run.idleIntervalSec,
      measureStartedAt: this.measureStartedAt,
      nextRunAt: this.nextRunAt,
      lastRun: this.lastRun,
      lastUpdated: this.latest ? this.latest.mtime : null,
    };
  }

  _emitState() {
    this.emit('state', this.status());
  }

  _schedule() {
    clearTimeout(this.timer);
    this.timer = null;
    this.nextRunAt = null;
    if (this.held || this.state === 'measuring') return this._emitState();
    const run = this.settings.get().run;
    const delay = Runner.nextDelay({
      mode: run.mode,
      viewers: this.viewers,
      lastStart: this.lastRun ? this.lastRun.start : null,
      lastEnd: this.lastRun ? this.lastRun.end : null,
      now: this.now(),
      fastMs: run.fastIntervalSec * 1000,
      idleMs: run.idleIntervalSec * 1000,
      minGapMs: this.minGapMs,
    });
    if (delay !== null) {
      this.nextRunAt = this.now() + delay;
      this.timer = setTimeout(() => this._run(), delay);
    }
    return this._emitState();
  }

  setViewers(n) {
    if (n === this.viewers) return;
    this.viewers = n;
    this._schedule();
  }

  measureNow() {
    if (this.held) return { ok: false, reason: 'held' };
    if (this.state === 'measuring') return { ok: false, reason: 'busy' };
    this._run();
    return { ok: true };
  }

  /** Fresh report shortly after a change (not in paused mode). */
  measureSoon(delayMs = 1500) {
    if (this.held || this.state === 'measuring') return;
    if (this.settings.get().run.mode === 'paused') return;
    clearTimeout(this.timer);
    this.nextRunAt = this.now() + delayMs;
    this.timer = setTimeout(() => this._run(), delayMs);
    this._emitState();
  }

  async hold(reason) {
    this.held += 1;
    this.holdReason = reason;
    clearTimeout(this.timer);
    this.timer = null;
    this.nextRunAt = null;
    this._emitState();
    if (this.current) await this.current;
  }

  release() {
    if (this.held > 0) this.held -= 1;
    if (!this.held) {
      this.holdReason = null;
      this._schedule();
    }
  }

  async exclusive(fn) {
    await this.hold('exclusive');
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  _run() {
    if (this.state === 'measuring') return this.current;
    clearTimeout(this.timer);
    this.timer = null;
    this.nextRunAt = null;
    const run = this.settings.get().run;
    const start = this.now();
    this.state = 'measuring';
    this.measureStartedAt = start;
    this._emitState();
    this.current = (async () => {
      let ok = false;
      let error = null;
      try {
        const html = await this._measure(run.measureSec);
        const report = this.parse(html);
        const end = this.now();
        this.latest = { report, mtime: end, durationMs: end - start };
        ok = true;
        this.emit('report', this.latest);
      } catch (e) {
        error = String((e && e.message) || e).slice(-500);
        this.log.warn(`runner: ${error}`);
      }
      this.lastRun = { start, end: this.now(), ok, error };
      this.state = 'idle';
      this.measureStartedAt = null;
      this.current = null;
      this.emit('run', this.lastRun);
      this._schedule();
    })();
    return this.current;
  }

  async _measure(sec) {
    await fsp.mkdir(this.reportDir, { recursive: true });
    const tmp = path.join(this.reportDir, 'report.tmp.html');
    const final = path.join(this.reportDir, 'report.html');
    await fsp.rm(tmp, { force: true });
    let failure = '';
    if (this.devFixture) {
      await sleep(Math.min(this.devDelayMs, sec * 1000));
      await fsp.copyFile(this.devFixture, tmp);
    } else {
      failure = await this._spawnPowertop([`--html=${tmp}`, `--time=${sec}`], (sec + 60) * 1000);
    }
    const st = await fsp.stat(tmp).catch(() => null);
    if (!st || st.size === 0) throw new Error(failure || 'powertop produced no report');
    await fsp.rename(tmp, final);
    return fsp.readFile(final, 'utf8');
  }

  /** Resolves with '' on success or a short failure description. */
  _spawnPowertop(args, timeoutMs) {
    return new Promise((resolve) => {
      let tail = '';
      let done = false;
      const finish = (msg) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.child = null;
        resolve(msg);
      };
      let child;
      try {
        child = this.spawn('powertop', args, { stdio: ['ignore', 'ignore', 'pipe'] });
      } catch (e) {
        resolve(`powertop failed to start: ${e.message}`);
        return;
      }
      this.child = child;
      const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
      if (child.stderr) child.stderr.on('data', (d) => (tail = (tail + d).slice(-2000)));
      const lastLines = () => tail.trim().split('\n').filter(Boolean).slice(-3).join(' | ');
      child.on('error', (e) => finish(`powertop failed to start: ${e.message}`));
      child.on('close', (code, signal) => finish(code === 0 ? '' : `powertop exited ${code ?? signal}: ${lastLines()}`));
    });
  }
}

module.exports = { Runner };
