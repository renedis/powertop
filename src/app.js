'use strict';
const path = require('path');
const express = require('express');
const { Settings } = require('./settings');
const { History } = require('./history');
const { Runner } = require('./runner');
const { Rapl } = require('./rapl');
const { Sensors } = require('./sensors');
const { Tuning } = require('./tuning');
const { Impact } = require('./impact');
const { Peers } = require('./peers');
const { Hub } = require('./sse');
const { Collector } = require('./collector');
const { hostInfo } = require('./host');
const { parseReport, deepIdle } = require('./parser');
const { createApi, status } = require('./api');

/**
 * Builds every component and the Express app. `start()` begins sampling,
 * scheduling and listening; `stop()` flushes history and closes everything.
 */
async function buildApp(cfg, { env = process.env, log = console, mqttConnect, devDelayMs } = {}) {
  const settings = new Settings({ file: path.join(cfg.dataDir, 'settings.json'), env, log }).load();
  const history = new History({ dir: path.join(cfg.dataDir, 'history'), days: settings.get().history.days, log });
  await history.load();
  const runner = new Runner({ settings, reportDir: cfg.reportDir, devFixture: cfg.devFixture, parse: parseReport, log, devDelayMs });
  const rapl = new Rapl({ dir: cfg.powercapDir, fake: cfg.raplFake });
  const sensors = new Sensors({ settings, connect: mqttConnect, log });
  const tuning = new Tuning({ settings, runner, history, sysfsRoot: cfg.sysfsRoot, log });
  const impact = new Impact({ settings, runner, rapl, sensors, tuning, history, file: path.join(cfg.dataDir, 'impact.json'), log });
  const peers = new Peers({ settings });
  const hub = new Hub();
  const collector = new Collector({ rapl, sensors, history, settings });

  let hostCache = null;
  const host = () => {
    if (!hostCache || (!hostCache.cpu && runner.latest)) hostCache = hostInfo({ hostRoot: cfg.hostRoot, report: runner.latest && runner.latest.report });
    return hostCache;
  };
  const ctx = { cfg, settings, history, runner, rapl, sensors, tuning, impact, peers, hub, collector, host };

  hub.on('connect', (client) => hub.send('hello', status(ctx), client));
  hub.on('viewers', (n) => runner.setViewers(n));
  runner.on('state', (s) => hub.send('runner', s));
  runner.on('report', (latest) => {
    const rep = latest.report;
    const deep = deepIdle(rep);
    history.addRun({
      t: latest.mtime,
      cpu: rep.summary.cpuPct,
      wak: rep.summary.wakeups,
      deep: deep ? deep.pct : null,
      open: rep.tuning.bad.length,
      dur: latest.durationMs === null ? null : Math.round(latest.durationMs / 1000),
    });
    hub.send('report', { lastUpdated: new Date(latest.mtime).toISOString() });
  });
  rapl.on('sample', (s) => hub.send('power', s));
  sensors.on('sensor', (e) => hub.send('sensor', e));
  sensors.on('status', (s) => hub.send('mqtt', s));
  impact.on('state', (s) => hub.send('impact', { running: s.running, test: s.test }));
  history.on('event', (e) => hub.send('event', e));
  settings.on('change', (next) => {
    history.setDays(next.history.days);
    hub.send('settings', settings.public());
  });

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));
  app.use('/api', createApi(ctx));
  app.use('/vendor/uplot', express.static(path.dirname(require.resolve('uplot'))));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  // body-parser errors (bad JSON) arrive here before any router
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    return res.status(err.status || err.statusCode || 500).json({ error: err.status === 400 ? 'invalid JSON body' : err.message });
  });

  let server = null;
  return {
    app,
    ctx,
    async start(port = cfg.port) {
      history.start();
      rapl.start();
      sensors.start();
      collector.start();
      runner.start();
      await new Promise((resolve) => {
        server = app.listen(port, resolve);
      });
      return server;
    },
    async stop() {
      runner.stop();
      rapl.stop();
      collector.stop();
      sensors.close();
      history.stop();
      hub.closeAll();
      await history.flush();
      if (server) {
        server.closeAllConnections?.();
        await new Promise((resolve) => server.close(resolve));
      }
    },
  };
}

module.exports = { buildApp };
