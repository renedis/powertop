'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { Impact, summarizeWindow, diffWindows } = require('../src/impact');

test('summarizeWindow and diffWindows', () => {
  const samples = [
    { t: 0, pkg: 5, psys: 7 },
    { t: 10, pkg: 6, psys: 8 },
    { t: 20, pkg: 7, psys: 9 },
    { t: 99, pkg: 100 },
  ];
  const wall = [{ t: -5, v: 10 }, { t: 15, v: 12 }];
  const a = summarizeWindow({ samples, wallPoints: wall, from: 0, to: 20 });
  assert.deepEqual(a.pkg, { mean: 6, sd: 1, n: 3 });
  assert.deepEqual(a.wall, { mean: 10.5, n: 1 });
  assert.equal(a.n, 3);
  const b = summarizeWindow({ samples: [{ t: 30, pkg: 4.5, psys: 6 }], wallPoints: [{ t: 25, v: 9 }], from: 30, to: 40 });
  assert.deepEqual(diffWindows(a, b), { pkg: -1.5, psys: -2, wall: -1.5 });
  assert.equal(summarizeWindow({ samples: [], wallPoints: [], from: 0, to: 1 }).wall, null);
});

function setup({ enabled = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-impact-'));
  const rapl = new EventEmitter();
  let appliedAt = Infinity;
  const wallPoints = [{ t: Date.now() - 1000, v: 10 }];
  // a sample stamped t covers the time before t, like a real RAPL delta
  const timer = setInterval(() => {
    const t = Date.now();
    const after = t > appliedAt;
    rapl.emit('sample', { t, pkg: after ? 4 : 5, psys: after ? 6 : 7 });
  }, 2);
  const calls = { hold: 0, release: 0, apply: [] };
  const runner = {
    hold: async () => calls.hold++,
    release: () => calls.release++,
    latest: { report: { tuning: { bad: [{ id: 'a1', description: 'Enable SATA link power management for host0' }] }, wakeup: [{ id: 'w1', description: 'Wake status for USB device usb1' }] } },
  };
  const tuning = {
    enabled: () => enabled,
    apply: async (ids) => {
      calls.apply.push(ids);
      appliedAt = Date.now();
      wallPoints.push({ t: appliedAt, v: 9 });
      return ids.map((id) => ({ id, ok: true }));
    },
  };
  const sensors = { wallSensor: () => ({ id: 'wall' }), points: () => wallPoints.slice() };
  const events = [];
  const history = { addEvent: (kind, text) => events.push({ kind, text }) };
  const settings = { get: () => ({ impact: { settleSec: 1, windowSec: 3 } }) };
  const impact = new Impact({ settings, runner, rapl, sensors, tuning, history, file: path.join(dir, 'impact.json'), msPerSec: 10 });
  return { impact, calls, events, dir, stop: () => clearInterval(timer) };
}

test('full impact run: hold, settle, baseline, apply, settle, after, result', async () => {
  const { impact, calls, events, dir, stop } = setup();
  const phases = [];
  impact.on('state', (s) => s.test && phases.at(-1) !== s.test.phase && phases.push(s.test.phase));
  const st = impact.start(['a1']);
  assert.equal(st.running, true);
  await impact.done;
  stop();
  assert.deepEqual(phases, ['hold', 'settle1', 'baseline', 'apply', 'settle2', 'after', 'done']);
  assert.deepEqual(calls.apply, [['a1']]);
  assert.equal(calls.hold, 1);
  assert.equal(calls.release, 1);
  const [result] = impact.results;
  assert.deepEqual(result.items, ['Enable SATA link power management for host0']);
  assert.equal(result.delta.pkg, -1);
  assert.equal(result.delta.psys, -1);
  assert.equal(result.delta.wall, -1);
  assert.ok(result.baseline.pkg.n >= 3, JSON.stringify(result.baseline));
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'impact.json'), 'utf8'));
  assert.equal(saved.length, 1);
  assert.equal(events.length, 1);
  assert.match(events[0].text, /package -1 W/);
  assert.equal(impact.status().running, false);
});

test('cancel during the baseline releases the runner and applies nothing', async () => {
  const { impact, calls, stop } = setup();
  impact.start(['a1']);
  await new Promise((r) => setTimeout(r, 15));
  impact.cancel();
  await impact.done;
  stop();
  assert.equal(impact.status().test.phase, 'cancelled');
  assert.deepEqual(calls.apply, []);
  assert.equal(calls.release, 1);
  assert.equal(impact.results.length, 0);
});

test('guards: running, unknown ids, disabled tuning, nothing to cancel', async () => {
  const { impact, stop } = setup();
  assert.throws(() => impact.cancel(), (e) => e.status === 409);
  assert.throws(() => impact.start(['zzz']), (e) => e.status === 400);
  assert.throws(() => impact.start([]), (e) => e.status === 400);
  impact.start(['w1']);
  assert.throws(() => impact.start(['a1']), (e) => e.status === 409);
  impact.cancel();
  await impact.done;
  stop();
  const off = setup({ enabled: false });
  assert.throws(() => off.impact.start(['a1']), (e) => e.status === 403);
  off.stop();
});

test('results survive a restart', async () => {
  const { impact, dir, stop } = setup();
  impact.start(['a1']);
  await impact.done;
  stop();
  const again = new Impact({
    settings: { get: () => ({ impact: { settleSec: 1, windowSec: 3 } }) },
    runner: {},
    rapl: new EventEmitter(),
    sensors: {},
    tuning: {},
    history: {},
    file: path.join(dir, 'impact.json'),
  });
  assert.equal(again.results.length, 1);
});
