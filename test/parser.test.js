'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseReport, deepIdle, isVirtualNic } = require('../src/parser');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const untuned = parseReport(fixture('intel-untuned.html'));
const tuned = parseReport(fixture('intel-tuned.html'));
const arm = parseReport(fixture('arm.html'));

function walkStrings(value, fn) {
  if (typeof value === 'string') fn(value);
  else if (Array.isArray(value)) value.forEach((v) => walkStrings(v, fn));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => walkStrings(v, fn));
}

test('sysinfo and summary (Intel)', () => {
  assert.deepEqual(untuned.sysinfo, {
    version: '2.15',
    ranAt: 'Tue Nov 3 15:37:51 2026',
    kernel: '6.17.0-41-generic',
    system: 'HP894FSBKPFV3',
    cpuCount: 8,
    cpu: '12th Gen Intel(R) Core(TM) i3-12100T',
    os: 'Debian GNU/Linux 13 (trixie)',
  });
  assert.deepEqual(untuned.summary, { cpuPct: 5.5, wakeups: 489.6, gpuOps: 0, gfxWakeups: 0, vfsOps: 0 });
});

test('top consumers and software parsed by header', () => {
  assert.equal(untuned.topConsumers.length, 10);
  assert.deepEqual(untuned.topConsumers[0], {
    usage: '0.1%', usagePct: 0.1, events: 154, category: 'Timer', description: 'tick_nohz_handler',
  });
  assert.equal(untuned.software.length, 100);
  const first = untuned.software[0];
  assert.equal(first.usage, '1.5 ms/s');
  assert.equal(first.usageUs, 1500);
  assert.equal(first.wakeups, 154);
  assert.equal(first.gpuOps, null);
  assert.equal(first.category, 'Timer');
  const us = untuned.software.find((s) => /us\/s$/.test(s.usage));
  assert.ok(us && us.usageUs < 1000, 'us/s rows are converted without scaling');
});

test('cpu idle: package, cores and per-cpu pairs (Intel)', () => {
  assert.deepEqual(untuned.cpuidle.package.map((s) => s.state), [
    'C2 (pc2)', 'C3 (pc3)', 'C6 (pc6)', 'C7 (pc7)', 'C8 (pc8)', 'C9 (pc9)', 'C10 (pc10)',
  ]);
  assert.equal(untuned.cpuidle.package.find((s) => s.state === 'C8 (pc8)').pct, 87);
  assert.equal(untuned.cpuidle.cores.length, 4);
  assert.deepEqual(untuned.cpuidle.cores[0], {
    label: 'Core 0',
    states: [{ state: 'C3 (cc3)', pct: 0 }, { state: 'C6 (cc6)', pct: 0.5 }, { state: 'C7 (cc7)', pct: 95.1 }],
  });
  assert.deepEqual(untuned.cpuidle.cpus.map((c) => c.label), [
    'CPU 0', 'CPU 1', 'CPU 2', 'CPU 3', 'CPU 4', 'CPU 5', 'CPU 6', 'CPU 7',
  ]);
  assert.deepEqual(untuned.cpuidle.cpus[0].states, [
    { state: 'C0 active', pct: 0.4, avgMs: null },
    { state: 'POLL', pct: 0, avgMs: 0 },
    { state: 'C1E', pct: 0.6, avgMs: 0.1 },
    { state: 'C6', pct: 0.7, avgMs: 0.8 },
    { state: 'C8', pct: 0.1, avgMs: 0.4 },
    { state: 'C10', pct: 97.8, avgMs: 33.9 },
  ]);
  // hyperthread pairs (CPU 0 + CPU 4) are sorted numerically
  assert.deepEqual(tuned.cpuidle.cpus.map((c) => c.label), [
    'CPU 0', 'CPU 1', 'CPU 2', 'CPU 3', 'CPU 4', 'CPU 5', 'CPU 6', 'CPU 7',
  ]);
});

test('cpu frequency keeps real values and drops Idle rows', () => {
  assert.equal(untuned.cpufreq.cpus.length, 8);
  assert.deepEqual(untuned.cpufreq.cpus[0], { label: 'CPU 0', states: [{ state: 'Average', value: '889 MHz', mhz: 889 }] });
  assert.deepEqual(arm.cpufreq.cpus, []);
});

test('devices: usage split into pct or rate, grouped, virtual NICs flagged', () => {
  assert.equal(untuned.devices.length, 75);
  const cpuMisc = untuned.devices.find((d) => d.name === 'CPU misc');
  assert.deepEqual(cpuMisc, { usage: '5.5%', usagePct: 5.5, rate: null, unit: null, name: 'CPU misc', group: 'cpu' });
  const usb = untuned.devices.find((d) => d.name === 'USB device: BACKUP+ (Seagate)');
  assert.equal(usb.group, 'usb');
  assert.equal(usb.usagePct, 100);
  const nic = tuned.devices.find((d) => d.name === 'Network interface: enp108s0 (igc)');
  assert.deepEqual(nic, { usage: '0.0 pkts/s', usagePct: null, rate: 0, unit: 'pkts/s', name: 'Network interface: enp108s0 (igc)', group: 'net' });
  assert.equal(tuned.devices.find((d) => d.name === 'nic:br-48276ec9499e').group, 'virtual');
  assert.equal(tuned.devices.find((d) => d.name === 'nic:enp108s0.5').group, 'virtual');
  assert.ok(tuned.devices.some((d) => d.group === 'pci'));
  assert.ok(tuned.devices.some((d) => d.group === 'audio'));
  assert.equal(tuned.devices.find((d) => d.name.startsWith('runtime-HID-SENSOR')).group, 'platform');
  assert.equal(arm.devices.find((d) => d.name.startsWith('I2C Device')).group, 'i2c');
  assert.equal(arm.devices.find((d) => d.name === 'CPU use').group, 'cpu');
});

test('isVirtualNic', () => {
  for (const n of ['enp108s0', 'eno1', 'eth0', 'eth10', 'wlp2s0', 'switch0']) assert.equal(isVirtualNic(n), false, n);
  for (const n of ['br0', 'br-48276ec9499e', 'docker0', 'veth595d314', 'enp108s0.5', 'eth10.10', 'gretap0', 'erspan0', 'lo', 'wg0']) {
    assert.equal(isVirtualNic(n), true, n);
  }
});

test('device activity carries the process over blank rows', () => {
  assert.equal(untuned.deviceActivity.length, 16);
  assert.deepEqual(untuned.deviceActivity.slice(0, 3), [
    { process: 'systemd', device: '/dev/autofs' },
    { process: 'systemd', device: '/dev/kmsg' },
    { process: 'systemd', device: '/dev/rfkill' },
  ]);
});

test('tuning sections incl. 2-column "need of tuning" rows', () => {
  assert.equal(untuned.tuning.bad.length, 4);
  assert.equal(untuned.tuning.untunable.length, 15);
  assert.equal(untuned.tuning.good.length, 29);
  const b = untuned.tuning.bad[0];
  assert.match(b.id, /^[0-9a-f]{10}$/);
  assert.equal(b.description, 'Enable SATA link power management for host0');
  assert.deepEqual(b.write, { path: '/sys/class/scsi_host/host0/link_power_management_policy', value: 'med_power_with_dipm' });
  assert.equal(tuned.tuning.bad.length, 0);
  assert.equal(tuned.tuning.untunable.length, 12);
  assert.equal(tuned.tuning.good.length, 35);
  assert.equal(arm.tuning.bad.length, 22);
  // duplicate descriptions (two identical NICs) still get unique ids
  const ids = arm.tuning.bad.map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('wake status rows', () => {
  assert.equal(untuned.wakeup.length, 3);
  const eno1 = untuned.wakeup.find((w) => w.description === 'Wake-on-lan status for device eno1');
  assert.deepEqual(eno1.write, { path: '/sys/class/net/eno1/device/power/wakeup', value: 'enabled' });
  assert.equal(tuned.wakeup.length, 5);
  assert.equal(arm.wakeup.length, 6);
});

test('capabilities', () => {
  assert.deepEqual(untuned.caps, { perf: true, pkgCstates: true, cpufreq: true });
  assert.deepEqual(arm.caps, { perf: false, pkgCstates: true, cpufreq: false });
});

test('ARM report: generic idle states, no software, null summary values', () => {
  assert.equal(arm.software.length, 0);
  assert.equal(arm.topConsumers.length, 10);
  assert.deepEqual(arm.cpuidle.package, [{ state: 'WFI', pct: 55.7 }, { state: 'cpu-sleep', pct: 26 }]);
  assert.deepEqual(arm.cpuidle.cores, []);
  assert.equal(arm.cpuidle.cpus.length, 4);
  assert.deepEqual(arm.cpuidle.cpus[0], {
    label: 'CPU 0',
    states: [{ state: 'WFI', pct: 47.7, avgMs: 0.2 }, { state: 'cpu-sleep', pct: 35, avgMs: 2.1 }],
  });
  assert.equal(arm.summary.cpuPct, null);
  assert.equal(arm.summary.wakeups, null);
  assert.equal(arm.sysinfo.cpuCount, 4);
  assert.equal(arm.sysinfo.cpu, null);
  assert.equal(arm.sysinfo.system, null);
});

test('deepIdle: Intel sums package C6+, ARM uses the deepest state', () => {
  assert.deepEqual(deepIdle(untuned), { label: 'PC6+', pct: 87.6 });
  assert.deepEqual(deepIdle(arm), { label: 'cpu-sleep', pct: 26 });
  assert.equal(deepIdle({ cpuidle: { package: [], cores: [], cpus: [] } }), null);
});

test('no entities or nbsp leak into output', () => {
  for (const rep of [untuned, tuned, arm]) {
    walkStrings(rep, (s) => {
      assert.ok(!s.includes('&nbsp;') && !s.includes(' '), JSON.stringify(s));
      assert.equal(s, s.trim());
    });
  }
});

test('garbage input yields an empty report', () => {
  for (const html of ['', '<html></html>', 'not html']) {
    const r = parseReport(html);
    assert.deepEqual(r.tuning, { bad: [], untunable: [], good: [] });
    assert.deepEqual(r.caps, { perf: false, pkgCstates: false, cpufreq: false });
    assert.deepEqual(r.software, []);
  }
});
