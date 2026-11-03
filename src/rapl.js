'use strict';
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { round } = require('./stats');

const ZONE_RE = /^intel-rapl:(\d+)(?::(\d+))?$/;
const MAX_WATTS = 2000;

const readText = (file) => fs.readFileSync(file, 'utf8').trim();

/**
 * Samples Intel/AMD RAPL energy counters from /sys/class/powercap and turns
 * deltas into watts. Zone keys: pkg, core, uncore, dram, psys (pkgN/coreN for
 * extra sockets).
 */
class Rapl extends EventEmitter {
  constructor({ dir = '/sys/class/powercap', fake = false, intervalMs = 5000, keepMs = 600000, now = Date.now, hr = process.hrtime.bigint } = {}) {
    super();
    this.dir = dir;
    this.fake = fake;
    this.intervalMs = intervalMs;
    this.keepMs = keepMs;
    this.now = now;
    this.hr = hr;
    this.zones = [];
    this.ring = [];
    this.prev = null;
    this.timer = null;
  }

  get available() {
    return this.zones.length > 0;
  }

  discover() {
    if (this.fake) {
      this.zones = ['pkg', 'core', 'uncore', 'dram', 'psys'].map((key) => ({ key, name: key, file: null, maxRange: 0 }));
      return this.zones;
    }
    let entries = [];
    try {
      entries = fs.readdirSync(this.dir);
    } catch {
      entries = [];
    }
    const pkgNum = new Map();
    const zones = [];
    const parsed = entries
      .map((e) => ({ e, m: ZONE_RE.exec(e) }))
      .filter((x) => x.m)
      .sort((a, b) => Number(a.m[1]) - Number(b.m[1]) || Number(a.m[2] ?? -1) - Number(b.m[2] ?? -1));
    for (const { e, m } of parsed) {
      const base = path.join(this.dir, e);
      let name;
      let maxRange;
      try {
        name = readText(path.join(base, 'name'));
        Number(readText(path.join(base, 'energy_uj')));
        maxRange = Number(readText(path.join(base, 'max_energy_range_uj'))) || 2 ** 32;
      } catch {
        continue;
      }
      const top = Number(m[1]);
      const pm = /^package-(\d+)$/.exec(name);
      let key;
      if (m[2] === undefined) {
        if (pm) {
          pkgNum.set(top, Number(pm[1]));
          key = pm[1] === '0' ? 'pkg' : `pkg${pm[1]}`;
        } else key = name;
      } else {
        const n = pkgNum.get(top) || 0;
        key = n ? `${name}${n}` : name;
      }
      while (zones.some((z) => z.key === key)) key = `${key}_`;
      zones.push({ key, name, file: path.join(base, 'energy_uj'), maxRange });
    }
    this.zones = zones;
    return zones;
  }

  static delta(prev, cur, maxRange) {
    return cur >= prev ? cur - prev : maxRange - prev + cur;
  }

  _fakeSample(t) {
    const wave = Math.sin(t / 90000) + 0.4 * Math.sin(t / 7000);
    const pkg = 3 + 1.2 * wave + Math.random() * 0.3;
    return {
      t,
      pkg: round(pkg, 3),
      core: round(pkg * 0.45, 3),
      uncore: round(0.05 + Math.random() * 0.02, 3),
      dram: round(0.9 + Math.random() * 0.1, 3),
      psys: round(pkg + 2.5 + Math.random() * 0.2, 3),
    };
  }

  sample() {
    if (!this.available) return null;
    const t = this.now();
    let out = null;
    if (this.fake) {
      out = this._fakeSample(t);
    } else {
      const hrNow = this.hr();
      const readings = {};
      for (const z of this.zones) {
        try {
          readings[z.key] = Number(readText(z.file));
        } catch {
          /* zone vanished or unreadable */
        }
      }
      if (this.prev) {
        const dt = Number(hrNow - this.prev.hr) / 1e9;
        if (dt > 0.2) {
          const s = { t };
          for (const z of this.zones) {
            const a = this.prev.readings[z.key];
            const b = readings[z.key];
            if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
            const w = Rapl.delta(a, b, z.maxRange) / 1e6 / dt;
            if (w >= 0 && w < MAX_WATTS) s[z.key] = round(w, 3);
          }
          if (Object.keys(s).length > 1) out = s;
        }
      }
      this.prev = { hr: hrNow, readings };
    }
    if (out) {
      this.ring.push(out);
      const cutoff = t - this.keepMs;
      while (this.ring.length && this.ring[0].t < cutoff) this.ring.shift();
      this.emit('sample', out);
    }
    return out;
  }

  live() {
    return this.ring.slice();
  }

  latest() {
    return this.ring.length ? this.ring[this.ring.length - 1] : null;
  }

  start() {
    this.discover();
    if (!this.available || this.timer) return;
    this.sample();
    this.timer = setInterval(() => this.sample(), this.intervalMs);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = { Rapl };
