'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Settings, DEFAULTS } = require('../src/settings');
const { resolveDataDir } = require('../src/config');

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pt-settings-')), 'settings.json');

test('defaults without env or file', () => {
  const s = new Settings({ file: tmpFile(), env: {} }).load();
  assert.deepEqual(s.get(), JSON.parse(JSON.stringify(DEFAULTS)));
  assert.deepEqual(s.locked(), []);
});

test('env overlay, invalid env values ignored', () => {
  const s = new Settings({
    file: tmpFile(),
    env: {
      MODE: 'continuous',
      FAST_INTERVAL: '120',
      IDLE_INTERVAL: 'abc',
      MEASURE_SECONDS: '500',
      MQTT_URL: 'mqtt://192.168.1.10:1883',
      MQTT_PASS: 'pw',
      PEERS: 'a=http://x:1/, b=http://y:2',
      WALL_TOPIC: 'zigbee2mqtt/Server plug',
      HISTORY_DAYS: '14',
    },
  }).load();
  const v = s.get();
  assert.equal(v.run.mode, 'continuous');
  assert.equal(v.run.fastIntervalSec, 120);
  assert.equal(v.run.idleIntervalSec, DEFAULTS.run.idleIntervalSec);
  assert.equal(v.run.measureSec, DEFAULTS.run.measureSec);
  assert.equal(v.mqtt.url, 'mqtt://192.168.1.10:1883');
  assert.equal(v.mqtt.password, 'pw');
  assert.deepEqual(v.peers, [{ name: 'a', url: 'http://x:1' }, { name: 'b', url: 'http://y:2' }]);
  assert.deepEqual(v.sensors, [
    { id: 'wall', name: 'Server plug', topic: 'zigbee2mqtt/Server plug', path: 'power', unit: 'W', role: 'wall' },
  ]);
  assert.equal(v.history.days, 14);
});

test('user changes persist as a patch; env still applies to untouched keys', () => {
  const file = tmpFile();
  const a = new Settings({ file, env: { FAST_INTERVAL: '120' } }).load();
  a.update({ run: { mode: 'ondemand' } });
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(saved, { run: { mode: 'ondemand' } });
  const b = new Settings({ file, env: { FAST_INTERVAL: '90' } }).load();
  assert.equal(b.get().run.mode, 'ondemand');
  assert.equal(b.get().run.fastIntervalSec, 90);
});

test('validation errors carry status 400 and leave settings untouched', () => {
  const s = new Settings({ file: tmpFile(), env: {} }).load();
  const bad = [
    { run: { mode: 'x' } },
    { run: { fastIntervalSec: 5 } },
    { run: { measureSec: 1.5 } },
    { tuning: { enabled: 'maybe' } },
    { mqtt: { url: 'http://broker' } },
    { sensors: [{ name: 'a', topic: 'x/#', role: 'wall' }] },
    { sensors: [{ name: 'a', topic: 'x', role: 'wall' }, { name: 'b', topic: 'y', role: 'wall' }] },
    { sensors: [{ name: 'a', topic: 'x', role: 'other' }] },
    { sensors: [{ name: 'a', topic: 'x', path: 'a b', role: 'extra' }] },
    { peers: [{ name: 'p', url: 'ftp://x' }] },
    { history: { days: 0 } },
    { impact: { windowSec: 10 } },
  ];
  for (const patch of bad) {
    assert.throws(() => s.update(patch), (e) => e.status === 400, JSON.stringify(patch));
  }
  assert.deepEqual(s.get(), JSON.parse(JSON.stringify(DEFAULTS)));
});

test('arrays are replaced, sensor ids derived and unique', () => {
  const s = new Settings({ file: tmpFile(), env: {} }).load();
  s.update({ tuning: { exclude: ['a', 'b', 'a', ''] } });
  assert.deepEqual(s.get().tuning.exclude, ['a', 'b']);
  s.update({ tuning: { exclude: ['c'] } });
  assert.deepEqual(s.get().tuning.exclude, ['c']);
  s.update({ sensors: [{ name: 'Wall plug', topic: 't/1', role: 'wall' }, { name: 'Wall plug', topic: 't/2', role: 'extra', unit: '°C', path: 'temp' }] });
  assert.deepEqual(s.get().sensors.map((x) => x.id), ['wall-plug', 'wall-plug-2']);
  assert.equal(s.get().sensors[0].path, 'power');
  assert.equal(s.get().sensors[1].unit, '°C');
});

test('password: kept when omitted, replaced when given, never public', () => {
  const s = new Settings({ file: tmpFile(), env: {} }).load();
  s.update({ mqtt: { url: 'mqtt://b:1883', username: 'u', password: 'secret' } });
  s.update({ mqtt: { url: 'mqtt://b:1884' } });
  assert.equal(s.get().mqtt.password, 'secret');
  const pub = s.public();
  assert.equal(pub.mqtt.password, undefined);
  assert.equal(pub.mqtt.passwordSet, true);
  assert.equal(JSON.stringify(pub).includes('secret'), false);
  s.update({ mqtt: { password: '' } });
  assert.equal(s.public().mqtt.passwordSet, false);
});

test('TUNING_ENABLED=false from env is a lock', () => {
  const s = new Settings({ file: tmpFile(), env: { TUNING_ENABLED: 'false' } }).load();
  assert.equal(s.get().tuning.enabled, false);
  assert.deepEqual(s.locked(), ['tuning.enabled']);
  assert.throws(() => s.update({ tuning: { enabled: true } }), (e) => e.status === 400);
  s.update({ tuning: { exclude: ['x'] } });
  assert.equal(s.get().tuning.enabled, false);
  assert.deepEqual(s.public().locked, ['tuning.enabled']);
});

test('change event fires with next and previous settings', () => {
  const s = new Settings({ file: tmpFile(), env: {} }).load();
  let seen = null;
  s.on('change', (next, prev) => {
    seen = [next.run.mode, prev.run.mode];
  });
  s.update({ run: { mode: 'paused' } });
  assert.deepEqual(seen, ['paused', 'adaptive']);
});

test('corrupt settings file falls back to defaults', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{not json');
  const s = new Settings({ file, env: {} }).load();
  assert.equal(s.get().run.mode, 'adaptive');
});

test('resolveDataDir', () => {
  assert.equal(resolveDataDir({ DATA_DIR: '/x/y' }, () => false), '/x/y');
  assert.equal(resolveDataDir({}, (d) => d === '/data'), '/data');
  assert.equal(resolveDataDir({}, (d) => d === '/tmp/powertop'), '/tmp/powertop');
  assert.equal(resolveDataDir({}, () => false), '/data');
});

test('prototype keys in a patch are ignored', () => {
  const s = new Settings({ file: tmpFile(), env: {} }).load();
  s.update(JSON.parse('{"__proto__":{"polluted":true},"constructor":{"x":1},"run":{"mode":"paused"}}'));
  assert.equal(s.get().run.mode, 'paused');
  assert.equal({}.polluted, undefined);
  assert.equal(Object.getPrototypeOf(s.get()), Object.prototype);
});
