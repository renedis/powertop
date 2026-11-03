'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { History, localDay } = require('../src/history');

const MIN = 60000;
const DAY = 86400000;
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pt-hist-'));
const T0 = new Date(2026, 10, 3, 12, 0, 0).getTime();

test('records are buffered, flushed to day files and reloaded', async () => {
  const dir = tmpDir();
  let now = T0;
  const h = new History({ dir, now: () => now });
  h.addPower({ t: T0, pkg: 1.5, psys: 2, wall: 7.2, s: { temp: 40 } });
  h.addRun({ t: T0, cpu: 3.1, wak: 489.6, deep: 87.6, open: 4, dur: 20 });
  h.addEvent('tune', 'Applied 1 tunable', T0);
  assert.equal(fs.readdirSync(dir).length, 0, 'nothing written before flush');
  await h.flush();
  const file = path.join(dir, `${localDay(T0)}.ndjson`);
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.k), ['p', 'r', 'e']);
  assert.equal(lines[0].wall, 7.2);
  await h.flush();
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 3, 'second flush adds nothing');

  fs.appendFileSync(file, '{broken json\n');
  const h2 = new History({ dir, now: () => now });
  await h2.load();
  assert.equal(h2.power.length, 1);
  assert.equal(h2.runs.length, 1);
  assert.equal(h2.events.length, 1);
  assert.equal(h2.events[0].text, 'Applied 1 tunable');
});

test('prune drops old records and day files', async () => {
  const dir = tmpDir();
  let now = T0;
  const h = new History({ dir, days: 1, now: () => now });
  h.addPower({ t: T0, pkg: 1 });
  await h.flush();
  now = T0 + 3 * DAY;
  h.addPower({ t: now, pkg: 2 });
  await h.flush();
  assert.equal(fs.readdirSync(dir).length, 2);
  h.prune();
  assert.deepEqual(h.power.map((p) => p.pkg), [2]);
  assert.deepEqual(fs.readdirSync(dir), [`${localDay(now)}.ndjson`]);
});

test('query returns bucketed columns within the range', () => {
  const now = T0 + 7 * DAY;
  const h = new History({ dir: tmpDir(), days: 7, now: () => now });
  for (let t = T0; t < now; t += MIN) h.addPower({ t, pkg: 2, psys: 3, wall: t < now - 3600000 ? 6 : 8 });
  for (let t = T0; t < now; t += 15 * MIN) h.addRun({ t, cpu: 4, wak: 500, deep: 80, open: 2 });
  h.addEvent('tune', 'x', now - 30 * MIN);

  const hour = h.query('1h');
  assert.equal(hour.bucketMs, MIN);
  assert.ok(hour.power.t.length >= 59 && hour.power.t.length <= 61, String(hour.power.t.length));
  assert.ok(hour.power.series.wall.every((v) => v === 8));
  assert.deepEqual(Object.keys(hour.power.series).sort(), ['pkg', 'psys', 'wall']);
  assert.equal(hour.events.length, 1);

  const week = h.query('7d');
  assert.ok(week.power.t.length <= 720, String(week.power.t.length));
  assert.equal(week.bucketMs, 14 * MIN);
  assert.ok(week.runs.t.length > 0 && week.runs.t.length <= 720);
  assert.equal(week.runs.deep[0], 80);
});

test('gaps become null rows so charts break the line', () => {
  const now = T0 + 2 * 3600000;
  const h = new History({ dir: tmpDir(), now: () => now });
  h.addPower({ t: now - 100 * MIN, pkg: 1 });
  h.addPower({ t: now - 99 * MIN, pkg: 1 });
  h.addPower({ t: now - 10 * MIN, pkg: 2 });
  const q = h.query('6h');
  assert.ok(q.power.series.pkg.includes(null));
});

test('unknown range falls back to 24h', () => {
  const h = new History({ dir: tmpDir(), now: () => T0 });
  assert.equal(h.query('bogus').range, '24h');
});
