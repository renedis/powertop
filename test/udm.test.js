'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Udm, MemSource, parse } = require('../src/udm');
const { fakeConsole } = require('../src/udm-fake');
const { History } = require('../src/history');

const quiet = { log() {}, warn() {}, error() {} };

test('parseStat and cpuSplit', () => {
  const a = parse.parseStat('cpu  100 0 50 800 50 0 0 0 0 0\ncpu0 100 0 50 800 50 0 0 0 0 0\nctxt 1000\nintr 500 1 2\nprocesses 10\nprocs_running 2\nprocs_blocked 1\nbtime 1700000000\n');
  const b = parse.parseStat('cpu  160 0 70 880 80 0 10 0 0 0\ncpu0 160 0 70 880 80 0 10 0 0 0\nctxt 1600\nintr 900 1 2\nprocesses 14\n');
  assert.deepEqual(a.cpus.cpu0, [100, 0, 50, 800, 50, 0, 0, 0]);
  assert.equal(a.ctxt, 1000);
  assert.equal(a.intr, 500);
  assert.equal(a.running, 2);
  const s = parse.cpuSplit(a.cpus.cpu0, b.cpus.cpu0);
  // deltas: user 60, system 20, idle 80, iowait 30, softirq 10 = 200
  assert.equal(s.user, 30);
  assert.equal(s.system, 10);
  assert.equal(s.idle, 40);
  assert.equal(s.iowait, 15);
  assert.equal(s.softirq, 5);
  assert.equal(s.busy, 45);
  assert.equal(parse.cpuSplit(a.cpus.cpu0, a.cpus.cpu0), null);
});

test('parseInterrupts handles numbered lines, IPIs and Err', () => {
  const text = [
    '           CPU0       CPU1',
    '  3:        100         20     GICv3  30 Level     arch_timer',
    ' 44:          5          0      MSIx 524292 Edge      al-eth-rx-comp-0@pci:0000:00:00.0',
    'IPI0:        7          9       Rescheduling interrupts',
    'Err:          0',
  ].join('\n');
  const r = parse.parseInterrupts(text);
  assert.equal(r.cpus, 2);
  assert.deepEqual(r.rows[0], { id: '3', name: 'arch_timer', chip: 'GICv3', counts: [100, 20], total: 120 });
  assert.equal(r.rows[1].name, 'al-eth-rx-comp-0@pci:0000:00:00.0');
  assert.equal(r.rows[2].name, 'Rescheduling interrupts');
  assert.deepEqual(r.rows[3], { id: 'Err', name: 'Err', chip: '', counts: [0], total: 0 });
});

test('parseSoftirqs, parseNetDev, parseDiskstats', () => {
  const soft = parse.parseSoftirqs('                    CPU0       CPU1\n          HI:          1          2\n      NET_RX:        100        300\n');
  assert.deepEqual(soft[1], { name: 'NET_RX', counts: [100, 300], total: 400 });
  const dev = parse.parseNetDev('Inter-|   Receive |  Transmit\n face |bytes packets|bytes\n  eth9:3110 12 1 2 0 0 0 0 4110 41 3 4 0 0 0 0\n    lo: 1 1 0 0 0 0 0 0 1 1 0 0 0 0 0 0\n');
  assert.deepEqual(dev.eth9, { rxBytes: 3110, rxPackets: 12, rxErrs: 1, rxDrop: 2, txBytes: 4110, txPackets: 41, txErrs: 3, txDrop: 4 });
  const d = parse.parseDiskstats('   8       0 sda 30 3 858 279 46 23 3674 3076 0 1203 3325 27 0 240 16\n');
  assert.deepEqual(d.sda, { reads: 30, readSectors: 858, writes: 46, writeSectors: 3674, inflight: 0, ioMs: 1203 });
});

test('parseMdstat, parseSwaps, parseMeminfo, parseConntrackStat', () => {
  const md = parse.parseMdstat('Personalities : [raid1]\nmd3 : active raid1 sda5[0]\n      3898493952 blocks super 1.2 [2/1] [U_]\n      bitmap: 1/1 pages [4KB], 65536KB chunk\n\nunused devices: <none>\n');
  assert.equal(md.length, 1);
  assert.deepEqual({ ...md[0], sync: md[0].sync }, { name: 'md3', state: 'active', level: 'raid1', members: ['sda5'], sizeGB: 3992.1, slots: 2, active: 1, map: 'U_', sync: null });
  const sw = parse.parseSwaps('Filename\tType\tSize\tUsed\tPriority\n/dev/md0 partition\t1961980\t1459792\t2000\n');
  assert.deepEqual(sw, [{ dev: '/dev/md0', type: 'partition', sizeKb: 1961980, usedKb: 1459792, prio: 2000 }]);
  assert.equal(parse.parseMeminfo('MemTotal:  4040828 kB\nMemAvailable: 830000 kB\n').MemAvailable, 830000);
  assert.equal(parse.parseConntrackStat('entries  searched found\n000003f5  00000000 000000a8\n000003f5  00000000 0\n'), 1013);
  assert.equal(parse.parseConntrackStat(''), null);
});

test('parsePidStat copes with spaces and parentheses in comm', () => {
  const p = parse.parsePidStat('951 (my (odd) proc) S 902 951 951 0 -1 4194560 1000 0 0 0 1234 567 0 0 20 0 38 0 951 168000000 41000\n');
  assert.equal(p.pid, 951);
  assert.equal(p.comm, 'my (odd) proc');
  assert.equal(p.ppid, 902);
  assert.equal(p.utime, 1234);
  assert.equal(p.stime, 567);
  assert.equal(p.threads, 38);
  assert.equal(p.start, 951);
  assert.equal(p.rss, 41000);
  assert.equal(parse.parsePidStat(''), null);
});

test('cgroups map to services, containers and sessions', () => {
  assert.equal(parse.parseCgroup('0::/app.slice/app-unifi.slice/unifi-mongodb.service\n'), '/app.slice/app-unifi.slice/unifi-mongodb.service');
  assert.equal(parse.parseCgroup('2:cpu:/x\n1:name=systemd:/system.slice/a.service\n'), '/system.slice/a.service');
  assert.deepEqual(parse.cgroupGroup('/app.slice/app-unifi.slice/unifi-mongodb.service'), { kind: 'service', name: 'unifi-mongodb' });
  assert.deepEqual(parse.cgroupGroup(`/docker/${'f'.repeat(64)}`), { kind: 'container', id: 'f'.repeat(64) });
  assert.deepEqual(parse.cgroupGroup(`/system.slice/docker-${'e'.repeat(64)}.scope`), { kind: 'container', id: 'e'.repeat(64) });
  assert.deepEqual(parse.cgroupGroup('/user.slice/user-0.slice/session-c2.scope'), { kind: 'session', name: 'login session' });
  assert.equal(parse.cgroupGroup('/'), null);
  assert.equal(parse.redact('mongod --auth-token=abc --password=secret x'), 'mongod --auth-token=*** --password=*** x');
});

test('parseModule reads an optical module and a passive cable', () => {
  const s = Date.now();
  const onu = parse.parseModule(fakeConsole(s).exec['ethtool -m eth9'].stdout);
  assert.equal(onu.identifier, 'SFP');
  assert.equal(onu.connector, 'SC');
  assert.equal(onu.type, '10G Ethernet: 10G Base-LR');
  assert.equal(onu.vendor, 'OEM');
  assert.equal(onu.wavelengthNm, 1270);
  assert.equal(onu.reach, '20 km single-mode');
  assert.equal(onu.powerLevel, 3);
  assert.equal(onu.powerMaxW, 2);
  assert.equal(onu.ddm, true);
  assert.equal(onu.vcc, 3.3047);
  assert.equal(onu.txDbm, 7.12);
  assert.ok(onu.rxDbm < -24 && onu.rxDbm > -26);
  assert.deepEqual(onu.thresholds.rx, { highAlarm: -7, lowAlarm: -32.22, highWarn: -7.5, lowWarn: -30.97 });
  assert.deepEqual(onu.thresholds.temp, { highAlarm: 90, lowAlarm: -45, highWarn: 85, lowWarn: -40 });
  assert.deepEqual(onu.flags, []);
  assert.equal('serial' in onu, false);
  const dac = parse.parseModule(fakeConsole(s).exec['ethtool -m eth10'].stdout);
  assert.equal(dac.connector, 'Copper pigtail');
  assert.equal(dac.reach, '1 m copper');
  assert.equal(dac.powerLevel, 1);
  assert.equal(dac.ddm, false);
  assert.equal(dac.tempC, null);
  assert.equal(parse.parseModule('Cannot get module EEPROM information: Invalid argument'), null);
  const alarm = parse.parseModule('\tIdentifier : 0x03 (SFP)\n\tLaser output power : 0.0000 mW / -inf dBm\n\tLaser rx power low alarm : On\n');
  assert.equal(alarm.txDbm, null);
  assert.deepEqual(alarm.flags, ['Laser rx power low alarm']);
});

test('parseSmart reads SATA SSD data and standby', () => {
  const s = parse.parseSmart(JSON.parse(fakeConsole().exec['smartctl -j -n standby -i -A -H /dev/sda'].stdout));
  assert.equal(s.model, 'Example SSD 4TB');
  assert.equal(s.ssd, true);
  assert.equal(s.healthy, true);
  assert.equal(s.lifePct, 91);
  assert.equal(s.lifeAttr, 'Wear_Leveling_Count');
  assert.equal(s.writtenTB, 46.1);
  assert.equal(s.reallocated, 0);
  assert.equal(s.powerMode, 'active or idle');
  assert.equal('serial' in s, false);
  const sb = parse.parseSmart({ smartctl: { exit_status: 2, messages: [{ string: 'Device is in STANDBY mode, exit(2)', severity: 'information' }] } });
  assert.equal(sb.powerMode, 'standby');
  assert.equal(sb.model, null);
});

test('parseFancontrol, parseYamlBlocks, parseVersion, parseMca', () => {
  const fan = parse.parseFancontrol('# x\nINTERVAL=1\nFCTEMPS=hwmon0/device/pwm2=hwmon0/device/temp1_input hwmon0/device/pwm1=/run/fan/drive_temp\nFCFANS=hwmon0/device/pwm2=hwmon0/device/fan2_input\nMINTEMP=hwmon0/device/pwm2=40 hwmon0/device/pwm1=35\nMAXTEMP=hwmon0/device/pwm2=65\nMINPWM=hwmon0/device/pwm2=60\nMAXPWM=hwmon0/device/pwm2=255\n');
  assert.deepEqual(fan[0], { pwm: 'pwm1', source: '/run/fan/drive_temp', fan: null, minTemp: 35, maxTemp: null, minStart: null, minStop: null, minPwm: 0, maxPwm: 255, intervalSec: 1 });
  assert.deepEqual(fan[1], { pwm: 'pwm2', source: 'temp1', fan: 'fan2', minTemp: 40, maxTemp: 65, minStart: null, minStop: null, minPwm: 60, maxPwm: 255, intervalSec: 1 });
  const y = parse.parseYamlBlocks('name: X\nlcmSettings:\n  enabled: true\n  brightness: 20\n  deep:\n    no: 1\nnightMode:\n  onMinute: 1320\nowner: null\n');
  assert.deepEqual(y, { name: 'X', lcmSettings: { enabled: true, brightness: 20, deep: null }, nightMode: { onMinute: 1320 }, owner: null });
  assert.deepEqual(parse.parseVersion('UDMPRO.al324.v5.1.33.abc.260909.0025\n'), { firmware: '5.1.33', build: 'UDMPRO.al324.v5.1.33.abc.260909.0025' });
  const m = parse.parseMca(JSON.parse(fakeConsole().exec['mca-dump'].stdout));
  assert.equal(m.uplink, 'eth9.100');
  assert.deepEqual(m.ips.rules, 30000);
  assert.equal(m.speedtest.downMbps, 940);
  assert.equal(m.speedtest.server, 'Example City, Example ISP');
  assert.equal(m.speedtest.iface, 'eth9.100');
  assert.equal(m.wans[0].name, 'WAN');
  assert.equal(m.wans[0].monitors.length, 3);
  assert.equal(m.dpiEntries, 3);
  assert.equal(m.temperatures[0].name, 'CPU');
  assert.equal(JSON.stringify(m).includes('192.0.2'), false);
});

/** Two snapshots ten seconds apart from the simulator, sampled with a fixed clock. */
function twoSamples() {
  const t0 = Date.now();
  const src = new MemSource(fakeConsole(t0));
  let t = t0;
  let hr = 0n;
  const history = new History({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'pt-udm-')), now: () => t, log: quiet });
  const udm = new Udm({ source: src, history, now: () => t, hr: () => hr, log: quiet, pageSize: 4096 });
  assert.equal(udm.detect(), true);
  udm.readConfig();
  udm.refreshDisks();
  udm.sampleFast();
  t += 10000;
  hr += 10000000000n;
  src.set(fakeConsole(t));
  udm.sampleFast();
  return { udm, src, history, t0, advance: (ms) => (t += ms) };
}

test('Udm computes rates from two samples', () => {
  const { udm } = twoSamples();
  const f = udm.fast;
  assert.equal(f.dtSec, 10);
  assert.equal(udm.info.model, 'UniFi Dream Machine Pro');
  assert.equal(udm.info.firmware, '5.1.33');
  assert.deepEqual(udm.info.made, { year: 2021, week: 1 });
  assert.equal(udm.info.spec.clockGHz, 1.7);
  assert.equal(JSON.stringify(udm.info).includes('hashid'), false);

  // CPU split sums to ~100 % and busy is in the simulator's range
  const c = f.cpu.total;
  const sum = ['user', 'nice', 'system', 'idle', 'iowait', 'irq', 'softirq', 'steal'].reduce((a, k) => a + c[k], 0);
  assert.ok(Math.abs(sum - 100) < 0.1, `sum ${sum}`);
  assert.ok(c.busy > 15 && c.busy < 40, `busy ${c.busy}`);
  assert.equal(f.cpu.cpus.length, 4);
  const cpu0 = f.cpu.cpus[0];
  assert.deepEqual(cpu0.idle.map((s) => s.name), ['WFI', 'cpu-sleep']);
  assert.ok(cpu0.idle[0].pct > cpu0.idle[1].pct);
  assert.ok(cpu0.idle[1].avgUs > 1500 && cpu0.idle[1].avgUs < 3000, `avg ${cpu0.idle[1].avgUs}`);
  assert.ok(cpu0.activePct > 10 && cpu0.activePct < 40, `active ${cpu0.activePct}`);
  assert.ok(f.cpu.ctxPerSec > 30000);

  // interrupts: the i2c bus fires ~84/s on CPU0
  const i2c = f.irqs.rows.find((r) => r.name === 'fd880000.i2c-pld');
  assert.ok(i2c.rate > 70 && i2c.rate < 100, `i2c ${i2c.rate}`);
  assert.equal(i2c.perCpu[1], 0);
  const netRx = f.softirqs.rows.find((r) => r.name === 'NET_RX');
  assert.ok(netRx.perCpu[2] < netRx.perCpu[0] / 4);

  // processes: services and containers resolved, kernel threads tagged
  const udapi = f.procs.rows.find((r) => r.comm === 'ubios-udapi-ser');
  assert.ok(udapi.cpuPct > 5 && udapi.cpuPct < 20, `udapi ${udapi.cpuPct}`);
  assert.equal(udapi.group, 'udapi-server');
  assert.equal(udapi.kind, 'service');
  const adg = f.procs.rows.find((r) => r.comm === 'AdGuardHome');
  assert.equal(adg.group, 'adguardhome');
  assert.equal(adg.kind, 'container');
  const ks = f.procs.rows.find((r) => r.comm === 'ksoftirqd/0');
  assert.equal(ks.kind, 'kernel');
  assert.equal(ks.cmd, '[ksoftirqd/0]');
  const mongo = f.procs.rows.find((r) => r.comm === 'mongod');
  assert.match(mongo.cmd, /--auth-token=\*\*\*/);
  assert.equal(f.procs.groups[0].group, 'udapi-server');
  const self = f.procs.rows.find((r) => r.comm === 'node');
  assert.equal(self.group, 'powertop', 'own container resolved through the cgroup namespace');
  assert.equal(self.kind, 'container');
  assert.equal(f.fanRunning, true);

  // network: Mbit/s, kinds, noise interfaces dropped
  const eth9 = f.net.ifaces.find((i) => i.name === 'eth9');
  assert.ok(eth9.rxMbps > 15 && eth9.rxMbps < 40, `rx ${eth9.rxMbps}`);
  assert.equal(eth9.kind, 'port');
  assert.equal(eth9.driver, 'al_eth');
  assert.equal(eth9.speed, 10000);
  assert.equal(f.net.ifaces.find((i) => i.name === 'eth9.100').kind, 'vlan');
  assert.equal(f.net.ifaces.find((i) => i.name === 'br0').kind, 'bridge');
  assert.equal(f.net.ifaces.find((i) => i.name === 'eth6').carrier, false);
  assert.equal(f.net.ifaces.some((i) => i.name === 'lo'), false);
  assert.ok(f.net.conntrack.entries > 900);
  assert.equal(f.net.conntrack.max, 65536);

  // sensors
  assert.equal(f.sensors.thermal[0].label, 'SoC');
  assert.equal(f.sensors.thermal[0].trips[0].c, 105);
  const chip = f.sensors.hwmon[0];
  assert.equal(chip.name, 'adt7475');
  assert.deepEqual(chip.temps.map((x) => x.label), ['CPU', 'Local', 'PHY']);
  assert.deepEqual(chip.volts.map((x) => [x.label, x.v]).slice(0, 1), [['VCCP', 0.891]]);
  assert.equal(chip.pwms.find((x) => x.id === 'pwm2').mode, 'manual');
  // unconnected tach inputs and the unused PWM output are hidden; fans say what they follow
  assert.deepEqual(chip.fans.map((x) => x.id), ['fan1', 'fan2']);
  assert.deepEqual(chip.pwms.map((x) => x.id), ['pwm1', 'pwm2']);
  assert.equal(chip.fans.find((x) => x.id === 'fan2').follows, 'CPU');
  assert.equal(chip.fans.find((x) => x.id === 'fan1').follows, 'PHY');

  // memory and storage
  assert.ok(f.memory.usedPct > 75 && f.memory.usedPct < 82);
  assert.equal(f.memory.swaps.length, 2);
  assert.equal(f.memory.zram[0].dev, 'zram0');
  const sda = f.storage.disks.find((d) => d.name === 'sda');
  assert.equal(sda.kind, 'sata');
  assert.ok(sda.busyPct > 15 && sda.busyPct < 45, `busy ${sda.busyPct}`);
  assert.equal(f.storage.disks.find((d) => d.name === 'boot').kind, 'usb');
  assert.equal(f.storage.disks.some((d) => d.name === 'loop0'), false);
  assert.equal(f.storage.md[0].map, 'U_');

  const k = udm.kpi();
  assert.equal(k.busyPct, c.busy);
  assert.ok(k.socC > 55 && k.socC < 66);
  assert.ok(k.fanRpm > 1000);

  // config
  assert.deepEqual(udm.config.display, { enabled: true, brightness: 20, night: { from: '22:00', to: '08:00' }, led: true });
  assert.equal(udm.config.fan.find((x) => x.pwm === 'pwm2').source, 'temp1');
});

test('Udm slow, SMART and controller samples', async () => {
  const { udm, src, advance } = twoSamples();
  await udm.sampleSlow();
  assert.deepEqual(Object.keys(udm.sfp).sort(), ['eth10', 'eth9']);
  assert.equal(udm.sfp.eth9.powerMaxW, 2);
  assert.ok(udm.sfpFail.has('eth8'));
  assert.ok(udm.sfpFail.has('switch0'));
  await udm.sampleSmart();
  assert.deepEqual(Object.keys(udm.smart), ['sda']);
  assert.equal(udm.smart.sda.model, 'Example SSD 4TB');
  await udm.sampleCtl();
  assert.equal(udm.ctl.uplink, 'eth9.100');
  assert.equal(udm.ctl.ports.length, 11);
  assert.equal(udm.ctl.ports[3].rxMbps, undefined, 'no rate before the second controller sample');
  advance(120000);
  src.set(fakeConsole(udm.now()));
  await udm.sampleCtl();
  const p4 = udm.ctl.ports.find((p) => p.name === 'eth3');
  assert.equal(p4.up, true);
  assert.equal(p4.speed, 1000);
  assert.ok(Math.abs(p4.rxMbps - 6) < 0.1, `rx ${p4.rxMbps}`);
  assert.ok(p4.errPerMin > 0);
  assert.equal(udm.ctl.ports.find((p) => p.name === 'eth1').up, false);
  const snap = udm.snapshot();
  assert.equal(snap.available, true);
  assert.equal(snap.fast.net.ifaces.find((i) => i.name === 'eth9').wan, true);
  assert.equal(snap.fast.net.ifaces.find((i) => i.name === 'eth9.100').wan, true);
  assert.equal(snap.fast.net.ifaces.find((i) => i.name === 'eth10').wan, false);
  assert.equal(snap.fast.storage.disks.find((d) => d.name === 'sda').smart.lifePct, 91);
  assert.deepEqual(snap.sfp.map((m) => m.iface), ['eth9', 'eth10']);
  assert.equal(snap.fast.net.ifaces.find((i) => i.name === 'eth3').port.up, true);
  assert.equal(snap.fast.net.ifaces.find((i) => i.name === 'eth1').port.up, false);
  assert.equal(snap.fast.net.ifaces.find((i) => i.name === 'br0').port, null);
  assert.equal(snap.config.fanRunning, true);
});

test('Udm writes one history record per minute', async () => {
  const { udm, history, src, advance } = twoSamples();
  await udm.sampleSlow();
  await udm.sampleSmart();
  await udm.sampleCtl();
  advance(120000);
  src.set(fakeConsole(udm.now()));
  await udm.sampleCtl();
  const rec = udm.record();
  assert.ok(Math.abs(rec['rx:eth3'] - 6) < 0.1, 'switch port rate from the controller');
  assert.equal('rx:eth1' in rec, false);
  assert.equal(rec.k, 'u');
  for (const key of ['busy', 'usr', 'sys', 'iow', 'sirq', 'act', 'I:WFI', 'I:cpu-sleep', 'ctx', 'int', 'mem', 'swap', 'ct', 'T:SoC', 'T:CPU', 'F:fan2', 'rx:eth9', 'tx:eth9', 'db:sda', 'T:SFP eth9', 'rxp:eth9', 'T:sda']) {
    assert.equal(typeof rec[key], 'number', key);
  }
  assert.ok(Object.keys(rec).length < 50, `record has ${Object.keys(rec).length} keys`);
  assert.equal('rx:eth6' in rec, false, 'ports without link are not recorded');
  assert.equal(udm.record(), null, 'nothing new to record');
  const q = history.queryUdm('1h');
  assert.equal(q.t.length, 1);
  assert.equal(q.series.busy[0], rec.busy);
  assert.equal(q.series['T:SoC'][0], rec['T:SoC']);
  await history.flush();
  const reloaded = await new History({ dir: history.dir, log: quiet }).load();
  assert.equal(reloaded.udm.length, 1);
});

test('Udm stays off without ubnthal and when disabled', () => {
  const off = new Udm({ source: new MemSource({ files: { 'proc/stat': 'cpu 1 2 3 4\n' } }), log: quiet });
  assert.equal(off.start(), false);
  assert.equal(off.available, false);
  assert.deepEqual(off.snapshot(), { available: false });
  assert.equal(off.kpi(), null);
  const disabled = new Udm({ source: new MemSource(fakeConsole()), enabled: false, log: quiet });
  assert.equal(disabled.start(), false);
});

test('Udm schedules faster sampling while someone watches', async () => {
  const src = new MemSource(fakeConsole);
  const udm = new Udm({ source: src, log: quiet, fastMs: 20, idleMs: 100000, slowMs: 100000, slowIdleMs: 100000, smartMs: 100000, ctlMs: 100000, ctlIdleMs: 100000, recordMs: 100000 });
  assert.equal(udm.start(), true);
  try {
    const first = udm.updated.fast;
    udm.setViewers(1);
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(udm.updated.fast > first);
    assert.ok(udm.fast.dtSec > 0);
  } finally {
    udm.stop();
  }
});
