'use strict';
const os = require('os');
const { EventEmitter } = require('events');

const httpError = (status, message) => Object.assign(new Error(message), { status });
const SKIP_FIELDS = new Set(['linkquality', 'countdown']);

function walkExposes(node, out) {
  if (Array.isArray(node)) node.forEach((n) => walkExposes(n, out));
  else if (node && typeof node === 'object') {
    if (node.type === 'numeric' && node.property && !SKIP_FIELDS.has(node.property) && !out.some((f) => f.property === node.property)) {
      out.push({ property: node.property, unit: node.unit || '' });
    }
    if (node.features) walkExposes(node.features, out);
  }
  return out;
}

/**
 * MQTT-fed sensors (e.g. zigbee2mqtt smart plugs). Keeps the latest value and
 * a 30-minute point history per sensor for time-weighted means.
 */
class Sensors extends EventEmitter {
  constructor({ settings, connect, now = Date.now, log = console, staleMs = 600000, keepMs = 1800000, hostname = os.hostname() }) {
    super();
    this.settings = settings;
    this.connectFn = connect || ((...a) => require('mqtt').connect(...a));
    this.now = now;
    this.log = log;
    this.staleMs = staleMs;
    this.keepMs = keepMs;
    this.hostname = hostname;
    this.client = null;
    this.connKey = null;
    this.connected = false;
    this.error = null;
    this.url = '';
    this.baseTopic = 'zigbee2mqtt';
    this.sensors = [];
    this.subscribed = new Set();
    this.values = new Map();
    this.waiters = new Set();
    this.onSettings = (next) => this._apply(next || this.settings.get());
  }

  start() {
    this._apply(this.settings.get());
    this.settings.on('change', this.onSettings);
  }

  close() {
    this.settings.removeListener('change', this.onSettings);
    this._disconnect();
  }

  _apply(s) {
    const cfg = s.mqtt;
    this.sensors = s.sensors;
    this.baseTopic = cfg.baseTopic || 'zigbee2mqtt';
    for (const id of [...this.values.keys()]) if (!this.sensors.some((x) => x.id === id)) this.values.delete(id);
    const key = JSON.stringify([cfg.url, cfg.username, cfg.password]);
    if (key !== this.connKey) {
      this._disconnect();
      this.connKey = key;
      this.url = cfg.url;
      if (cfg.url) this._connect(cfg);
    } else {
      this._resubscribe(false);
    }
    this.emit('status', this.status());
  }

  _connect(cfg) {
    this.error = null;
    this.connected = false;
    const suffix = Math.random().toString(16).slice(2, 8);
    const client = this.connectFn(cfg.url, {
      username: cfg.username || undefined,
      password: cfg.password || undefined,
      clientId: `powertop-${this.hostname}-${suffix}`.slice(0, 64),
      reconnectPeriod: 10000,
      connectTimeout: 10000,
      clean: true,
    });
    client.on('connect', () => {
      this.connected = true;
      this.error = null;
      this.subscribed = new Set();
      this._resubscribe(true);
      this.emit('status', this.status());
    });
    client.on('close', () => {
      if (!this.connected) return;
      this.connected = false;
      this.emit('status', this.status());
    });
    client.on('error', (e) => {
      this.error = e.message;
      this.emit('status', this.status());
    });
    client.on('message', (topic, payload) => this.handleMessage(topic, payload));
    this.client = client;
  }

  _disconnect() {
    if (this.client) {
      try {
        this.client.end(true);
      } catch {
        /* ignore */
      }
    }
    this.client = null;
    this.connected = false;
    this.subscribed = new Set();
  }

  _resubscribe(force) {
    const topics = new Set(this.sensors.map((s) => s.topic));
    if (!this.client || !this.connected) {
      return;
    }
    for (const t of this.subscribed) if (!topics.has(t)) this.client.unsubscribe(t);
    for (const t of topics) if (force || !this.subscribed.has(t)) this.client.subscribe(t, { qos: 0 });
    this.subscribed = topics;
  }

  static extract(text, pathStr) {
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    const asNum = (v) => {
      if (typeof v === 'number') return Number.isFinite(v) ? v : null;
      if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
      return null;
    };
    if (typeof data !== 'object' || data === null) return asNum(data);
    if (!pathStr) return null;
    let cur = data;
    for (const k of pathStr.split('.')) {
      if (cur === null || typeof cur !== 'object') return null;
      cur = cur[k];
    }
    return asNum(cur);
  }

  handleMessage(topic, payload) {
    const text = payload.toString();
    for (const w of this.waiters) if (w.topic === topic) w.resolve(text);
    const t = this.now();
    for (const s of this.sensors) {
      if (s.topic !== topic) continue;
      const v = Sensors.extract(text, s.path);
      if (v === null) continue;
      const st = this.values.get(s.id) || { value: null, ts: 0, points: [] };
      st.value = v;
      st.ts = t;
      st.points.push({ t, v });
      const cutoff = t - this.keepMs;
      while (st.points.length > 1 && st.points[1].t < cutoff) st.points.shift();
      this.values.set(s.id, st);
      this.emit('sensor', { id: s.id, value: v, ts: t, role: s.role });
    }
  }

  value(id) {
    const st = this.values.get(id);
    if (!st || this.now() - st.ts > this.staleMs) return null;
    return { value: st.value, ts: st.ts };
  }

  wallSensor() {
    return this.sensors.find((s) => s.role === 'wall') || null;
  }

  wall() {
    const s = this.wallSensor();
    return s ? this.value(s.id) : null;
  }

  /** Points inside [from, to] plus the last one before `from` (value in effect). */
  points(id, from, to) {
    const st = this.values.get(id);
    if (!st) return [];
    let before = null;
    const inside = [];
    for (const p of st.points) {
      if (p.t <= from) before = p;
      else if (p.t <= to) inside.push(p);
    }
    return before ? [before, ...inside] : inside;
  }

  status() {
    const now = this.now();
    return {
      configured: Boolean(this.url),
      connected: this.connected,
      error: this.error,
      url: this.url,
      baseTopic: this.baseTopic,
      sensors: this.sensors.map((s) => {
        const st = this.values.get(s.id);
        return {
          id: s.id,
          name: s.name,
          role: s.role,
          unit: s.unit,
          topic: s.topic,
          path: s.path,
          value: st ? st.value : null,
          ts: st ? st.ts : null,
          stale: !st || now - st.ts > this.staleMs,
        };
      }),
    };
  }

  static parseDevices(text, baseTopic) {
    const list = JSON.parse(text);
    if (!Array.isArray(list)) return [];
    return list
      .filter((d) => d && d.type !== 'Coordinator' && d.friendly_name)
      .map((d) => {
        const def = d.definition || {};
        return {
          name: d.friendly_name,
          topic: `${baseTopic}/${d.friendly_name}`,
          model: def.model || null,
          vendor: def.vendor || null,
          fields: walkExposes(def.exposes || [], []),
        };
      })
      .filter((d) => d.fields.length)
      .sort((a, b) => {
        const pa = a.fields.some((f) => f.property === 'power') ? 0 : 1;
        const pb = b.fields.some((f) => f.property === 'power') ? 0 : 1;
        return pa - pb || a.name.localeCompare(b.name);
      });
  }

  /** Reads the retained zigbee2mqtt device list. */
  discover({ timeoutMs = 5000 } = {}) {
    if (!this.client || !this.connected) return Promise.reject(httpError(503, 'MQTT is not connected'));
    const topic = `${this.baseTopic}/bridge/devices`;
    const client = this.client;
    return new Promise((resolve, reject) => {
      const waiter = { topic };
      const cleanup = () => {
        clearTimeout(timer);
        this.waiters.delete(waiter);
        if (!this.subscribed.has(topic) && client === this.client) client.unsubscribe(topic);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(httpError(504, `no device list on ${topic}`));
      }, timeoutMs);
      waiter.resolve = (text) => {
        cleanup();
        try {
          resolve(Sensors.parseDevices(text, this.baseTopic));
        } catch (e) {
          reject(httpError(502, `bad device list: ${e.message}`));
        }
      };
      this.waiters.add(waiter);
      client.subscribe(topic, { qos: 0 });
    });
  }
}

module.exports = { Sensors };
