'use strict';
/*
 * Simulated UniFi console for `npm run dev:udm` and tests: /proc, /sys and
 * command output in the formats a real console produces, with counters that
 * advance with time. All names and values are neutral examples.
 */

const HZ = 100;
const BOOT = Date.now() - 41 * 86400000;
const TAU = 2 * Math.PI;

/** Integral of base + amp * sin(2*pi*s/period): smooth, monotonic counters. */
const cum = (s, base, amp = 0, period = 600) => base * s + ((amp * period) / TAU) * (1 - Math.cos((TAU * s) / period));
const wobble = (s, amp, period, phase = 0) => amp * Math.sin((TAU * s) / period + phase);
const int = (x) => Math.max(0, Math.floor(x));

const CPUS = 4;
const SHARE = [
  // user, system, iowait, irq, softirq (fraction of each CPU)
  [0.17, 0.075, 0.045, 0, 0.026],
  [0.16, 0.08, 0.035, 0, 0.025],
  [0.15, 0.078, 0.035, 0, 0.004],
  [0.16, 0.079, 0.036, 0, 0.026],
];

const PROCS = [
  // pid, comm, ppid, cpu (cores), threads, rss MB, cgroup, cmdline
  [1, 'systemd', 0, 0.002, 1, 9, '/init.scope', '/sbin/init'],
  [2, 'kthreadd', 0, 0, 1, 0, '/', ''],
  [10, 'ksoftirqd/0', 2, 0.006, 1, 0, '/', ''],
  [16, 'ksoftirqd/1', 2, 0.006, 1, 0, '/', ''],
  [21, 'ksoftirqd/2', 2, 0.001, 1, 0, '/', ''],
  [26, 'ksoftirqd/3', 2, 0.006, 1, 0, '/', ''],
  [88, 'kworker/0:1H', 2, 0.002, 1, 0, '/', ''],
  [312, 'jbd2/md3-8', 2, 0.003, 1, 0, '/', ''],
  [701, 'ubios-udapi-ser', 1, 0.112, 24, 92, '/system.slice/udapi-server.service', '/usr/bin/ubios-udapi-server'],
  [733, 'mcad', 1, 0.047, 9, 41, '/system.slice/mcad.service', '/usr/bin/mcad'],
  [812, 'unifi-core', 1, 0.031, 12, 210, '/system.slice/unifi-core.service', 'node /usr/share/unifi-core/app/service.js'],
  [902, 'unifi', 1, 0.035, 160, 610, '/app.slice/app-unifi.slice/unifi.service', 'java -Xmx1024M -jar /usr/lib/unifi/lib/ace.jar start'],
  [951, 'mongod', 902, 0.0125, 38, 160, '/app.slice/app-unifi.slice/unifi-mongodb.service', '/usr/bin/mongod --config /etc/mongod.conf --auth-token=example'],
  [990, 'ulcmd', 1, 0.004, 4, 12, '/system.slice/ulcmd.service', '/usr/bin/ulcmd'],
  [1004, 'fancontrol', 1, 0.003, 1, 3, '/system.slice/fancontrol.service', '/bin/bash /usr/sbin/fancontrol'],
  [1100, 'dnsmasq', 1, 0.002, 1, 6, '/system.slice/dnsmasq.service', '/usr/sbin/dnsmasq -k'],
  [1210, 'nginx', 1, 0.001, 1, 14, '/system.slice/nginx.service', 'nginx: master process /usr/sbin/nginx'],
  [2101, 'dockerd', 1, 0.009, 30, 70, '/system.slice/docker.service', '/usr/bin/dockerd'],
  [2240, 'AdGuardHome', 2101, 0.021, 14, 120, `/docker/${'a'.repeat(64)}`, '/opt/adguardhome/AdGuardHome --no-check-update'],
  [2290, 'mosquitto', 2101, 0.002, 1, 8, `/docker/${'b'.repeat(64)}`, '/usr/sbin/mosquitto -c /mosquitto/config/mosquitto.conf'],
  // this container itself: inside its own cgroup namespace the path reads "/"
  [2330, 'node', 2101, 0.006, 11, 80, '/', 'node /app/server.js'],
];
const CONTAINERS = { a: 'adguardhome', b: 'mosquitto', c: 'powertop' };

const IRQS = [
  // id, chip, hwirq, type, name, rate per CPU
  ['3', 'GICv3', '30', 'Level', 'arch_timer', [700, 70, 60, 12]],
  ['16', 'GICv3', '53', 'Level', 'fd880000.i2c-pld', [84, 0, 0, 0]],
  ['26', 'GICv3', '55', 'Level', 'fd882000.spi', [0.6, 0, 0, 0]],
  ['31', 'MSIx', '131075', 'Edge', 'ahci0', [24, 0, 0, 0]],
  ['40', 'MSIx', '524288', 'Edge', 'al-eth-tx-comp-0@pci:0000:00:00.0', [280, 0, 0, 0]],
  ['41', 'MSIx', '524289', 'Edge', 'al-eth-tx-comp-1@pci:0000:00:00.0', [0, 295, 0, 0]],
  ['42', 'MSIx', '524290', 'Edge', 'al-eth-tx-comp-2@pci:0000:00:00.0', [0, 0, 300, 0]],
  ['43', 'MSIx', '524291', 'Edge', 'al-eth-tx-comp-3@pci:0000:00:00.0', [0, 0, 0, 286]],
  ['44', 'MSIx', '524292', 'Edge', 'al-eth-rx-comp-0@pci:0000:00:00.0', [135, 0, 0, 0]],
  ['45', 'MSIx', '524293', 'Edge', 'al-eth-rx-comp-1@pci:0000:00:00.0', [0, 141, 0, 0]],
  ['46', 'MSIx', '524294', 'Edge', 'al-eth-rx-comp-2@pci:0000:00:00.0', [0, 0, 139, 0]],
  ['47', 'MSIx', '524295', 'Edge', 'al-eth-rx-comp-3@pci:0000:00:00.0', [0, 0, 0, 126]],
  ['IPI0', '', '', '', 'Rescheduling interrupts', [330, 400, 333, 384]],
  ['IPI1', '', '', '', 'Function call interrupts', [7, 12, 12, 12]],
  ['IPI4', '', '', '', 'Timer broadcast interrupts', [34, 31, 29, 31]],
];
const SOFTIRQS = [
  ['HI', [0, 0, 0, 0]],
  ['TIMER', [80, 80, 83, 80]],
  ['NET_TX', [22, 31, 37, 30]],
  ['NET_RX', [835, 837, 110, 866]],
  ['BLOCK', [24, 0, 0, 0]],
  ['IRQ_POLL', [0, 0, 0, 0]],
  ['TASKLET', [5, 0, 0, 0]],
  ['SCHED', [88, 88, 89, 88]],
  ['HRTIMER', [0.04, 0.02, 0.08, 0.004]],
  ['RCU', [134, 133, 138, 133]],
];
const IFACES = [
  // name, Mbit/s rx, tx, driver, speed, carrier
  // the internal switch ports always look up and never count bytes: the switch chip forwards in hardware
  ['eth0', 0, 0, null, 1000, 1],
  ['eth1', 0, 0, null, 1000, 1],
  ['eth2', 0, 0, null, 1000, 1],
  ['eth3', 0, 0, null, 1000, 1],
  ['eth4', 0, 0, null, 1000, 1],
  ['eth5', 0, 0, null, 1000, 1],
  ['eth6', 0, 0, null, null, 0],
  ['eth7', 0, 0, null, null, 0],
  ['eth8', 0, 0, 'al_eth', null, 0],
  ['eth9', 26, 6.5, 'al_eth', 10000, 1],
  ['eth10', 7, 25, 'al_eth', 10000, 1],
  ['switch0', 24, 4, 'al_eth', 1000, 1],
  ['eth9.100', 26, 6.5, null, 10000, 1],
  ['br0', 4, 21, null, null, 1],
  ['lo', 1, 1, null, null, 1],
];

function line(...cols) {
  return cols.join(' ');
}

function moduleText(onu, s) {
  const base = onu
    ? [
        ['Identifier', '0x03 (SFP)'],
        ['Connector', '0x01 (SC)'],
        ['Transceiver type', '10G Ethernet: 10G Base-LR'],
        ['BR, Nominal', '10300MBd'],
        ['Length (SMF,km)', '20km'],
        ['Length (Copper)', '0m'],
        ['Laser wavelength', '1270nm'],
        ['Vendor name', 'OEM'],
        ['Vendor PN', 'XGSPON-ONU-SFPP'],
        ['Vendor rev', '1A'],
        ['Option values', '0x22 0x02'],
        ['Option', 'RX_LOS implemented'],
        ['Option', 'Power level 2 requirement'],
        ['Option', 'Power level 3 requirement'],
        ['Vendor SN', 'EXAMPLE0001'],
        ['Optical diagnostics support', 'Yes'],
        ['Laser bias current', `${(19 + wobble(s, 0.3, 300)).toFixed(3)} mA`],
        ['Laser output power', '5.1562 mW / 7.12 dBm'],
        ['Receiver signal average optical power', `0.0033 mW / ${(-24.8 + wobble(s, 0.05, 900)).toFixed(2)} dBm`],
        ['Module temperature', `${(55.5 + wobble(s, 0.6, 1200)).toFixed(2)} degrees C / 131.90 degrees F`],
        ['Module voltage', '3.3047 V'],
        ['Laser bias current high alarm', 'Off'],
        ['Module temperature high warning', 'Off'],
        ['Laser rx power low warning', 'Off'],
        ['Laser bias current high alarm threshold', '90.000 mA'],
        ['Laser bias current low alarm threshold', '2.000 mA'],
        ['Laser bias current high warning threshold', '80.000 mA'],
        ['Laser bias current low warning threshold', '4.000 mA'],
        ['Module temperature high alarm threshold', '90.00 degrees C / 194.00 degrees F'],
        ['Module temperature low alarm threshold', '-45.00 degrees C / -49.00 degrees F'],
        ['Module temperature high warning threshold', '85.00 degrees C / 185.00 degrees F'],
        ['Module temperature low warning threshold', '-40.00 degrees C / -40.00 degrees F'],
        ['Module voltage high alarm threshold', '4.0000 V'],
        ['Module voltage low alarm threshold', '3.0000 V'],
        ['Module voltage high warning threshold', '3.5000 V'],
        ['Module voltage low warning threshold', '3.1000 V'],
        ['Laser output power high alarm threshold', '6.5535 mW / 8.16 dBm'],
        ['Laser output power low alarm threshold', '2.1380 mW / 3.30 dBm'],
        ['Laser output power high warning threshold', '6.5535 mW / 8.16 dBm'],
        ['Laser output power low warning threshold', '2.3442 mW / 3.70 dBm'],
        ['Laser rx power high alarm threshold', '0.1995 mW / -7.00 dBm'],
        ['Laser rx power low alarm threshold', '0.0006 mW / -32.22 dBm'],
        ['Laser rx power high warning threshold', '0.1778 mW / -7.50 dBm'],
        ['Laser rx power low warning threshold', '0.0008 mW / -30.97 dBm'],
      ]
    : [
        ['Identifier', '0x03 (SFP)'],
        ['Connector', '0x21 (Copper pigtail)'],
        ['Transceiver type', 'Passive Cable'],
        ['BR, Nominal', '10300MBd'],
        ['Length (Copper)', '1m'],
        ['Vendor name', 'OEM'],
        ['Vendor PN', 'SFPP-DAC-1M'],
        ['Vendor rev', 'A'],
        ['Option values', '0x00 0x00'],
      ];
  return `${base.map(([k, v]) => `\t${k.padEnd(41)} : ${v}`).join('\n')}\n`;
}

function smartJson(s) {
  return JSON.stringify({
    smartctl: { version: [7, 2], exit_status: 0 },
    model_family: 'Example SATA SSDs',
    model_name: 'Example SSD 4TB',
    serial_number: 'EXAMPLE',
    firmware_version: 'EX01',
    user_capacity: { blocks: 7814037168, bytes: 4000787030016 },
    logical_block_size: 512,
    rotation_rate: 0,
    form_factor: { ata_value: 3, name: '2.5 inches' },
    interface_speed: { current: { string: '6.0 Gb/s' } },
    smart_status: { passed: true },
    temperature: { current: Math.round(37 + wobble(s, 1, 3600)) },
    power_on_time: { hours: 21000 + Math.floor(s / 3600) },
    power_cycle_count: 120,
    ata_smart_attributes: {
      table: [
        { id: 5, name: 'Reallocated_Sector_Ct', value: 100, raw: { value: 0 } },
        { id: 177, name: 'Wear_Leveling_Count', value: 91, raw: { value: 90 } },
        { id: 199, name: 'CRC_Error_Count', value: 100, raw: { value: 0 } },
        { id: 241, name: 'Total_LBAs_Written', value: 99, raw: { value: 90000000000 } },
      ],
    },
  });
}

function mcaJson(t) {
  return JSON.stringify({
    model: 'UDMPRO',
    model_display: 'UniFi Dream Machine Pro',
    version: '5.1.33',
    uplink: 'eth9.100',
    uptime: Math.floor((t - BOOT) / 1000),
    'system-stats': { cpu: '28.4', mem: '79.2', uptime: String(Math.floor((t - BOOT) / 1000)) },
    temperatures: [
      { name: 'CPU', type: 'cpu', value: 45.25 },
      { name: 'Local', type: 'board', value: 41.75 },
      { name: 'PHY', type: 'board', value: 42 },
    ],
    storage: [
      { mount_point: '/persistent', name: 'Backup', size: 2046640128, type: 'eMMC', used: 592117760 },
      { mount_point: '/tmp', name: 'Temporary', size: 1073741824, type: 'other', used: 8196096 },
    ],
    ids_ips_rule: { rule_count: 30000, signature_type: 'ET', update_time: new Date(t - 3 * 3600000).toISOString() },
    'speedtest-status': {
      latency: 5,
      rundate: Math.floor((t - 7 * 3600000) / 1000),
      server: { city: 'Example City', provider: 'Example ISP' },
      source_interface: 'if!eth9.100',
      xput_download: 940,
      xput_upload: 910,
    },
    uptime_stats: {
      WAN: {
        availability: 100,
        latency_average: 4,
        monitors: [
          { availability: 100, latency_average: 5, target: 'example.com', type: 'icmp' },
          { availability: 100, latency_average: 6, target: 'example.net', type: 'dns' },
        ],
        alerting_monitors: [{ availability: 100, latency_average: 4, target: 'example.org', type: 'icmp' }],
      },
    },
    dpi_stats: [{ ip: '192.0.2.10' }, { ip: '192.0.2.11' }, { ip: '192.0.2.12' }],
    port_table: [
      // the switch chip's own view: only some internal ports have a link
      ...['eth0', 'eth1', 'eth2', 'eth3', 'eth4', 'eth5', 'eth6', 'eth7', 'eth8'].map((name, i) => {
        const up = [0, 3, 5].includes(i);
        const mbps = up ? [18, 0, 0, 6, 0, 1.2][i] : 0;
        return {
          port_idx: i + 1,
          name,
          media: 'GE',
          up,
          enable: i < 6 || i === 8,
          speed: up ? (i === 5 ? 100 : 1000) : 10,
          full_duplex: up,
          is_uplink: false,
          rx_bytes: Math.floor(((mbps * 1e6) / 8) * ((t - BOOT) / 1000)),
          tx_bytes: Math.floor(((mbps * 0.2 * 1e6) / 8) * ((t - BOOT) / 1000)),
          rx_errors: i === 3 ? 29000 + Math.floor((t - BOOT) / 30000) : 0,
          tx_errors: 0,
          rx_dropped: 0,
          tx_dropped: 0,
        };
      }),
      { port_idx: 10, name: 'eth9', media: 'SFP+', up: true, enable: true, speed: 10000, full_duplex: true, is_uplink: true, rx_bytes: 1, tx_bytes: 1, rx_errors: 0, tx_errors: 0 },
      { port_idx: 11, name: 'eth10', media: 'SFP+', up: true, enable: true, speed: 10000, full_duplex: true, is_uplink: false, rx_bytes: 1, tx_bytes: 1, rx_errors: 0, tx_errors: 0 },
    ],
    content_filtering_status: { feature_status: 'DISABLED' },
  });
}

/** Snapshot { files, links, exec } of the simulated console at time t (ms). */
function fakeConsole(t = Date.now()) {
  const s = Math.max(1, (t - BOOT) / 1000);
  const files = {};
  const links = {};
  const put = (k, v) => {
    files[k] = v;
  };

  // identity and config
  put('proc/ubnthal/system.info', 'cpu=AL324V2\ncpuid=411fd071\nflashSize=16777216\nramsize=4294967296\nvendorid=0777\nlcm_count=1\nshortname=UDMPRO\nboardrevision=8\nmfgweek=202101\ndevice.hashid=0000000000000000\n');
  put('proc/ubnthal/board', 'format=0002\nversion=0002\nboardid=ea15\nvendorid=0777\nbomrev=0002d308\n');
  put('proc/sys/kernel/osrelease', '4.19.152-ui-alpine\n');
  put('host/usr/lib/version', 'UDMPRO.al324.v5.1.33.0a1b2c3.000000.0000\n');
  put(
    'host/etc/fancontrol',
    [
      'INTERVAL=1',
      'DEVPATH=hwmon0=devices/platform/soc/i2c-4/4-002e',
      'DEVNAME=hwmon0=adt7475',
      'FCTEMPS=hwmon0/device/pwm2=hwmon0/device/temp1_input hwmon0/device/pwm1=hwmon0/device/temp3_input',
      'FCFANS=hwmon0/device/pwm2=hwmon0/device/fan2_input hwmon0/device/pwm1=hwmon0/device/fan1_input',
      'MINTEMP=hwmon0/device/pwm2=40 hwmon0/device/pwm1=40',
      'MAXTEMP=hwmon0/device/pwm2=65 hwmon0/device/pwm1=65',
      'MINSTART=hwmon0/device/pwm2=60 hwmon0/device/pwm1=30',
      'MINSTOP=hwmon0/device/pwm2=60 hwmon0/device/pwm1=0',
      'MINPWM=hwmon0/device/pwm2=60 hwmon0/device/pwm1=0',
      'MAXPWM=hwmon0/device/pwm2=255 hwmon0/device/pwm1=255',
      '',
    ].join('\n')
  );
  put('host/data/unifi-core/config/settings.yaml', 'name: Example\nlcmSettings:\n  enabled: true\n  color: 0139FF\n  brightness: 20\nledSettings:\n  enabled: true\nnightMode:\n  onMinute: 1320\n  offMinute: 480\n');
  put(`host/volume/00000000-0000-0000-0000-000000000000/docker/containers/${'a'.repeat(64)}/config.v2.json`, JSON.stringify({ Name: `/${CONTAINERS.a}` }));
  put(`host/volume/00000000-0000-0000-0000-000000000000/docker/containers/${'b'.repeat(64)}/config.v2.json`, JSON.stringify({ Name: `/${CONTAINERS.b}` }));
  put(`host/volume/00000000-0000-0000-0000-000000000000/docker/containers/${'c'.repeat(64)}/config.v2.json`, JSON.stringify({ Name: `/${CONTAINERS.c}` }));

  // CPU time
  const rows = [];
  const tot = [0, 0, 0, 0, 0, 0, 0, 0];
  for (let c = 0; c < CPUS; c++) {
    const [u, sy, io, irq, sirq] = SHARE[c];
    const user = HZ * cum(s, u, u * 0.4, 420 + c * 37);
    const system = HZ * cum(s, sy, sy * 0.3, 380 + c * 11);
    const iowait = HZ * cum(s, io, io * 0.8, 900);
    const soft = HZ * cum(s, sirq, sirq * 0.5, 240);
    const idle = HZ * s - user - system - iowait - soft - HZ * irq * s;
    const v = [user, HZ * 0.0012 * s, system, idle, iowait, 0, soft, 0].map(int);
    v.forEach((x, i) => {
      tot[i] += x;
    });
    rows.push(line(`cpu${c}`, ...v, 0, 0));
    // idle time split between the two states; the deep share drifts slowly
    const idleRate = 1 - u - sy - sirq - irq;
    const idleUs = idleRate * s * 1e6;
    const wfi = 1e6 * cum(s, idleRate * 0.69, idleRate * 0.04, 700 + c * 31);
    const sleep = idleUs - wfi;
    const base = `sys/devices/system/cpu/cpu${c}/cpuidle`;
    put(`${base}/state0/name`, 'WFI');
    put(`${base}/state0/desc`, 'ARM WFI');
    put(`${base}/state0/latency`, '1');
    put(`${base}/state0/residency`, '1');
    put(`${base}/state0/disable`, '0');
    put(`${base}/state0/time`, String(int(wfi)));
    put(`${base}/state0/usage`, String(int(wfi / 126)));
    put(`${base}/state1/name`, 'cpu-sleep');
    put(`${base}/state1/desc`, 'cpu-sleep');
    put(`${base}/state1/latency`, '20');
    put(`${base}/state1/residency`, '1000');
    put(`${base}/state1/disable`, '0');
    put(`${base}/state1/time`, String(int(sleep)));
    put(`${base}/state1/usage`, String(int(sleep / 2200)));
  }
  const irqTotal = IRQS.reduce((a, r) => a + r[5].reduce((x, y) => x + y, 0), 0);
  put(
    'proc/stat',
    [line('cpu', ...tot, 0, 0), ...rows, `intr ${int(irqTotal * s)} 0`, `ctxt ${int(cum(s, 44000, 6000, 300))}`, `btime ${Math.floor(BOOT / 1000)}`, `processes ${int(cum(s, 53, 10, 600))}`, 'procs_running 3', 'procs_blocked 0', ''].join('\n')
  );
  put('proc/uptime', `${s.toFixed(2)} ${(s * 2.8).toFixed(2)}\n`);
  put('proc/loadavg', `${(2.8 + wobble(s, 0.3, 500)).toFixed(2)} ${(2.9 + wobble(s, 0.15, 1500)).toFixed(2)} 3.10 3/1437 99999\n`);

  // interrupts and softirqs
  const head = `${' '.repeat(11)}${Array.from({ length: CPUS }, (_, c) => `CPU${c}`.padStart(11)).join('')}`;
  put(
    'proc/interrupts',
    [
      head,
      ...IRQS.map(([id, chip, hw, type, name, rates]) => {
        const counts = rates.map((r, c) => String(int(cum(s, r, r * 0.3, 300 + c * 13))).padStart(11)).join('');
        return /^\d+$/.test(id) ? `${id.padStart(4)}:${counts}     ${chip.padEnd(6)} ${hw} ${type}     ${name}` : `${id}:${counts}       ${name}`;
      }),
      'Err:          0',
      '',
    ].join('\n')
  );
  put('proc/softirqs', [`${' '.repeat(20)}${Array.from({ length: CPUS }, (_, c) => `CPU${c}`.padEnd(11)).join('')}`, ...SOFTIRQS.map(([n, rates]) => `${n.padStart(12)}:${rates.map((r) => String(int(cum(s, r, r * 0.2, 400))).padStart(11)).join('')}`), ''].join('\n'));

  // network
  const dev = ['Inter-|   Receive                                                |  Transmit', ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed'];
  IFACES.forEach(([name, rx, tx, drv, speed, carrier], i) => {
    const rxB = int(cum(s, (rx * 1e6) / 8, (rx * 1e6) / 16, 300 + i * 17));
    const txB = int(cum(s, (tx * 1e6) / 8, (tx * 1e6) / 16, 280 + i * 13));
    dev.push(`${name.padStart(8)}: ${rxB} ${int(rxB / 900)} 0 ${int(s / 4000)} 0 0 0 0 ${txB} ${int(txB / 700)} 0 0 0 0 0 0`);
    if (name === 'lo') return;
    const base = `sys/class/net/${name}`;
    put(`${base}/operstate`, carrier ? 'up' : 'down');
    if (carrier !== null) put(`${base}/carrier`, String(carrier));
    if (speed) put(`${base}/speed`, String(speed));
    put(`${base}/duplex`, speed ? 'full' : 'unknown');
    put(`${base}/mtu`, name.startsWith('eth9') ? '1500' : '9216');
    if (drv) links[`${base}/device/driver`] = `../../../bus/platform/drivers/${drv}`;
    if (name === 'br0') put(`${base}/bridge/bridge_id`, '8000.000000000000');
  });
  put('proc/1/net/dev', `${dev.join('\n')}\n`);
  put('proc/1/net/stat/nf_conntrack', `entries  searched found new\n${int(1050 + wobble(s, 120, 900)).toString(16).padStart(8, '0')}  00000000 00000000 00000000\n`);
  put('proc/sys/net/netfilter/nf_conntrack_max', '65536\n');

  // memory
  const avail = int(830000 + wobble(s, 40000, 1800));
  put('proc/meminfo', `MemTotal:        4040828 kB\nMemFree:          120000 kB\nMemAvailable:     ${avail} kB\nBuffers:           59000 kB\nCached:           610000 kB\nSwapTotal:       3982392 kB\nSwapFree:        2520000 kB\n`);
  put('proc/swaps', 'Filename\t\t\t\tType\t\tSize\tUsed\tPriority\n/dev/md0                                partition\t1961980\t1459792\t2000\n/dev/zram0                              partition\t2020412\t2600\t1500\n');
  put('sys/block/zram0/mm_stat', '2662400  1015808  1351680        0  1351680        0        0        0\n');
  put('sys/block/zram0/disksize', '2068905984\n');

  // storage
  const disk = (reads, rs, writes, ws, busy) => line(reads, 0, rs, 0, writes, 0, ws, 0, 0, busy, 0, 0, 0, 0, 0);
  put(
    'proc/diskstats',
    [
      `   8       0 sda ${disk(int(cum(s, 7.2, 3, 600)), int(cum(s, 205, 80, 600)), int(cum(s, 11.2, 4, 600)), int(cum(s, 880, 300, 600)), int(cum(s, 290, 120, 900)))}`,
      ` 135       0 boot ${disk(int(cum(s, 4.1)), int(cum(s, 240)), int(cum(s, 7)), int(cum(s, 145)), int(cum(s, 30)))}`,
      `   9       3 md3 ${disk(int(cum(s, 3.6)), int(cum(s, 136)), int(cum(s, 10.5)), int(cum(s, 850)), 0)}`,
      `   7       0 loop0 ${disk(10, 80, 0, 0, 0)}`,
      '',
    ].join('\n')
  );
  links['sys/block/sda/device'] = '/sys/devices/platform/soc/ahci.0/ata1/host0/target0:0:0/0:0:0:0';
  links['sys/block/boot/device'] = '/sys/devices/platform/soc/xhci.0/usb2/2-1/2-1:1.0/host4/target4:0:0/4:0:0:0';
  put('sys/block/md3/md/level', 'raid1');
  put('sys/block/loop0/size', '0');
  put('proc/mdstat', 'Personalities : [raid1]\nmd0 : active raid1 sda2[0]\n      1961984 blocks super 1.2 [2/1] [U_]\n\nmd3 : active raid1 sda5[0]\n      3898493952 blocks super 1.2 [2/1] [U_]\n      bitmap: 1/1 pages [4KB], 65536KB chunk\n\nunused devices: <none>\n');

  // sensors
  const soc = 61 + wobble(s, 2.5, 600);
  put('sys/class/thermal/thermal_zone0/type', 'cpu-thermal');
  put('sys/class/thermal/thermal_zone0/temp', String(int(soc * 1000)));
  put('sys/class/thermal/thermal_zone0/policy', 'step_wise');
  put('sys/class/thermal/thermal_zone0/trip_point_0_temp', '105000');
  put('sys/class/thermal/thermal_zone0/trip_point_0_type', 'critical');
  const h = 'sys/class/hwmon/hwmon0/device';
  const cpuT = 45 + wobble(s, 1.2, 600, 1);
  const duty = Math.round(60 + ((cpuT - 40) / 25) * 195);
  put(`${h}/name`, 'adt7475');
  put(`${h}/temp1_input`, String(int(cpuT * 4) * 250));
  put(`${h}/temp1_max`, '191000');
  put(`${h}/temp1_crit`, '100000');
  put(`${h}/temp2_input`, String(int((41.5 + wobble(s, 0.5, 900)) * 4) * 250));
  put(`${h}/temp3_input`, String(int((42 + wobble(s, 0.5, 800)) * 4) * 250));
  put(`${h}/fan1_input`, '0');
  put(`${h}/fan3_input`, '0');
  put(`${h}/fan4_input`, '0');
  put(`${h}/pwm3`, '25');
  put(`${h}/pwm3_enable`, '1');
  put(`${h}/fan2_input`, String(Math.round(duty * 17.8)));
  put(`${h}/pwm1`, '0');
  put(`${h}/pwm1_enable`, '1');
  put(`${h}/pwm2`, String(duty));
  put(`${h}/pwm2_enable`, '1');
  put(`${h}/in1_input`, '891');
  put(`${h}/in1_min`, '0');
  put(`${h}/in1_max`, '2988');
  put(`${h}/in2_input`, String(3265 + Math.round(wobble(s, 4, 120))));
  put(`${h}/in2_min`, '2960');
  put(`${h}/in2_max`, '3631');

  // processes
  for (const [pid, comm, ppid, cpu, threads, rss, cg, cmd] of PROCS) {
    const ut = int(HZ * cum(s, cpu * 0.7, cpu * 0.25, 300 + pid));
    const st = int(HZ * cum(s, cpu * 0.3, cpu * 0.1, 500 + pid));
    const f = ['S', ppid, pid, pid, 0, -1, 4194560, 1000, 0, 0, 0, ut, st, 0, 0, 20, 0, threads, 0, 300 + pid, rss * 1048576, int((rss * 1048576) / 4096)];
    put(`proc/${pid}/stat`, `${pid} (${comm}) ${f.join(' ')} 0 0 0\n`);
    put(`proc/${pid}/cmdline`, cmd ? `${cmd.split(' ').join('\0')}\0` : '');
    put(`proc/${pid}/cgroup`, `0::${cg}\n`);
    links[`proc/${pid}/ns/cgroup`] = pid === 2330 ? 'cgroup:[4026533543]' : 'cgroup:[4026531835]';
  }
  links['proc/self/ns/cgroup'] = 'cgroup:[4026533543]';
  put('proc/self/mountinfo', `1201 1170 0:23 /volume/00000000-0000-0000-0000-000000000000/docker/containers/${'c'.repeat(64)}/hostname /etc/hostname rw,relatime - ext4 /dev/sda rw\n`);

  const exec = {
    'ethtool -m eth9': { stdout: moduleText(true, s) },
    'ethtool -m eth10': { stdout: moduleText(false, s) },
    'smartctl -j -n standby -i -A -H /dev/sda': { stdout: smartJson(s) },
    'mca-dump': { stdout: mcaJson(t) },
  };
  return { files, links, exec };
}

module.exports = { fakeConsole };
