'use strict';
const { mean, round, timeWeightedMean } = require('./stats');

const ZONES = ['pkg', 'core', 'uncore', 'dram', 'psys'];

/** Builds one power record per minute from RAPL samples and MQTT sensors. */
class Collector {
  constructor({ rapl, sensors, history, settings, now = Date.now, periodMs = 60000 }) {
    Object.assign(this, { rapl, sensors, history, settings, now, periodMs });
    this.samples = [];
    this.timer = null;
    this.onSample = (s) => this.samples.push(s);
  }

  start() {
    this.rapl.on('sample', this.onSample);
    this.timer = setInterval(() => this.tick(), this.periodMs);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
    this.rapl.removeListener('sample', this.onSample);
  }

  wallMean(from, to) {
    const wall = this.sensors.wallSensor();
    if (!wall || !this.sensors.value(wall.id)) return null;
    const m = timeWeightedMean(this.sensors.points(wall.id, from, to), from, to);
    return m === null ? this.sensors.value(wall.id).value : round(m, 3);
  }

  tick() {
    const t = this.now();
    const from = t - this.periodMs;
    const samples = this.samples.filter((s) => s.t > from);
    this.samples = [];
    const rec = { t };
    for (const k of ZONES) {
      const v = mean(samples.map((s) => s[k]));
      if (v !== null) rec[k] = round(v, 3);
    }
    const wall = this.wallMean(from, t);
    if (wall !== null) rec.wall = wall;
    const extra = {};
    for (const s of this.settings.get().sensors) {
      if (s.role !== 'extra') continue;
      const v = this.sensors.value(s.id);
      if (v) extra[s.id] = v.value;
    }
    if (Object.keys(extra).length) rec.s = extra;
    if (Object.keys(rec).length > 1) this.history.addPower(rec);
    return rec;
  }

  /** Smoothed live values for KPIs (last ~15 s of RAPL). */
  live() {
    const ring = this.rapl.live().slice(-3);
    const out = {};
    for (const k of ZONES) {
      const v = mean(ring.map((s) => s[k]));
      out[k] = v === null ? null : round(v, 2);
    }
    const w = this.sensors.wall();
    out.wall = w ? w.value : null;
    return out;
  }
}

module.exports = { Collector, ZONES };
