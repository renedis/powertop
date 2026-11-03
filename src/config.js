'use strict';
const fs = require('fs');
const path = require('path');

function isMountpoint(dir) {
  try {
    return fs.statSync(dir).dev !== fs.statSync(path.dirname(dir)).dev;
  } catch {
    return false;
  }
}

/**
 * DATA_DIR wins; otherwise /data when mounted, then the v1 compose mount
 * /tmp/powertop, else /data inside the container.
 */
function resolveDataDir(env, isMp = isMountpoint) {
  if (env.DATA_DIR) return path.resolve(env.DATA_DIR);
  if (isMp('/data')) return '/data';
  if (isMp('/tmp/powertop')) return '/tmp/powertop';
  return '/data';
}

function loadConfig(env = process.env) {
  return {
    port: Number(env.PORT) || 3000,
    dataDir: resolveDataDir(env),
    reportDir: path.resolve(env.REPORT_DIR || '/dev/shm/powertop'),
    powercapDir: env.POWERCAP_DIR || '/sys/class/powercap',
    sysfsRoot: env.SYSFS_ROOT ? path.resolve(env.SYSFS_ROOT) : '',
    hostRoot: env.HOST_ROOT || '/proc/1/root',
    devFixture: env.DEV_FIXTURE ? path.resolve(env.DEV_FIXTURE) : '',
    raplFake: env.RAPL_FAKE === '1',
    version: require('../package.json').version,
  };
}

module.exports = { loadConfig, resolveDataDir, isMountpoint };
