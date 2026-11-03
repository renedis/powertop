'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { mean, sd, round, timeWeightedMean } = require('./stats');

const ZONES = ['pkg', 'core', 'uncore', 'dram', 'psys'];
const httpError = (status, message) => Object.assign(new Error(message), { status });

function summarizeWindow({ samples, wallPoints, from, to }) {
  const inside = samples.filter((s) => s.t >= from && s.t <= to);
  const out = { n: inside.length };
  for (const k of ZONES) {
    const vals = inside.map((s) => s[k]).filter((v) => typeof v === 'number');
    if (vals.length) out[k] = { mean: round(mean(vals), 3), sd: round(sd(vals), 3), n: vals.length };
  }
  if (wallPoints) {
    const m = timeWeightedMean(wallPoints, from, to);
    out.wall = m === null ? null : { mean: round(m, 3), n: wallPoints.filter((p) => p.t > from && p.t <= to).length };
  }
  return out;
}

function diffWindows(a, b) {
  const out = {};
  for (const k of [...ZONES, 'wall']) {
    if (a[k] && b[k] && typeof a[k].mean === 'number' && typeof b[k].mean === 'number') out[k] = round(b[k].mean - a[k].mean, 3);
  }
  return out;
}

const signed = (x) => (x > 0 ? `+${x}` : `${x}`);

/**
 * Efficiency A/B test: hold powertop, measure a baseline window, apply the
 * selected items, settle, measure again and store the deltas.
 */
class Impact extends EventEmitter {
  constructor({ settings, runner, rapl, sensors, tuning, history, file, now = Date.now, msPerSec = 1000, maxResults = 50, log = console }) {
    super();
    Object.assign(this, { settings, runner, rapl, sensors, tuning, history, file, now, msPerSec, maxResults, log });
    this.test = null;
    this.done = Promise.resolve();
    this.timer = null;
    this.rejectWait = null;
    this.results = this._load();
  }

  _load() {
    try {
      const v = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.results));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      this.log.warn(`impact: save failed (${e.message})`);
    }
  }

  get running() {
    return Boolean(this.test && !['done', 'cancelled', 'error'].includes(this.test.phase));
  }

  status() {
    return { running: this.running, test: this.test ? { ...this.test } : null, results: this.results };
  }

  _emit() {
    this.emit('state', this.status());
  }

  _setPhase(phase, ms = 0) {
    this.test.phase = phase;
    this.test.phaseStartedAt = this.now();
    this.test.phaseEndsAt = ms ? this.now() + ms : null;
    this._emit();
  }

  _wait(ms) {
    return new Promise((resolve, reject) => {
      this.rejectWait = reject;
      this.timer = setTimeout(() => {
        this.rejectWait = null;
        resolve();
      }, ms);
    });
  }

  start(ids, { settleSec, windowSec } = {}) {
    if (!this.tuning.enabled()) throw httpError(403, 'tuning is disabled on this host');
    if (this.running) throw httpError(409, 'an impact test is already running');
    const report = this.runner.latest && this.runner.latest.report;
    if (!report) throw httpError(409, 'no report yet');
    const list = [...new Set(Array.isArray(ids) ? ids : [])];
    if (!list.length) throw httpError(400, 'select at least one item');
    const items = list.map((id) => report.tuning.bad.find((x) => x.id === id) || report.wakeup.find((x) => x.id === id));
    if (items.some((x) => !x)) throw httpError(400, 'unknown item in selection');
    const cfg = this.settings.get().impact;
    this.test = {
      id: crypto.randomBytes(4).toString('hex'),
      ids: list,
      items: items.map((x) => x.description),
      settleSec: settleSec ?? cfg.settleSec,
      windowSec: windowSec ?? cfg.windowSec,
      startedAt: this.now(),
      phase: 'hold',
      phaseStartedAt: this.now(),
      phaseEndsAt: null,
      error: null,
    };
    this.done = this._run(this.test);
    return this.status();
  }

  cancel() {
    if (!this.running) throw httpError(409, 'no impact test is running');
    this.test.cancelled = true;
    clearTimeout(this.timer);
    if (this.rejectWait) this.rejectWait(new Error('cancelled'));
    return this.status();
  }

  async _run(t) {
    const samples = [];
    const onSample = (s) => samples.push(s);
    this.rapl.on('sample', onSample);
    let held = false;
    this._emit();
    try {
      await this.runner.hold('impact');
      held = true;
      if (t.cancelled) throw new Error('cancelled');
      const settleMs = t.settleSec * this.msPerSec;
      const windowMs = t.windowSec * this.msPerSec;
      this._setPhase('settle1', settleMs);
      await this._wait(settleMs);
      this._setPhase('baseline', windowMs);
      const b0 = this.now();
      await this._wait(windowMs);
      const b1 = this.now();
      this._setPhase('apply');
      const applied = await this.tuning.apply(t.ids, { measure: false, kind: 'impact' });
      if (!applied.some((r) => r.ok)) throw new Error('nothing could be applied');
      this._setPhase('settle2', settleMs);
      await this._wait(settleMs);
      this._setPhase('after', windowMs);
      const a0 = this.now();
      await this._wait(windowMs);
      const a1 = this.now();
      const wall = this.sensors.wallSensor && this.sensors.wallSensor();
      const wallPoints = wall ? this.sensors.points(wall.id, b0 - 3600000, a1) : null;
      const baseline = summarizeWindow({ samples, wallPoints, from: b0, to: b1 });
      const after = summarizeWindow({ samples, wallPoints, from: a0, to: a1 });
      const delta = diffWindows(baseline, after);
      const result = {
        id: t.id,
        ids: t.ids,
        items: t.items,
        startedAt: t.startedAt,
        finishedAt: this.now(),
        settleSec: t.settleSec,
        windowSec: t.windowSec,
        baseline,
        after,
        delta,
        applied,
      };
      this.results.unshift(result);
      this.results = this.results.slice(0, this.maxResults);
      this._save();
      const parts = ['wall', 'psys', 'pkg'].filter((k) => k in delta).map((k) => `${k} ${signed(delta[k])} W`);
      const what = t.items.length === 1 ? t.items[0] : `${t.items.length} items`;
      this.history.addEvent('impact', `Impact test (${what}): ${parts.join(', ') || 'no power data'}`);
      this._setPhase('done');
    } catch (e) {
      if (t.cancelled) this._setPhase('cancelled');
      else {
        t.error = e.message;
        this._setPhase('error');
      }
    } finally {
      this.rapl.removeListener('sample', onSample);
      clearTimeout(this.timer);
      this.rejectWait = null;
      if (held) this.runner.release();
      this._emit();
    }
  }
}

module.exports = { Impact, summarizeWindow, diffWindows };
