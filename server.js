'use strict';
const { loadConfig } = require('./src/config');
const { buildApp } = require('./src/app');

async function main() {
  const cfg = loadConfig();
  const app = await buildApp(cfg);
  const server = await app.start();
  const s = app.ctx.settings.get();
  console.log(
    `PowerTop ${cfg.version} on :${server.address().port} | data ${cfg.dataDir} | report ${cfg.reportDir} | mode ${s.run.mode}` +
      ` | RAPL ${app.ctx.rapl.available ? app.ctx.rapl.zones.map((z) => z.key).join('/') : 'n/a'}` +
      ` | tuning ${s.tuning.enabled ? 'on' : 'off'}${cfg.devFixture ? ' | DEV fixture' : ''}`
  );
  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal}: flushing history and stopping`);
    const force = setTimeout(() => process.exit(0), 8000);
    force.unref();
    try {
      await app.stop();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
