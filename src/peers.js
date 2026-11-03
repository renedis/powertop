'use strict';
const { Readable } = require('stream');

const httpError = (status, message) => Object.assign(new Error(message), { status });

/** Other PowerTop instances: summaries for the fleet strip and an API proxy. */
class Peers {
  constructor({ settings, fetch = globalThis.fetch, timeoutMs = 3000, requestTimeoutMs = 15000 }) {
    this.settings = settings;
    this.fetch = fetch;
    this.timeoutMs = timeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.proxy = this.proxy.bind(this);
  }

  list() {
    return this.settings.get().peers.map((p, idx) => ({ idx, ...p }));
  }

  peer(idx) {
    if (!/^\d+$/.test(String(idx))) return null;
    return this.list()[Number(idx)] || null;
  }

  static targetUrl(peer, segments, search) {
    if (!segments.length || segments[0] === 'peer' || segments.some((s) => s === '' || s === '.' || s === '..')) {
      throw httpError(400, 'invalid peer path');
    }
    const u = new URL(`${peer.url}/api/${segments.map(encodeURIComponent).join('/')}`);
    u.search = search || '';
    return u.toString();
  }

  async summaries() {
    return Promise.all(
      this.list().map(async (p) => {
        try {
          const r = await this.fetch(`${p.url}/api/summary`, { signal: AbortSignal.timeout(this.timeoutMs) });
          if (r.status === 404) return { ...p, ok: false, outdated: true, error: 'older PowerTop version (no /api/summary)' };
          if (!r.ok) return { ...p, ok: false, error: `HTTP ${r.status}` };
          return { ...p, ok: true, summary: await r.json() };
        } catch (e) {
          return { ...p, ok: false, error: e.name === 'TimeoutError' ? 'timeout' : e.message };
        }
      })
    );
  }

  async proxy(req, res) {
    const peer = this.peer(req.params.idx);
    if (!peer) return res.status(404).json({ error: 'unknown peer' });
    const segments = [].concat(req.params.path || []);
    let url;
    try {
      url = Peers.targetUrl(peer, segments, new URL(req.originalUrl, 'http://local').search);
    } catch (e) {
      return res.status(e.status || 400).json({ error: e.message });
    }
    const sse = segments.length === 1 && segments[0] === 'events';
    const ac = new AbortController();
    res.on('close', () => ac.abort());
    const timer = sse ? null : setTimeout(() => ac.abort(), this.requestTimeoutMs);
    const init = { method: req.method, headers: { accept: req.headers.accept || '*/*' }, signal: ac.signal };
    if (!['GET', 'HEAD'].includes(req.method) && req.body !== undefined) {
      init.body = JSON.stringify(req.body);
      init.headers['content-type'] = 'application/json';
    }
    try {
      const up = await this.fetch(url, init);
      res.status(up.status);
      const ct = up.headers.get('content-type');
      if (ct) res.setHeader('Content-Type', ct);
      if (sse) {
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();
      }
      if (!up.body) return res.end();
      Readable.fromWeb(up.body)
        .on('error', () => res.end())
        .pipe(res);
    } catch (e) {
      if (!res.headersSent) res.status(502).json({ error: `peer unreachable (${e.name === 'AbortError' ? 'timeout' : e.message})` });
      else res.end();
    } finally {
      clearTimeout(timer);
    }
    return undefined;
  }
}

module.exports = { Peers };
