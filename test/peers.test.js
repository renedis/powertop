'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { EventEmitter, once } = require('events');
const express = require('express');
const { Hub } = require('../src/sse');
const { Peers } = require('../src/peers');

function fakeRes() {
  const res = new EventEmitter();
  res.chunks = [];
  res.headers = null;
  res.writeHead = (code, headers) => (res.headers = { code, ...headers });
  res.flushHeaders = () => {};
  res.write = (c) => res.chunks.push(c);
  res.end = () => res.emit('close');
  return res;
}

test('hub counts viewers and writes SSE frames', () => {
  const hub = new Hub({ heartbeatMs: 1000000 });
  const counts = [];
  hub.on('viewers', (n) => counts.push(n));
  const a = fakeRes();
  const b = fakeRes();
  hub.handler({}, a);
  hub.handler({}, b);
  assert.equal(a.headers['Content-Type'], 'text/event-stream');
  hub.send('power', { pkg: 1.5 });
  assert.ok(a.chunks.includes('event: power\ndata: {"pkg":1.5}\n\n'));
  assert.ok(b.chunks.includes('event: power\ndata: {"pkg":1.5}\n\n'));
  a.emit('close');
  assert.deepEqual(counts, [1, 2, 1]);
  assert.equal(hub.count(), 1);
  hub.closeAll();
  assert.equal(hub.count(), 0);
});

const settingsWith = (peers) => ({ get: () => ({ peers }) });

test('targetUrl builds peer API urls and rejects nesting and traversal', () => {
  const p = { name: 'a', url: 'http://192.168.1.20:9002' };
  assert.equal(Peers.targetUrl(p, ['data'], '?x=1'), 'http://192.168.1.20:9002/api/data?x=1');
  assert.equal(Peers.targetUrl(p, ['wake', 'abc', 'toggle'], ''), 'http://192.168.1.20:9002/api/wake/abc/toggle');
  for (const segs of [['peer', '0', 'data'], ['..', 'x'], [], ['a', ''], ['.']]) {
    assert.throws(() => Peers.targetUrl(p, segs, ''), (e) => e.status === 400, JSON.stringify(segs));
  }
});

test('summaries: ok, outdated (404), unreachable', async () => {
  const fetch = async (url) => {
    if (url.startsWith('http://ok')) return new Response(JSON.stringify({ host: 'ok' }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.startsWith('http://old')) return new Response('nope', { status: 404 });
    throw new Error('connect ECONNREFUSED');
  };
  const peers = new Peers({
    settings: settingsWith([
      { name: 'ok', url: 'http://ok:1' },
      { name: 'old', url: 'http://old:1' },
      { name: 'down', url: 'http://down:1' },
    ]),
    fetch,
  });
  const s = await peers.summaries();
  assert.deepEqual(s[0], { idx: 0, name: 'ok', url: 'http://ok:1', ok: true, summary: { host: 'ok' } });
  assert.equal(s[1].outdated, true);
  assert.equal(s[1].ok, false);
  assert.match(s[2].error, /ECONNREFUSED/);
});

test('proxy forwards method, query and JSON body; unknown peer is 404', async () => {
  const upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null }));
    });
  });
  upstream.listen(0);
  await once(upstream, 'listening');
  const peers = new Peers({ settings: settingsWith([{ name: 'up', url: `http://127.0.0.1:${upstream.address().port}` }]) });
  const app = express();
  app.use(express.json());
  app.all('/api/peer/:idx/*path', peers.proxy);
  const server = app.listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;

  const r = await fetch(`${base}/api/peer/0/tuning/apply?dry=1`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids: ['x'] }),
  });
  assert.equal(r.status, 201);
  assert.deepEqual(await r.json(), { method: 'POST', url: '/api/tuning/apply?dry=1', body: { ids: ['x'] } });

  assert.equal((await fetch(`${base}/api/peer/5/status`)).status, 404);
  assert.equal((await fetch(`${base}/api/peer/0/peer/0/status`)).status, 400);
  server.close();
  upstream.close();
});

test('proxy returns 502 when the peer is unreachable', async () => {
  const peers = new Peers({ settings: settingsWith([{ name: 'gone', url: 'http://127.0.0.1:9' }]) });
  const app = express();
  app.all('/api/peer/:idx/*path', peers.proxy);
  const server = app.listen(0);
  await once(server, 'listening');
  const r = await fetch(`http://127.0.0.1:${server.address().port}/api/peer/0/status`);
  assert.equal(r.status, 502);
  server.close();
});
