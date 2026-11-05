'use strict';
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const DAY = 86400000;
const RANGES = { '1h': 3600000, '6h': 6 * 3600000, '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY };
const POWER_KEYS = ['pkg', 'core', 'uncore', 'dram', 'psys', 'wall'];
const RUN_KEYS = ['cpu', 'wak', 'deep', 'open'];
const FILE_RE = /^(\d{4}-\d{2}-\d{2})\.ndjson$/;

const pad = (n) => String(n).padStart(2, '0');

/** Local calendar day (container TZ) used for file names. */
function localDay(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const dayStart = (day) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
};

const clean = (obj) => {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== null && v !== undefined) out[k] = v;
  return out;
};

/**
 * Append-only NDJSON history, one file per local day, buffered in memory and
 * flushed every few minutes to keep disk writes small.
 */
class History extends EventEmitter {
  constructor({ dir, days = 7, now = Date.now, flushMs = 600000, maxPoints = 720, log = console }) {
    super();
    this.dir = dir;
    this.days = days;
    this.now = now;
    this.flushMs = flushMs;
    this.maxPoints = maxPoints;
    this.log = log;
    this.power = [];
    this.runs = [];
    this.events = [];
    this.udm = [];
    this.pending = [];
    this.timers = [];
  }

  async load() {
    let files = [];
    try {
      files = fs.readdirSync(this.dir).filter((f) => FILE_RE.test(f)).sort();
    } catch {
      return this;
    }
    const cutoff = this.now() - this.days * DAY;
    for (const f of files) {
      const day = FILE_RE.exec(f)[1];
      if (dayStart(day) + DAY < cutoff) continue;
      let text = '';
      try {
        text = await fs.promises.readFile(path.join(this.dir, f), 'utf8');
      } catch {
        continue;
      }
      for (const line of text.split('\n')) {
        if (!line) continue;
        let rec;
        try {
          rec = JSON.parse(line);
        } catch {
          continue;
        }
        if (!rec || typeof rec.t !== 'number' || rec.t < cutoff) continue;
        this._list(rec.k)?.push(rec);
      }
    }
    for (const list of [this.power, this.runs, this.events, this.udm]) list.sort((a, b) => a.t - b.t);
    return this;
  }

  _list(kind) {
    return kind === 'p' ? this.power : kind === 'r' ? this.runs : kind === 'e' ? this.events : kind === 'u' ? this.udm : null;
  }

  _add(rec) {
    this._list(rec.k).push(rec);
    this.pending.push(rec);
    return rec;
  }

  addPower(rec) {
    const r = { t: rec.t ?? this.now(), k: 'p' };
    for (const key of POWER_KEYS) if (rec[key] !== null && rec[key] !== undefined) r[key] = rec[key];
    if (rec.s && Object.keys(clean(rec.s)).length) r.s = clean(rec.s);
    return this._add(r);
  }

  addRun(rec) {
    return this._add(clean({ t: rec.t ?? this.now(), k: 'r', cpu: rec.cpu, wak: rec.wak, deep: rec.deep, open: rec.open, dur: rec.dur }));
  }

  /** UniFi console readings: flat numeric keys (see src/udm.js). */
  addUdm(rec) {
    const r = { t: rec.t ?? this.now(), k: 'u' };
    for (const [key, v] of Object.entries(rec)) if (key !== 't' && key !== 'k' && typeof v === 'number' && Number.isFinite(v)) r[key] = v;
    return this._add(r);
  }

  addEvent(kind, text, t) {
    const rec = this._add({ t: t ?? this.now(), k: 'e', kind, text: String(text).slice(0, 300) });
    this.emit('event', rec);
    return rec;
  }

  setDays(days) {
    this.days = days;
    this.prune();
  }

  async flush() {
    if (!this.pending.length) return;
    const batch = this.pending;
    this.pending = [];
    const byDay = new Map();
    for (const rec of batch) {
      const day = localDay(rec.t);
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push(JSON.stringify(rec));
    }
    try {
      await fs.promises.mkdir(this.dir, { recursive: true });
      for (const [day, lines] of byDay) {
        await fs.promises.appendFile(path.join(this.dir, `${day}.ndjson`), `${lines.join('\n')}\n`);
      }
    } catch (e) {
      this.log.warn(`history: flush failed (${e.message}), will retry`);
      this.pending = batch.concat(this.pending);
    }
  }

  prune() {
    const cutoff = this.now() - this.days * DAY;
    for (const key of ['power', 'runs', 'events', 'udm']) this[key] = this[key].filter((r) => r.t >= cutoff);
    let files = [];
    try {
      files = fs.readdirSync(this.dir);
    } catch {
      return;
    }
    for (const f of files) {
      const m = FILE_RE.exec(f);
      if (m && dayStart(m[1]) + DAY < cutoff) {
        try {
          fs.unlinkSync(path.join(this.dir, f));
        } catch {
          /* ignore */
        }
      }
    }
  }

  start() {
    this.prune();
    const flush = setInterval(() => this.flush(), this.flushMs);
    const prune = setInterval(() => this.prune(), 3600000);
    flush.unref();
    prune.unref();
    this.timers.push(flush, prune);
  }

  stop() {
    this.timers.forEach(clearInterval);
    this.timers = [];
  }

  /** Bucket-average records into columns; null rows mark gaps. */
  _columns(records, keys, from, bucketMs, extra) {
    const buckets = new Map();
    const seen = new Set();
    for (const r of records) {
      if (r.t < from) continue;
      const b = from + Math.floor((r.t - from) / bucketMs) * bucketMs;
      if (!buckets.has(b)) buckets.set(b, {});
      const acc = buckets.get(b);
      const vals = extra ? { ...r, ...extra(r) } : r;
      for (const [k, v] of Object.entries(vals)) {
        if (k === 't' || k === 'k' || k === 's' || typeof v !== 'number') continue;
        if (keys && !keys.includes(k) && !k.startsWith('s:')) continue;
        seen.add(k);
        acc[k] = acc[k] || [0, 0];
        acc[k][0] += v;
        acc[k][1] += 1;
      }
    }
    const cols = [...seen];
    const out = { t: [], series: Object.fromEntries(cols.map((k) => [k, []])) };
    let prev = null;
    for (const b of [...buckets.keys()].sort((x, y) => x - y)) {
      if (prev !== null && b - prev > 2.5 * bucketMs) {
        out.t.push(prev + bucketMs);
        cols.forEach((k) => out.series[k].push(null));
      }
      out.t.push(b);
      const acc = buckets.get(b);
      cols.forEach((k) => out.series[k].push(acc[k] ? Math.round((acc[k][0] / acc[k][1]) * 1000) / 1000 : null));
      prev = b;
    }
    return out;
  }

  query(range) {
    if (!RANGES[range]) range = '24h';
    const span = RANGES[range];
    const to = this.now();
    const from = to - span;
    const bucketMs = Math.max(60000, Math.ceil(span / this.maxPoints / 60000) * 60000);
    const sensorCols = (r) => (r.s ? Object.fromEntries(Object.entries(r.s).map(([k, v]) => [`s:${k}`, v])) : {});
    const power = this._columns(this.power, POWER_KEYS, from, bucketMs, sensorCols);
    const runCols = this._columns(this.runs, RUN_KEYS, from, bucketMs);
    const runs = { t: runCols.t, ...Object.fromEntries(RUN_KEYS.map((k) => [k, runCols.series[k] || runCols.t.map(() => null)])) };
    const events = this.events.filter((e) => e.t >= from).map(({ t, kind, text }) => ({ t, kind, text }));
    return { range, from, to, bucketMs, power, runs, events };
  }

  queryUdm(range) {
    if (!RANGES[range]) range = '24h';
    const span = RANGES[range];
    const to = this.now();
    const from = to - span;
    const bucketMs = Math.max(60000, Math.ceil(span / this.maxPoints / 60000) * 60000);
    return { range, from, to, bucketMs, ...this._columns(this.udm, null, from, bucketMs) };
  }
}

module.exports = { History, localDay, RANGES };
