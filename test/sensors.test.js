'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { Sensors } = require('../src/sensors');

function stubSettings(value) {
  const s = new EventEmitter();
  s.value = value;
  s.get = () => JSON.parse(JSON.stringify(s.value));
  return s;
}

function fakeConnect() {
  const clients = [];
  const fn = (url, opts) => {
    const c = new EventEmitter();
    c.url = url;
    c.opts = opts;
    c.subs = [];
    c.ended = false;
    c.subscribe = (t) => c.subs.push(t);
    c.unsubscribe = (t) => (c.subs = c.subs.filter((x) => x !== t));
    c.end = () => (c.ended = true);
    clients.push(c);
    return c;
  };
  fn.clients = clients;
  return fn;
}

const WALL = { id: 'wall', name: 'Wall', topic: 'zigbee2mqtt/Server plug', path: 'power', unit: 'W', role: 'wall' };
const base = (extra = {}) => ({
  mqtt: { url: 'mqtt://192.168.1.10:1883', username: 'u', password: 'p', baseTopic: 'zigbee2mqtt' },
  sensors: [WALL],
  ...extra,
});

test('extract handles JSON paths, plain numbers and junk', () => {
  assert.equal(Sensors.extract('{"power":5.83,"energy":180.5}', 'power'), 5.83);
  assert.equal(Sensors.extract('{"ENERGY":{"Power":12}}', 'ENERGY.Power'), 12);
  assert.equal(Sensors.extract('7.2', 'power'), 7.2);
  assert.equal(Sensors.extract('"7.2"', ''), 7.2);
  assert.equal(Sensors.extract('{"power":"3.5"}', 'power'), 3.5);
  assert.equal(Sensors.extract('ON', 'power'), null);
  assert.equal(Sensors.extract('{"power":null}', 'power'), null);
  assert.equal(Sensors.extract('{"a":1}', ''), null);
  assert.equal(Sensors.extract('', 'power'), null);
});

test('connects, subscribes sensor topics and tracks values', () => {
  const connect = fakeConnect();
  let now = 1000;
  const s = new Sensors({ settings: stubSettings(base()), connect, now: () => now, log: { warn() {} } });
  s.start();
  const c = connect.clients[0];
  assert.equal(c.url, 'mqtt://192.168.1.10:1883');
  assert.equal(c.opts.username, 'u');
  c.emit('connect');
  assert.deepEqual(c.subs, [WALL.topic]);
  const events = [];
  s.on('sensor', (e) => events.push(e));
  c.emit('message', WALL.topic, Buffer.from('{"power":5.83}'));
  assert.deepEqual(s.wall(), { value: 5.83, ts: 1000 });
  assert.deepEqual(events, [{ id: 'wall', value: 5.83, ts: 1000, role: 'wall' }]);
  now += 11 * 60 * 1000;
  assert.equal(s.wall(), null, 'stale after 10 minutes');
  const st = s.status();
  assert.equal(st.connected, true);
  assert.equal(st.url, 'mqtt://192.168.1.10:1883');
  assert.equal(JSON.stringify(st).includes('"p"'), false, 'no password in status');
  assert.equal(st.sensors[0].stale, true);
  s.close();
  assert.equal(c.ended, true);
});

test('points keep history for time-weighted means', () => {
  const connect = fakeConnect();
  let now = 0;
  const s = new Sensors({ settings: stubSettings(base()), connect, now: () => now });
  s.start();
  const c = connect.clients[0];
  c.emit('connect');
  for (const [t, v] of [[0, 5], [60000, 6], [120000, 7]]) {
    now = t;
    c.emit('message', WALL.topic, Buffer.from(JSON.stringify({ power: v })));
  }
  assert.deepEqual(s.points('wall', 70000, 130000).map((p) => p.v), [6, 7], 'includes the value in effect at the window start');
  s.close();
});

test('reconfigure: same broker resubscribes, new broker reconnects, no url disconnects', () => {
  const connect = fakeConnect();
  const settings = stubSettings(base());
  const s = new Sensors({ settings, connect });
  s.start();
  const c1 = connect.clients[0];
  c1.emit('connect');
  settings.value = base({ sensors: [{ ...WALL, topic: 'other/topic' }] });
  settings.emit('change', settings.get());
  assert.deepEqual(c1.subs, ['other/topic']);
  assert.equal(connect.clients.length, 1);
  settings.value = base({ mqtt: { url: 'mqtt://elsewhere:1883', username: '', password: '', baseTopic: 'zigbee2mqtt' } });
  settings.emit('change', settings.get());
  assert.equal(c1.ended, true);
  assert.equal(connect.clients.length, 2);
  settings.value = base({ mqtt: { url: '', username: '', password: '', baseTopic: 'zigbee2mqtt' } });
  settings.emit('change', settings.get());
  assert.equal(connect.clients[1].ended, true);
  assert.equal(s.status().configured, false);
  s.close();
});

test('discover lists z2m devices with numeric exposes, power first', async () => {
  const connect = fakeConnect();
  const s = new Sensors({ settings: stubSettings(base()), connect });
  s.start();
  const c = connect.clients[0];
  c.emit('connect');
  const p = s.discover({ timeoutMs: 1000 });
  assert.ok(c.subs.includes('zigbee2mqtt/bridge/devices'));
  const devices = [
    { type: 'Coordinator', friendly_name: 'Coordinator' },
    { friendly_name: 'Attic temperature', definition: { model: 'WSDCGQ11LM', vendor: 'Aqara', exposes: [{ type: 'numeric', property: 'temperature', unit: '°C' }] } },
    {
      friendly_name: 'Server plug',
      definition: {
        model: 'ZNCZ02LM',
        vendor: 'Aqara',
        exposes: [
          { type: 'switch', features: [{ type: 'binary', property: 'state' }] },
          { type: 'numeric', property: 'power', unit: 'W' },
          { type: 'numeric', property: 'energy', unit: 'kWh' },
          { type: 'numeric', property: 'linkquality', unit: 'lqi' },
        ],
      },
    },
    { friendly_name: 'Knop', definition: { exposes: [{ type: 'enum', property: 'action' }, { type: 'numeric', property: 'linkquality' }] } },
  ];
  c.emit('message', 'zigbee2mqtt/bridge/devices', Buffer.from(JSON.stringify(devices)));
  const list = await p;
  assert.deepEqual(list.map((d) => d.name), ['Server plug', 'Attic temperature']);
  assert.deepEqual(list[0], {
    name: 'Server plug',
    topic: 'zigbee2mqtt/Server plug',
    model: 'ZNCZ02LM',
    vendor: 'Aqara',
    fields: [{ property: 'power', unit: 'W' }, { property: 'energy', unit: 'kWh' }],
  });
  assert.equal(c.subs.includes('zigbee2mqtt/bridge/devices'), false, 'unsubscribed afterwards');
  s.close();
});

test('discover without a connection fails with 503', async () => {
  const s = new Sensors({ settings: stubSettings(base({ mqtt: { url: '', username: '', password: '', baseTopic: 'z' } })), connect: fakeConnect() });
  s.start();
  await assert.rejects(s.discover({ timeoutMs: 10 }), (e) => e.status === 503);
  s.close();
});
