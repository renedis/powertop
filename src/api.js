'use strict';
const express = require('express');
const { deepIdle } = require('./parser');
const { Tuning } = require('./tuning');

const iso = (t) => (t ? new Date(t).toISOString() : null);

function caps(ctx) {
  const report = ctx.runner.latest && ctx.runner.latest.report;
  return {
    ...(report ? report.caps : { perf: false, pkgCstates: false, cpufreq: false }),
    rapl: ctx.rapl.available,
    raplZones: ctx.rapl.zones.map((z) => z.key),
    wall: Boolean(ctx.sensors.wallSensor()),
    mqtt: Boolean(ctx.settings.get().mqtt.url),
    udm: Boolean(ctx.udm && ctx.udm.available),
  };
}

function summary(ctx) {
  const report = ctx.runner.latest && ctx.runner.latest.report;
  const live = ctx.collector.live();
  const exclude = ctx.settings.get().tuning.exclude;
  const run = ctx.runner.status();
  return {
    host: ctx.host().hostname,
    version: ctx.cfg.version,
    caps: caps(ctx),
    tuningEnabled: ctx.tuning.enabled(),
    kpi: {
      wallW: live.wall,
      pkgW: live.pkg,
      psysW: live.psys,
      cpuPct: report ? report.summary.cpuPct : null,
      wakeups: report ? report.summary.wakeups : null,
      deep: report ? deepIdle(report) : null,
      openTunables: report ? report.tuning.bad.filter((x) => !Tuning.isExcluded(x, exclude)).length : null,
      udm: ctx.udm ? ctx.udm.kpi() : null,
    },
    runner: { state: run.state, mode: run.mode, lastUpdated: iso(run.lastUpdated), nextRunAt: iso(run.nextRunAt) },
  };
}

function status(ctx) {
  const run = ctx.runner.status();
  return {
    available: Boolean(ctx.runner.latest),
    lastUpdated: iso(run.lastUpdated),
    version: ctx.cfg.version,
    host: ctx.host(),
    runner: run,
    caps: caps(ctx),
    tuningEnabled: ctx.tuning.enabled(),
    tuningLocked: ctx.settings.locked().includes('tuning.enabled'),
    impactRunning: ctx.impact.running,
    viewers: ctx.hub.count(),
  };
}

function createApi(ctx) {
  const r = express.Router();
  const { settings, runner, rapl, sensors, history, tuning, impact, peers, hub } = ctx;
  const handle = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  };

  r.get('/status', (req, res) => res.json(status(ctx)));
  r.get('/summary', (req, res) => res.json(summary(ctx)));
  r.get('/data', (req, res) => {
    const latest = runner.latest;
    if (!latest) return res.status(202).json({ available: false });
    return res.json({ available: true, lastUpdated: iso(latest.mtime), data: tuning.annotate(latest.report) });
  });
  r.get('/events', hub.handler);

  r.post('/measure', (req, res) => {
    const out = runner.measureNow();
    res.status(out.ok ? 202 : 409).json(out);
  });

  r.get('/power/live', (req, res) => {
    const wall = sensors.wallSensor();
    const now = Date.now();
    res.json({ rapl: rapl.live(), zones: rapl.zones.map((z) => z.key), wall: wall ? sensors.points(wall.id, now - 600000, now) : [] });
  });
  r.get('/history', (req, res) => res.json(history.query(String(req.query.range || '24h'))));
  r.get('/udm', (req, res) => res.json(ctx.udm ? ctx.udm.snapshot() : { available: false }));
  r.get('/udm/history', (req, res) => {
    if (!ctx.udm || !ctx.udm.available) return res.status(404).json({ error: 'not a UniFi console' });
    return res.json(history.queryUdm(String(req.query.range || '24h')));
  });

  r.post('/tuning/apply', handle(async (req, res) => res.json({ results: await tuning.apply((req.body || {}).ids) })));
  r.post('/tuning/auto', handle(async (req, res) => res.json(await tuning.autoTune())));
  r.post('/auto-tune', handle(async (req, res) => {
    const out = await tuning.autoTune();
    res.json({ success: out.failed === 0, output: `Applied ${out.applied}, skipped ${out.skipped}, failed ${out.failed}.`, ...out });
  }));
  r.post('/tuning/exclude', handle(async (req, res) => {
    const { key, exclude } = req.body || {};
    if (typeof key !== 'string' || !key.trim()) throw Object.assign(new Error('key is required'), { status: 400 });
    const list = settings.get().tuning.exclude.filter((x) => x !== key);
    if (exclude !== false) list.push(key);
    settings.update({ tuning: { exclude: list } });
    res.json({ exclude: settings.get().tuning.exclude });
  }));
  r.post('/wake/:id/toggle', handle(async (req, res) => res.json(await tuning.toggleWake(req.params.id))));

  r.get('/settings', (req, res) => res.json(settings.public()));
  r.put('/settings', handle(async (req, res) => {
    settings.update(req.body);
    res.json(settings.public());
  }));

  r.get('/mqtt/status', (req, res) => res.json(sensors.status()));
  r.get('/mqtt/discover', handle(async (req, res) => res.json({ devices: await sensors.discover() })));

  r.get('/impact', (req, res) => res.json(impact.status()));
  r.post('/impact', handle(async (req, res) => res.status(202).json(impact.start((req.body || {}).ids))));
  r.delete('/impact', handle(async (req, res) => res.json(impact.cancel())));

  r.get('/peers', handle(async (req, res) => res.json({ self: summary(ctx), peers: await peers.summaries() })));
  r.all('/peer/:idx/*path', peers.proxy);

  r.use((req, res) => res.status(404).json({ error: 'not found' }));
  // JSON body parse errors and anything thrown synchronously
  r.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    return res.status(err.status || err.statusCode || 500).json({ error: err.message });
  });
  return r;
}

module.exports = { createApi, summary, status };
