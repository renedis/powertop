'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const readTrim = (file) => {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
};

/**
 * Host identity. With pid=host, /proc/1/root is the host's root filesystem, so
 * the hostname and OS are the host's, not the container's.
 */
function hostInfo({ hostRoot = '/proc/1/root', report = null } = {}) {
  const hostname = readTrim(path.join(hostRoot, 'etc/hostname')).split('\n')[0] || os.hostname();
  const osRelease = readTrim(path.join(hostRoot, 'etc/os-release'));
  const pretty = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(osRelease);
  const sys = (report && report.sysinfo) || {};
  return {
    hostname,
    os: pretty ? pretty[1] : sys.os || null,
    kernel: sys.kernel || os.release(),
    cpu: sys.cpu || null,
    cpuCount: sys.cpuCount || os.cpus().length,
    system: sys.system || null,
    arch: process.arch,
  };
}

module.exports = { hostInfo };
