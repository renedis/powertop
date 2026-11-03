'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { once } = require('events');
const { buildApp } = require('../src/app');

const FIXTURE = path.join(__dirname, 'fixtures', 'intel-untuned.html');
const quiet = { log() {}, warn() {}, error() {} };

async function boot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-api-'));
  const hostRoot = path.join(root, 'host');
  fs.mkdirSync(path.join(hostRoot, 'etc'), { recursive: true });
  fs.writeFileSync(path.join(hostRoot, 'etc/hostname'), 'testhost\n');
  fs.writeFileSync(path.join(hostRoot, 'etc/os-release'), 'NAME="X"\nPRETTY_NAME="Test OS 1"\n');
  const cfg = {
    port: 0,
    dataDir: path.join(root, 'data'),
    reportDir: path.join(root, 'report'),
    powercapDir: path.join(root, 'none'),
    sysfsRoot: path.join(root, 'sys'),
    hostRoot,
    devFixture: FIXTURE,
    raplFake: true,
    version: '9.9.9',
  };
  const app = await buildApp(cfg, { env: {}, log: quiet, devDelayMs: 5 });
  const reported = once(app.ctx.runner, 'report');
  const server = await app.start();
  await reported;
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (p) => {
    const r = await fetch(base + p);
    return { status: r.status, body: await r.json() };
  };
  const send = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  return { app, cfg, base, get, send };
}

test('API end to end on the dev fixture', async (t) => {
  const { app, cfg, base, get, send } = await boot();
  t.after(() => app.stop());

  const st = await get('/api/status');
  assert.equal(st.status, 200);
  assert.equal(st.body.available, true);
  assert.equal(st.body.version, '9.9.9');
  assert.equal(st.body.host.hostname, 'testhost');
  assert.equal(st.body.host.os, 'Test OS 1');
  assert.equal(st.body.caps.rapl, true);
  assert.equal(st.body.caps.perf, true);
  assert.equal(st.body.runner.mode, 'adaptive');
  assert.equal(st.body.tuningEnabled, true);

  const data = await get('/api/data');
  assert.equal(data.body.data.tuning.bad.length, 4);
  assert.equal(data.body.data.tuning.bad[0].excluded, false);
  assert.equal(data.body.data.wakeup[0].enabled, false);

  const sum = await get('/api/summary');
  assert.equal(sum.body.kpi.openTunables, 4);
  assert.equal(typeof sum.body.kpi.pkgW, 'number');
  assert.deepEqual(sum.body.kpi.deep, { label: 'PC6+', pct: 87.6 });

  const set = await get('/api/settings');
  assert.equal(set.body.mqtt.passwordSet, false);
  assert.equal('password' in set.body.mqtt, false);

  const bad = await send('PUT', '/api/settings', { run: { mode: 'x' } });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /run.mode/);
  const good = await send('PUT', '/api/settings', { run: { mode: 'paused' } });
  assert.equal(good.body.run.mode, 'paused');

  const badJson = await fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{oops' });
  assert.equal(badJson.status, 400);

  const id = data.body.data.tuning.bad[0].id;
  const applied = await send('POST', '/api/tuning/apply', { ids: [id] });
  assert.equal(applied.body.results[0].ok, true);
  assert.equal(
    fs.readFileSync(path.join(cfg.sysfsRoot, '/sys/class/scsi_host/host0/link_power_management_policy'), 'utf8'),
    'med_power_with_dipm\n'
  );

  const ex = await send('POST', '/api/tuning/exclude', { key: '/sys/class/scsi_host/host1/link_power_management_policy', exclude: true });
  assert.deepEqual(ex.body.exclude, ['/sys/class/scsi_host/host1/link_power_management_policy']);
  assert.equal((await get('/api/summary')).body.kpi.openTunables, 3);
  const unex = await send('POST', '/api/tuning/exclude', { key: '/sys/class/scsi_host/host1/link_power_management_policy', exclude: false });
  assert.deepEqual(unex.body.exclude, []);

  const auto = await send('POST', '/api/auto-tune');
  assert.equal(auto.body.success, true);
  assert.equal(auto.body.applied, 4);

  const hist = await get('/api/history?range=1h');
  assert.equal(hist.body.range, '1h');
  assert.ok(hist.body.runs.t.length >= 1);
  assert.ok(hist.body.events.some((e) => e.kind === 'tune'));

  const live = await get('/api/power/live');
  assert.ok(live.body.rapl.length >= 1);
  assert.deepEqual(live.body.zones, ['pkg', 'core', 'uncore', 'dram', 'psys']);

  assert.equal((await get('/api/impact')).body.running, false);
  assert.equal((await send('DELETE', '/api/impact')).status, 409);
  assert.equal((await get('/api/mqtt/discover')).status, 503);
  assert.equal((await get('/api/peer/0/status')).status, 404);
  assert.equal((await get('/api/nope')).status, 404);
  assert.equal((await send('POST', '/api/measure')).status, 202);

  const peers = await get('/api/peers');
  assert.equal(peers.body.self.host, 'testhost');
  assert.deepEqual(peers.body.peers, []);

  const css = await fetch(`${base}/vendor/uplot/uPlot.min.css`);
  assert.equal(css.status, 200);
});

test('SSE stream says hello and counts as a viewer', async (t) => {
  const { app, base } = await boot();
  t.after(() => app.stop());
  const ac = new AbortController();
  const r = await fetch(`${base}/api/events`, { signal: ac.signal });
  assert.equal(r.headers.get('content-type'), 'text/event-stream');
  const reader = r.body.getReader();
  let text = '';
  while (!text.includes('event: hello')) {
    const { value, done } = await reader.read();
    if (done) break;
    text += Buffer.from(value).toString();
  }
  assert.match(text, /event: hello\ndata: \{"available":true/);
  assert.equal(app.ctx.runner.viewers, 1);
  ac.abort();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(app.ctx.runner.viewers, 0);
});
