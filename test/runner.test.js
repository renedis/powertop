'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter, once } = require('events');
const { Runner } = require('../src/runner');
const { parseReport } = require('../src/parser');

const FIXTURE = path.join(__dirname, 'fixtures', 'intel-untuned.html');
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pt-run-'));

function stubSettings(run) {
  const s = new EventEmitter();
  s.value = { run: { mode: 'paused', fastIntervalSec: 60, idleIntervalSec: 900, measureSec: 5, ...run } };
  s.get = () => JSON.parse(JSON.stringify(s.value));
  return s;
}

test('nextDelay', () => {
  const base = { now: 100000, fastMs: 60000, idleMs: 900000, minGapMs: 5000 };
  const d = (o) => Runner.nextDelay({ ...base, ...o });
  assert.equal(d({ mode: 'paused', viewers: 3, lastStart: null }), null);
  assert.equal(d({ mode: 'continuous', viewers: 0, lastStart: null }), 0);
  assert.equal(d({ mode: 'continuous', viewers: 0, lastStart: 90000, lastEnd: 95000 }), 50000);
  // measure longer than the interval: wait the minimum gap after the end
  assert.equal(d({ mode: 'continuous', viewers: 0, lastStart: 30000, lastEnd: 99000 }), 4000);
  assert.equal(d({ mode: 'adaptive', viewers: 0, lastStart: 90000, lastEnd: 95000 }), 890000);
  assert.equal(d({ mode: 'adaptive', viewers: 1, lastStart: 90000, lastEnd: 95000 }), 50000);
  assert.equal(d({ mode: 'adaptive', viewers: 1, lastStart: 0, lastEnd: 20000 }), 0, 'stale report runs now');
  assert.equal(d({ mode: 'adaptive', viewers: 0, lastStart: null }), 0, 'first run at start');
  assert.equal(d({ mode: 'ondemand', viewers: 0, lastStart: null }), null);
  assert.equal(d({ mode: 'ondemand', viewers: 2, lastStart: null }), 0);
});

test('dev fixture measurement parses, stores and emits the report', async () => {
  const dir = tmpDir();
  const r = new Runner({ settings: stubSettings(), reportDir: dir, devFixture: FIXTURE, parse: parseReport, devDelayMs: 10 });
  const got = once(r, 'report');
  assert.deepEqual(r.measureNow(), { ok: true });
  assert.equal(r.status().state, 'measuring');
  assert.deepEqual(r.measureNow(), { ok: false, reason: 'busy' });
  const [latest] = await got;
  assert.equal(latest.report.tuning.bad.length, 4);
  await r.current;
  assert.equal(r.lastRun.ok, true);
  assert.equal(r.status().state, 'idle');
  assert.ok(fs.existsSync(path.join(dir, 'report.html')));
  assert.equal(fs.existsSync(path.join(dir, 'report.tmp.html')), false);
  r.stop();
});

test('hold waits for the in-flight run and blocks new runs until release', async () => {
  const r = new Runner({ settings: stubSettings(), reportDir: tmpDir(), devFixture: FIXTURE, parse: parseReport, devDelayMs: 40 });
  r.measureNow();
  await r.hold('impact');
  assert.equal(r.lastRun.ok, true, 'hold resolved after the run finished');
  assert.deepEqual(r.measureNow(), { ok: false, reason: 'held' });
  assert.equal(r.status().held, true);
  r.release();
  assert.equal(r.status().held, false);
  r.stop();
});

test('exclusive runs fn while no measurement can start', async () => {
  const r = new Runner({ settings: stubSettings(), reportDir: tmpDir(), devFixture: FIXTURE, parse: parseReport, devDelayMs: 5 });
  const result = await r.exclusive(async () => {
    assert.deepEqual(r.measureNow(), { ok: false, reason: 'held' });
    return 42;
  });
  assert.equal(result, 42);
  assert.equal(r.status().held, false);
  r.stop();
});

test('a viewer arriving in ondemand mode triggers a run', async () => {
  const r = new Runner({ settings: stubSettings({ mode: 'ondemand' }), reportDir: tmpDir(), devFixture: FIXTURE, parse: parseReport, devDelayMs: 5 });
  r.start();
  assert.equal(r.status().nextRunAt, null, 'no viewer, no run');
  const got = once(r, 'report');
  r.setViewers(1);
  await got;
  r.setViewers(0);
  r.stop();
});

test('settings change reschedules', async () => {
  const settings = stubSettings({ mode: 'paused' });
  const r = new Runner({ settings, reportDir: tmpDir(), devFixture: FIXTURE, parse: parseReport, devDelayMs: 5 });
  r.start();
  assert.equal(r.status().nextRunAt, null);
  const got = once(r, 'report');
  settings.value.run.mode = 'continuous';
  settings.emit('change');
  await got;
  r.stop();
});

test('powertop failure is recorded with the stderr tail', async () => {
  const fakeSpawn = () => {
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      child.stderr.emit('data', Buffer.from('line1\nFailed to mount debugfs!\n'));
      child.emit('close', 1);
    });
    return child;
  };
  const r = new Runner({ settings: stubSettings(), reportDir: tmpDir(), parse: parseReport, spawn: fakeSpawn });
  const done = once(r, 'run');
  r.measureNow();
  const [run] = await done;
  assert.equal(run.ok, false);
  assert.match(run.error, /exited 1.*Failed to mount debugfs/);
  assert.equal(r.latest, null);
  r.stop();
});

test('existing report in the report dir is loaded at start', () => {
  const dir = tmpDir();
  fs.copyFileSync(FIXTURE, path.join(dir, 'report.html'));
  const r = new Runner({ settings: stubSettings(), reportDir: dir, parse: parseReport });
  r.start();
  assert.equal(r.latest.report.tuning.bad.length, 4);
  assert.equal(r.lastRun.ok, true);
  r.stop();
});
