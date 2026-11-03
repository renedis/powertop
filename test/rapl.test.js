'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { mean, sd, timeWeightedMean, round } = require('../src/stats');
const { Rapl } = require('../src/rapl');

test('mean, sd, round', () => {
  assert.equal(mean([1, 2, 3, null, NaN]), 2);
  assert.equal(mean([]), null);
  assert.equal(round(sd([2, 4, 4, 4, 5, 5, 7, 9]), 3), 2.138);
  assert.equal(sd([5]), 0);
  assert.equal(sd([]), null);
  assert.equal(round(1.23456, 2), 1.23);
});

test('timeWeightedMean holds each value until the next point', () => {
  const pts = [{ t: 0, v: 10 }, { t: 60, v: 20 }];
  assert.equal(timeWeightedMean(pts, 30, 90), 15);
  assert.equal(timeWeightedMean(pts, 70, 90), 20);
  assert.equal(timeWeightedMean([{ t: 50, v: 8 }], 0, 100), 8, 'uncovered start is ignored');
  assert.equal(timeWeightedMean([], 0, 10), null);
  assert.equal(timeWeightedMean(pts, 10, 10), null);
});

function fakePowercap(zones) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-rapl-'));
  for (const [entry, name, energy] of zones) {
    fs.mkdirSync(path.join(dir, entry));
    fs.writeFileSync(path.join(dir, entry, 'name'), `${name}\n`);
    fs.writeFileSync(path.join(dir, entry, 'energy_uj'), `${energy}\n`);
    fs.writeFileSync(path.join(dir, entry, 'max_energy_range_uj'), '262143328850\n');
  }
  fs.mkdirSync(path.join(dir, 'intel-rapl-mmio:0'));
  return dir;
}

test('delta handles counter wrap', () => {
  assert.equal(Rapl.delta(100, 150, 1000), 50);
  assert.equal(Rapl.delta(900, 50, 1000), 150);
});

test('discovers zones with stable keys', () => {
  const dir = fakePowercap([
    ['intel-rapl:0', 'package-0', 1000],
    ['intel-rapl:0:0', 'core', 1000],
    ['intel-rapl:0:1', 'uncore', 1000],
    ['intel-rapl:0:2', 'dram', 1000],
    ['intel-rapl:1', 'psys', 1000],
  ]);
  const r = new Rapl({ dir });
  r.discover();
  assert.equal(r.available, true);
  assert.deepEqual(r.zones.map((z) => z.key), ['pkg', 'core', 'uncore', 'dram', 'psys']);
});

test('sample() turns energy deltas into watts', () => {
  const dir = fakePowercap([
    ['intel-rapl:0', 'package-0', 1000000],
    ['intel-rapl:0:0', 'core', 2000000],
  ]);
  let ns = 0n;
  let ms = 1000;
  const r = new Rapl({ dir, hr: () => ns, now: () => ms });
  r.discover();
  const seen = [];
  r.on('sample', (s) => seen.push(s));
  assert.equal(r.sample(), null, 'first read only primes');
  fs.writeFileSync(path.join(dir, 'intel-rapl:0', 'energy_uj'), '6000000');
  fs.writeFileSync(path.join(dir, 'intel-rapl:0:0', 'energy_uj'), '4000000');
  ns += 1000000000n;
  ms += 1000;
  assert.deepEqual(r.sample(), { t: 2000, pkg: 5, core: 2 });
  assert.equal(seen.length, 1);
  assert.equal(r.live().length, 1);
  assert.equal(r.latest().pkg, 5);
});

test('absurd readings are dropped', () => {
  const dir = fakePowercap([['intel-rapl:0', 'package-0', 0]]);
  let ns = 0n;
  const r = new Rapl({ dir, hr: () => ns, now: () => 1 });
  r.discover();
  r.sample();
  fs.writeFileSync(path.join(dir, 'intel-rapl:0', 'energy_uj'), String(5000 * 1e6));
  ns += 1000000000n;
  assert.equal(r.sample(), null, '5 kW is not a CPU package');
});

test('missing powercap → unavailable; fake mode produces plausible values', () => {
  const r = new Rapl({ dir: path.join(os.tmpdir(), 'does-not-exist-pt') });
  r.discover();
  assert.equal(r.available, false);
  assert.equal(r.sample(), null);
  const f = new Rapl({ fake: true, now: () => 123456 });
  f.discover();
  assert.equal(f.available, true);
  const s = f.sample();
  assert.ok(s.pkg > 0.5 && s.pkg < 20, JSON.stringify(s));
  assert.ok(s.psys > s.pkg);
});
