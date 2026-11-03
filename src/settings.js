'use strict';
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const MODES = ['adaptive', 'continuous', 'ondemand', 'paused'];
const ROLES = ['wall', 'extra'];

const DEFAULTS = Object.freeze({
  run: { mode: 'adaptive', fastIntervalSec: 60, idleIntervalSec: 900, measureSec: 20 },
  tuning: { enabled: true, exclude: [] },
  mqtt: { url: '', username: '', password: '', baseTopic: 'zigbee2mqtt' },
  sensors: [],
  peers: [],
  history: { days: 7 },
  impact: { settleSec: 30, windowSec: 180 },
});

const ARRAY_SECTIONS = ['sensors', 'peers'];

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

const clone = (o) => JSON.parse(JSON.stringify(o));
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Shallow merge per section; array sections and nested arrays are replaced. */
function merge(base, patch) {
  const out = clone(base);
  if (!isObj(patch)) return out;
  for (const [key, val] of Object.entries(patch)) {
    if (!(key in DEFAULTS)) continue;
    if (ARRAY_SECTIONS.includes(key)) out[key] = val;
    else if (isObj(val)) out[key] = { ...(out[key] || {}), ...val };
  }
  return out;
}

function int(v, min, max, name) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (!Number.isInteger(n) || n < min || n > max) throw new ValidationError(`${name} must be an integer between ${min} and ${max}`);
  return n;
}

function bool(v, name) {
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  throw new ValidationError(`${name} must be true or false`);
}

function str(v, max, name, re) {
  if (v === undefined || v === null) v = '';
  if (typeof v !== 'string') throw new ValidationError(`${name} must be a string`);
  const s = v.trim();
  if (s.length > max) throw new ValidationError(`${name} is too long`);
  if (re && s && !re.test(s)) throw new ValidationError(`${name} is invalid`);
  return s;
}

function list(v, max, name) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > max) throw new ValidationError(`${name} must be a list of at most ${max}`);
  return v;
}

const slug = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 28);

function validate(s) {
  if (!MODES.includes(s.run.mode)) throw new ValidationError(`run.mode must be one of ${MODES.join(', ')}`);
  const run = {
    mode: s.run.mode,
    fastIntervalSec: int(s.run.fastIntervalSec, 30, 3600, 'run.fastIntervalSec'),
    idleIntervalSec: int(s.run.idleIntervalSec, 60, 86400, 'run.idleIntervalSec'),
    measureSec: int(s.run.measureSec, 5, 120, 'run.measureSec'),
  };

  const exclude = [
    ...new Set(list(s.tuning.exclude, 500, 'tuning.exclude').map((x) => str(x, 512, 'tuning.exclude entry')).filter(Boolean)),
  ];
  const tuning = { enabled: bool(s.tuning.enabled, 'tuning.enabled'), exclude };

  const password = s.mqtt.password === undefined || s.mqtt.password === null ? '' : s.mqtt.password;
  if (typeof password !== 'string' || password.length > 256) throw new ValidationError('mqtt.password is invalid');
  const mqtt = {
    url: str(s.mqtt.url, 256, 'mqtt.url', /^(mqtts?|wss?):\/\/\S+$/),
    username: str(s.mqtt.username, 128, 'mqtt.username'),
    password,
    baseTopic: str(s.mqtt.baseTopic, 128, 'mqtt.baseTopic', /^[^#+\s][^#+]*$/) || 'zigbee2mqtt',
  };

  const ids = new Set();
  const sensors = list(s.sensors, 32, 'sensors').map((x, i) => {
    if (!isObj(x)) throw new ValidationError('sensor must be an object');
    const topic = str(x.topic, 256, 'sensor topic', /^[^#+]+$/);
    if (!topic) throw new ValidationError('sensor topic is required');
    const name = str(x.name, 64, 'sensor name') || topic;
    if (!ROLES.includes(x.role)) throw new ValidationError(`sensor role must be one of ${ROLES.join(', ')}`);
    let id = slug(str(x.id, 32, 'sensor id') || name) || `s${i + 1}`;
    for (let n = 2; ids.has(id); n++) id = `${slug(x.id || name)}-${n}`;
    ids.add(id);
    return {
      id,
      name,
      topic,
      path: x.path === undefined || x.path === null ? 'power' : str(x.path, 128, 'sensor path', /^[A-Za-z0-9_.-]+$/),
      unit: str(x.unit ?? 'W', 8, 'sensor unit'),
      role: x.role,
    };
  });
  if (sensors.filter((x) => x.role === 'wall').length > 1) throw new ValidationError('only one wall sensor is allowed');

  const peers = list(s.peers, 16, 'peers').map((p) => {
    if (!isObj(p)) throw new ValidationError('peer must be an object');
    const url = str(p.url, 256, 'peer url', /^https?:\/\/\S+$/).replace(/\/+$/, '');
    if (!url) throw new ValidationError('peer url is required');
    return { name: str(p.name, 64, 'peer name') || url.replace(/^https?:\/\//, ''), url };
  });

  return {
    run,
    tuning,
    mqtt,
    sensors,
    peers,
    history: { days: int(s.history.days, 1, 90, 'history.days') },
    impact: {
      settleSec: int(s.impact.settleSec, 0, 600, 'impact.settleSec'),
      windowSec: int(s.impact.windowSec, 30, 1800, 'impact.windowSec'),
    },
  };
}

function parsePeers(value) {
  return String(value)
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const i = x.indexOf('=');
      return i > 0 ? { name: x.slice(0, i).trim(), url: x.slice(i + 1).trim() } : { name: '', url: x };
    });
}

/** One patch per env variable so a bad value only drops itself. */
function envPatches(env) {
  const p = [];
  const num = (v) => (/^\d+$/.test(String(v).trim()) ? Number(v) : v);
  if (env.MODE) p.push({ run: { mode: env.MODE } });
  if (env.FAST_INTERVAL) p.push({ run: { fastIntervalSec: num(env.FAST_INTERVAL) } });
  if (env.IDLE_INTERVAL) p.push({ run: { idleIntervalSec: num(env.IDLE_INTERVAL) } });
  if (env.MEASURE_SECONDS) p.push({ run: { measureSec: num(env.MEASURE_SECONDS) } });
  if (env.TUNING_ENABLED) p.push({ tuning: { enabled: env.TUNING_ENABLED } });
  if (env.MQTT_URL) p.push({ mqtt: { url: env.MQTT_URL } });
  if (env.MQTT_USER) p.push({ mqtt: { username: env.MQTT_USER } });
  if (env.MQTT_PASS) p.push({ mqtt: { password: env.MQTT_PASS } });
  if (env.MQTT_BASE_TOPIC) p.push({ mqtt: { baseTopic: env.MQTT_BASE_TOPIC } });
  if (env.WALL_TOPIC) {
    p.push({ sensors: [{ id: 'wall', name: 'Wall', topic: env.WALL_TOPIC, path: env.WALL_PATH || 'power', unit: 'W', role: 'wall' }] });
  }
  if (env.PEERS) p.push({ peers: parsePeers(env.PEERS) });
  if (env.HISTORY_DAYS) p.push({ history: { days: num(env.HISTORY_DAYS) } });
  return p;
}

class Settings extends EventEmitter {
  constructor({ file, env = process.env, log = console }) {
    super();
    this.file = file;
    this.env = env;
    this.log = log;
    this.base = clone(DEFAULTS);
    this.user = {};
    this.locks = {};
    this.current = clone(DEFAULTS);
  }

  load() {
    let base = clone(DEFAULTS);
    for (const patch of envPatches(this.env)) {
      try {
        base = validate(merge(base, patch));
      } catch (e) {
        this.log.warn(`settings: ignoring env value (${e.message})`);
      }
    }
    this.base = base;
    this.locks = String(this.env.TUNING_ENABLED).toLowerCase() === 'false' || this.env.TUNING_ENABLED === '0' ? { 'tuning.enabled': false } : {};
    let user = {};
    try {
      if (this.file && fs.existsSync(this.file)) user = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (e) {
      this.log.warn(`settings: ${this.file} unreadable, using defaults (${e.message})`);
    }
    try {
      this.current = this._effective(user);
      this.user = isObj(user) ? user : {};
    } catch (e) {
      this.log.warn(`settings: stored settings invalid, using defaults (${e.message})`);
      this.current = this._effective({});
      this.user = {};
    }
    return this;
  }

  _effective(user) {
    const v = validate(merge(this.base, user));
    if ('tuning.enabled' in this.locks) v.tuning.enabled = this.locks['tuning.enabled'];
    return v;
  }

  get() {
    return clone(this.current);
  }

  locked() {
    return Object.keys(this.locks);
  }

  public() {
    const v = this.get();
    v.mqtt.passwordSet = Boolean(v.mqtt.password);
    delete v.mqtt.password;
    v.locked = this.locked();
    return v;
  }

  update(patch) {
    if (!isObj(patch)) throw new ValidationError('settings patch must be an object');
    if (isObj(patch.tuning) && 'enabled' in patch.tuning && 'tuning.enabled' in this.locks) {
      if (bool(patch.tuning.enabled, 'tuning.enabled') !== this.locks['tuning.enabled']) {
        throw new ValidationError('tuning.enabled is locked by the TUNING_ENABLED environment variable');
      }
    }
    const merged = merge(this.user, patch);
    const next = this._effective(merged);
    // persist validated values for exactly the keys the user has set
    const user = {};
    for (const [section, val] of Object.entries(merged)) {
      if (ARRAY_SECTIONS.includes(section)) user[section] = next[section];
      else if (isObj(val)) {
        user[section] = {};
        for (const key of Object.keys(val)) if (key in next[section]) user[section][key] = next[section][key];
      }
    }
    const prev = this.current;
    this.user = user;
    this.current = next;
    this._save();
    this.emit('change', this.get(), prev);
    return this.get();
  }

  _save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.user, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { Settings, DEFAULTS, ValidationError, validate, merge, parsePeers };
