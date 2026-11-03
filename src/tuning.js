'use strict';
const fs = require('fs');
const path = require('path');

const httpError = (status, message) => Object.assign(new Error(message), { status });

/**
 * Applies powertop tunables and wake toggles as plain sysfs/procfs writes.
 * Only items present in the latest parsed report can be applied, and only
 * when their script parsed into {path, value} (see script.js).
 */
class Tuning {
  constructor({ settings, runner, history, sysfsRoot = '', log = console }) {
    this.settings = settings;
    this.runner = runner;
    this.history = history;
    this.sysfsRoot = sysfsRoot;
    this.log = log;
  }

  _sys(p) {
    return this.sysfsRoot ? path.join(this.sysfsRoot, p) : p;
  }

  readSysfs(p) {
    return fs.readFileSync(this._sys(p), 'utf8').trim();
  }

  writeSysfs(p, value) {
    const target = this._sys(p);
    if (this.sysfsRoot) fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${value}\n`);
  }

  enabled() {
    return Boolean(this.settings.get().tuning.enabled);
  }

  _assertEnabled() {
    if (!this.enabled()) throw httpError(403, 'tuning is disabled on this host');
  }

  _report() {
    const latest = this.runner.latest;
    if (!latest || !latest.report) throw httpError(409, 'no report yet');
    return latest.report;
  }

  static isExcluded(item, exclude) {
    return exclude.includes(item.description) || Boolean(item.write && exclude.includes(item.write.path));
  }

  _wakeEnabled(item) {
    if (!item.write) return null;
    try {
      const v = this.readSysfs(item.write.path);
      if (v === 'enabled') return true;
      if (v === 'disabled') return false;
    } catch {
      /* fall back to the script */
    }
    // powertop's script toggles: "echo 'enabled'" means it is disabled now
    return item.write.value === 'enabled' ? false : item.write.value === 'disabled' ? true : null;
  }

  /** Copy of the report with excluded/applicable flags and live wake state. */
  annotate(report) {
    if (!report) return report;
    const exclude = this.settings.get().tuning.exclude;
    return {
      ...report,
      tuning: {
        ...report.tuning,
        bad: report.tuning.bad.map((x) => ({ ...x, excluded: Tuning.isExcluded(x, exclude), applicable: Boolean(x.write) })),
      },
      wakeup: report.wakeup.map((w) => ({ ...w, enabled: this._wakeEnabled(w) })),
    };
  }

  _write(item, value) {
    try {
      this.writeSysfs(item.write.path, value);
    } catch (e) {
      return { ok: false, error: e.code || e.message };
    }
    let verified = null;
    try {
      const back = this.readSysfs(item.write.path);
      verified = back === value || back.includes(`[${value}]`);
    } catch {
      verified = null;
    }
    return { ok: true, verified };
  }

  _applyOne(report, id) {
    const item = report.tuning.bad.find((x) => x.id === id);
    if (item) {
      if (!item.write) return { id, description: item.description, ok: false, error: 'unsupported script form' };
      return { id, description: item.description, ...this._write(item, item.write.value) };
    }
    const wake = report.wakeup.find((x) => x.id === id);
    if (wake) {
      if (!wake.write) return { id, description: wake.description, ok: false, error: 'unsupported script form' };
      const now = this._wakeEnabled(wake);
      const target = now === null ? wake.write.value : now ? 'disabled' : 'enabled';
      return { id, description: `${wake.description} → ${target}`, ...this._write(wake, target) };
    }
    return { id, ok: false, error: 'unknown item' };
  }

  async apply(ids, { measure = true, kind = 'tune' } = {}) {
    this._assertEnabled();
    const report = this._report();
    const list = [...new Set(Array.isArray(ids) ? ids : [])];
    const results = await this.runner.exclusive(async () => list.map((id) => this._applyOne(report, id)));
    const ok = results.filter((r) => r.ok);
    if (results.length) {
      const names = ok.map((r) => r.description).slice(0, 3).join('; ');
      const more = ok.length > 3 ? ` (+${ok.length - 3})` : '';
      this.history.addEvent(kind, `Applied ${ok.length}/${results.length}${names ? `: ${names}${more}` : ''}`);
    }
    if (measure && ok.length) this.runner.measureSoon();
    return results;
  }

  async autoTune() {
    this._assertEnabled();
    const report = this._report();
    const exclude = this.settings.get().tuning.exclude;
    const items = report.tuning.bad.filter((x) => x.write);
    const todo = items.filter((x) => !Tuning.isExcluded(x, exclude));
    const results = todo.length ? await this.apply(todo.map((x) => x.id), { kind: 'auto' }) : [];
    return {
      applied: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      skipped: items.length - todo.length,
      unsupported: report.tuning.bad.length - items.length,
      results,
    };
  }

  async toggleWake(id) {
    this._assertEnabled();
    const report = this._report();
    const wake = report.wakeup.find((x) => x.id === id);
    if (!wake) throw httpError(404, 'unknown wake item');
    const [res] = await this.apply([id], { measure: false, kind: 'wake' });
    if (!res.ok) throw httpError(500, res.error);
    return { id, ok: true, enabled: this._wakeEnabled(wake) === true };
  }
}

module.exports = { Tuning };
