// UniFi console page: SoC, sensors, processes, ports, SFP modules, storage and the
// controller's own view. Only listed when the host reports caps.udm.
import { html, render, $ } from '../lib/html.js';
import * as fmt from '../lib/fmt.js';
import { lineChart } from '../components/chart.js';
import { dataTable } from '../components/table.js';

// categorical order, validated against --screen (dark): never cycled, max five per chart
const PALETTE = ['--ch-pkg', '--ch-psys', '--ch-wall', '--ch-core', '--ch-dram'];
const RANGES = [
  ['1h', '1 h'],
  ['6h', '6 h'],
  ['24h', '24 h'],
  ['7d', '7 d'],
];
const BOARD = ['SoC', 'CPU', 'Local', 'PHY'];
const KINDS = { service: 'Service', container: 'Container', kernel: 'Kernel', session: 'Login', other: 'Other' };
const SOFTIRQ = {
  HI: 'high-priority tasklets',
  TIMER: 'timer wheel',
  NET_TX: 'packet transmit',
  NET_RX: 'packet receive and forwarding',
  BLOCK: 'disk I/O completion',
  IRQ_POLL: 'polled I/O',
  TASKLET: 'driver tasklets',
  SCHED: 'scheduler load balancing',
  HRTIMER: 'high-resolution timers',
  RCU: 'RCU callbacks',
};

const touched = (keys, ...n) => keys.includes('*') || n.some((k) => keys.includes(k));
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const fix = (v, d = 1) => (isNum(v) ? v.toFixed(d) : '–');
const pc = (v) => (isNum(v) ? `${v.toFixed(1)} %` : '–');
const degC = (v) => (isNum(v) ? `${v.toFixed(1)} °C` : '–');
const int = (v) => (isNum(v) ? Math.round(v).toLocaleString('en-GB') : '–');
const natural = (a, b) => String(a).localeCompare(String(b), 'en', { numeric: true });

function bytes(b) {
  if (!isNum(b)) return '–';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let v = b;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v < 10 && i ? v.toFixed(2) : v < 100 && i ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

function mib(kb) {
  if (!isNum(kb)) return '–';
  const m = kb / 1024;
  return m >= 1024 ? `${(m / 1024).toFixed(2)} GiB` : `${Math.round(m)} MiB`;
}

function kbRate(kbps) {
  if (!isNum(kbps)) return '–';
  return kbps < 1024 ? `${Math.round(kbps)} KiB/s` : `${(kbps / 1024).toFixed(kbps < 10240 ? 1 : 0)} MiB/s`;
}

function mbit(v) {
  if (!isNum(v)) return '–';
  return v >= 100 ? String(Math.round(v)) : v >= 10 ? v.toFixed(1) : v.toFixed(2);
}

function uptime(sec) {
  if (!isNum(sec)) return '–';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : `${m} min`;
}

function cpuTime(sec) {
  if (!isNum(sec)) return '–';
  if (sec < 60) return `${sec} s`;
  if (sec < 3600) return `${Math.floor(sec / 60)} min`;
  if (sec < 86400) return `${(sec / 3600).toFixed(1)} h`;
  return `${(sec / 86400).toFixed(1)} d`;
}

const linkSpeed = (mbps) => (isNum(mbps) ? (mbps >= 1000 ? `${mbps / 1000} Gbit/s` : `${mbps} Mbit/s`) : '–');

function tile({ label, value, unit, sub, ch, empty }) {
  return html`<div class="readout ${empty ? 'empty' : ''}" style="${ch ? `--ch:var(${ch})` : ''}">
    <div class="label"><span>${label}</span></div>
    <div class="value">${value}${unit ? html`<span class="unit">${unit}</span>` : ''}</div>
    ${sub ? html`<div class="sub" title="${sub}">${sub}</div>` : ''}
  </div>`;
}

const kv = (rows) => html`<dl class="kv">${rows.filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>`;

const fanName = (id) => (/^fan(\d+)$/.test(id) ? `Fan ${id.slice(3)}` : /^pwm(\d+)$/.test(id) ? `PWM ${id.slice(3)}` : id);

/** Chart specs: keys(all) picks the series from the history columns, in a fixed order. */
function chartSpecs(view) {
  const has = (all, k) => all.includes(k);
  return [
    { id: 'cpu', title: 'CPU time, % of all cores', unit: '%', keys: (all) => ['usr', 'sys', 'sirq', 'iow'].filter((k) => has(all, k)), label: (k) => ({ usr: 'User', sys: 'System', sirq: 'Softirq', iow: 'IO wait' })[k], f: fmt.pct },
    { id: 'idle', title: 'Active and idle states, % of time', unit: '%', yMax: 100, keys: (all) => ['act', ...all.filter((k) => k.startsWith('I:')).sort(natural)].filter((k) => has(all, k)).slice(0, 5), label: (k) => (k === 'act' ? 'Active' : k.slice(2)), f: fmt.pct },
    { id: 'board', title: 'SoC and board temperature, °C', unit: '°C', yAuto: true, keys: (all) => BOARD.map((b) => `T:${b}`).filter((k) => has(all, k)), label: (k) => k.slice(2), f: (v) => fix(v) },
    {
      id: 'parts',
      title: 'Module and drive temperature, °C',
      unit: '°C',
      yAuto: true,
      keys: (all) => all.filter((k) => k.startsWith('T:') && !BOARD.includes(k.slice(2))).sort(natural).slice(0, 5),
      label: (k) => k.slice(2),
      f: (v) => fix(v),
    },
    { id: 'fans', title: 'Fan speed, rpm', unit: 'rpm', keys: (all) => all.filter((k) => k.startsWith('F:')).sort(natural).slice(0, 5), label: (k) => fanName(k.slice(2)), f: (v) => int(v) },
    {
      id: 'net',
      title: () => `Traffic on ${view.port || 'a port'}, Mbit/s`,
      unit: 'Mbit/s',
      keys: (all) => (view.port ? [`rx:${view.port}`, `tx:${view.port}`].filter((k) => has(all, k)) : []),
      label: (k) => (k.startsWith('rx:') ? 'Receive' : 'Transmit'),
      f: mbit,
      ports: true,
    },
    { id: 'optical', title: 'Optical power, dBm', unit: 'dBm', yAuto: true, keys: (all) => all.filter((k) => /^(rxp|txp):/.test(k)).sort(natural).slice(0, 4), label: (k) => `${k.startsWith('rxp') ? 'Received' : 'Transmitted'} ${k.split(':')[1]}`, f: (v) => fix(v, 2) },
    { id: 'mem', title: 'Memory and swap in use, %', unit: '%', yMax: 100, keys: (all) => ['mem', 'swap'].filter((k) => has(all, k)), label: (k) => (k === 'mem' ? 'Memory' : 'Swap'), f: fmt.pct },
    { id: 'disk', title: 'Disk busy, % of time', unit: '%', yMax: 100, keys: (all) => all.filter((k) => k.startsWith('db:')).sort(natural).slice(0, 5), label: (k) => k.slice(3), f: fmt.pct },
    { id: 'ct', title: 'Tracked connections', unit: '', keys: (all) => ['ct'].filter((k) => has(all, k)), label: () => 'Connections', f: (v) => int(v) },
    { id: 'rates', title: 'Context switches and interrupts per second', unit: '/s', keys: (all) => ['ctx', 'int'].filter((k) => has(all, k)), label: (k) => (k === 'ctx' ? 'Context switches' : 'Interrupts'), f: (v) => int(v) },
  ];
}

export default {
  id: 'udm',
  label: 'UDM',
  when: (s) => Boolean(s.status && s.status.caps && s.status.caps.udm),

  mount(root, actions) {
    this.root = root;
    this.actions = actions;
    this.range = '24h';
    this.port = null;
    this.data = null;
    this.hist = null;
    this.charts = {};
    this.sig = {};
    this.showAll = false;
    this.specs = chartSpecs(this);
    render(
      root,
      html`<h1>UDM</h1>
        <p class="lede silk" data-r="lede">Loading the console readings.</p>
        <div data-r="body">
          <section class="readouts inline" aria-label="Console readings" data-r="figs"></section>
          <div class="grid-2">
            <section class="panel"><div class="panel-head"><h2>Device</h2></div><div data-r="device"></div></section>
            <section class="panel"><div class="panel-head"><h2>Fans, display and idle states</h2><span class="note">what sets the power draw</span></div><div data-r="power"></div></section>
          </div>
          <section class="panel"><div class="panel-head"><h2>CPU</h2><span class="note" data-r="cpu-note"></span></div><div data-r="cpu"></div></section>
          <section class="panel">
            <div class="panel-head"><h2>History</h2><div class="seg" role="radiogroup" aria-label="Time range" data-r="range"></div><span class="spacer"></span><span class="note" data-r="hist-note"></span></div>
            <div class="grid-charts" data-r="charts"></div>
          </section>
          <section class="panel"><div class="panel-head"><h2>Processes</h2><span class="note" data-r="proc-note"></span></div><div data-r="groups"></div><div data-r="procs"></div></section>
          <div class="grid-2">
            <section class="panel"><div class="panel-head"><h2>Interrupts</h2><span class="note">per second, busiest first</span></div><div class="table-wrap" data-r="irqs"></div></section>
            <section class="panel"><div class="panel-head"><h2>Softirqs</h2><span class="note">deferred kernel work per second</span></div><div class="table-wrap" data-r="softirqs"></div></section>
          </div>
          <div class="grid-2">
            <section class="panel"><div class="panel-head"><h2>Sensors</h2></div><div class="table-wrap" data-r="sensors"></div></section>
            <section class="panel"><div class="panel-head"><h2>Memory and swap</h2></div><div data-r="memory"></div></section>
          </div>
          <section class="panel"><div class="panel-head"><h2>SFP+ modules</h2><span class="note">module EEPROM and digital diagnostics</span></div><div data-r="sfp"></div></section>
          <section class="panel">
            <div class="panel-head"><h2>Ports</h2><span class="note" data-r="ports-note"></span><span class="spacer"></span>
              <label class="switch"><input type="checkbox" data-r="all-if"><span class="knob"></span><span class="silk">Show VLANs, bridges and tunnels</span></label></div>
            <div class="table-wrap" data-r="ports"></div>
          </section>
          <section class="panel"><div class="panel-head"><h2>Storage</h2></div><div data-r="storage"></div></section>
          <section class="panel"><div class="panel-head"><h2>Controller</h2><span class="note" data-r="ctl-note"></span></div><div data-r="ctl"></div></section>
        </div>`
    );
    this.table = dataTable($('[data-r="procs"]', root), {
      placeholder: 'Search processes, services, containers',
      search: (r) => `${r.comm} ${r.group} ${r.cmd}`,
      chip: { label: 'Kind', of: (r) => KINDS[r.kind] || r.kind },
      sort: { key: 'cpu', dir: 'desc' },
      empty: 'No process data yet.',
      rowClass: (r) => (r.cpuPct > 0 ? '' : 'muted'),
      columns: [
        { key: 'cpu', label: 'CPU', align: 'r', cls: 'num', sort: (r) => r.cpuPct, cell: (r) => (isNum(r.cpuPct) ? `${r.cpuPct.toFixed(r.cpuPct < 10 ? 2 : 1)} %` : '–') },
        { key: 'time', label: 'CPU time', align: 'r', cls: 'num', sort: (r) => r.cpuSec, cell: (r) => cpuTime(r.cpuSec) },
        { key: 'rss', label: 'Memory', align: 'r', cls: 'num', sort: (r) => r.rssMb, cell: (r) => (r.rssMb ? `${fix(r.rssMb, r.rssMb < 10 ? 1 : 0)} MiB` : '–') },
        { key: 'threads', label: 'Threads', align: 'r', cls: 'num', sort: (r) => r.threads, cell: (r) => int(r.threads) },
        { key: 'group', label: 'Belongs to', sort: (r) => r.group, cell: (r) => html`<span class="tag">${KINDS[r.kind] || r.kind}</span> ${r.group}` },
        { key: 'comm', label: 'Process', cls: 'mono', sort: (r) => r.comm, cell: (r) => html`${r.comm} <span class="dim">${r.pid}</span>` },
        { key: 'cmd', label: 'Command', cls: 'mono', sort: (r) => r.cmd, cell: (r) => html`<span class="clamp" title="${r.cmd}">${r.cmd}</span>` },
      ],
    });
    this.onClick = (e) => {
      const r = e.target.closest('[data-range]');
      if (r) {
        this.range = r.dataset.range;
        this.drawRange();
        this.loadHistory();
        return;
      }
      const p = e.target.closest('[data-port]');
      if (p) {
        this.port = p.dataset.port;
        this.drawCharts();
      }
    };
    this.onChange = (e) => {
      if (e.target.matches('[data-r="all-if"]')) {
        this.showAll = e.target.checked;
        if (this.data && this.data.fast) this.drawPorts(this.data);
      }
    };
    root.addEventListener('click', this.onClick);
    root.addEventListener('change', this.onChange);
    this.drawRange();
    this.timer = setInterval(() => this.load(), 10000);
    this.histTimer = setInterval(() => this.loadHistory(), 60000);
  },

  unmount() {
    clearInterval(this.timer);
    clearInterval(this.histTimer);
    this.table.destroy();
    Object.values(this.charts).forEach((c) => c && c.destroy());
    this.charts = {};
    this.root.removeEventListener('click', this.onClick);
    this.root.removeEventListener('change', this.onChange);
  },

  update(s, keys) {
    this.state = s;
    if (touched(keys, 'host')) {
      this.data = null;
      this.hist = null;
      this.port = null;
    }
    if (touched(keys, 'host', 'status')) {
      if (s.status && !this.isConsole(s)) {
        this.showMissing();
        return;
      }
      if (!this.data && s.status) {
        this.load();
        this.loadHistory();
      }
    }
  },

  isConsole(s) {
    return Boolean(s.status && s.status.caps && s.status.caps.udm);
  },

  showMissing() {
    render($('[data-r="lede"]', this.root), html`This host is not a UniFi console: the page appears for hosts that expose <span class="mono">/proc/ubnthal</span>.`);
    $('[data-r="body"]', this.root).hidden = true;
  },

  async load() {
    if (this.state && !this.isConsole(this.state)) return;
    try {
      const d = await this.actions.api('udm');
      if (!d || !d.available) {
        this.showMissing();
        return;
      }
      this.data = d;
      $('[data-r="body"]', this.root).hidden = false;
      this.draw(d);
    } catch (e) {
      render($('[data-r="lede"]', this.root), html`<span class="form-error">Could not load the console readings: ${e.message}</span>`);
    }
  },

  async loadHistory() {
    if (this.state && !this.isConsole(this.state)) return;
    try {
      this.hist = await this.actions.api(`udm/history?range=${this.range}`);
    } catch {
      this.hist = null;
    }
    this.drawCharts();
  },

  drawRange() {
    render(
      $('[data-r="range"]', this.root),
      html`${RANGES.map(([id, label]) => html`<button type="button" role="radio" aria-checked="${id === this.range}" data-range="${id}">${label}</button>`)}`
    );
  },

  draw(d) {
    const f = d.fast;
    const i = d.info || {};
    render(
      $('[data-r="lede"]', this.root),
      html`${i.model || 'UniFi console'}${i.firmware ? `, UniFi OS ${i.firmware}` : ''}, up ${uptime(i.uptimeSec)}.
        ${f && f.dtSec ? `Rates cover the last ${Math.round(f.dtSec)} s; the page refreshes every 10 s.` : 'Collecting the first interval.'}`
    );
    if (!f) return;
    this.drawFigures(d);
    this.drawDevice(d);
    this.drawPower(d);
    this.drawCpu(d);
    this.drawProcs(d);
    this.drawIrqs(d);
    this.drawSensors(d);
    this.drawMemory(d);
    this.drawSfp(d);
    this.drawPorts(d);
    this.drawStorage(d);
    this.drawCtl(d);
    if (!this.port) {
      const wan = f.net.ifaces.find((x) => x.kind === 'port' && x.wan);
      if (wan) {
        this.port = wan.name;
        this.drawCharts();
      }
    }
  },

  drawFigures(d) {
    const f = d.fast;
    const c = f.cpu.total || {};
    const zone = f.sensors.thermal.find((z) => isNum(z.c));
    const crit = zone && zone.trips.find((t) => t.type === 'critical');
    const fans = f.sensors.hwmon.flatMap((h) => h.fans.map((x) => ({ ...x, pwmInfo: h.pwms.find((p) => p.id === x.pwm) })));
    const fan = fans.find((x) => x.rpm > 0) || fans[0];
    const wan = f.net.ifaces.find((x) => x.kind === 'port' && x.wan);
    const disk = f.storage.disks.find((x) => x.kind === 'sata' || x.kind === 'nvme');
    const ct = f.net.conntrack;
    const tiles = [
      tile({ label: 'CPU busy', value: fix(c.busy), unit: '%', ch: '--ch-pkg', sub: isNum(c.user) ? `user ${fix(c.user + c.nice)} · system ${fix(c.system)} · softirq ${fix(c.softirq)}` : 'collecting', empty: !isNum(c.busy) }),
      tile({ label: 'IO wait', value: fix(c.iowait), unit: '%', sub: 'CPU idle, waiting on storage', empty: !isNum(c.iowait) }),
      tile({ label: 'SoC', value: fix(zone && zone.c), unit: '°C', sub: crit ? `critical at ${fix(crit.c, 0)} °C` : 'die temperature', empty: !zone }),
      tile({ label: fan ? fanName(fan.id) : 'Fan', value: fan ? int(fan.rpm) : '–', unit: 'rpm', sub: fan && fan.pwmInfo ? `duty ${fix(fan.pwmInfo.pct, 0)} %${fan.follows ? ` · follows ${fan.follows}` : ''}` : '', empty: !fan }),
      tile({ label: 'Connections', value: ct ? int(ct.entries) : '–', sub: ct && ct.max ? `of ${int(ct.max)} tracked` : 'conntrack table', empty: !ct }),
      tile({ label: 'Memory', value: fix(f.memory.usedPct), unit: '%', sub: isNum(f.memory.swapUsedPct) ? `swap ${fix(f.memory.swapUsedPct)} % in use` : '', empty: !isNum(f.memory.usedPct) }),
      tile({ label: wan ? `WAN ${wan.name} receive` : 'WAN', value: wan ? mbit(wan.rxMbps) : '–', unit: 'Mbit/s', sub: wan ? `transmit ${mbit(wan.txMbps)} Mbit/s` : '', empty: !wan }),
      tile({ label: disk ? `Disk ${disk.name} busy` : 'Disk', value: disk ? fix(disk.busyPct) : '–', unit: '%', sub: disk ? `read ${kbRate(disk.readKBps)} · write ${kbRate(disk.writeKBps)}` : '', empty: !disk }),
    ];
    render($('[data-r="figs"]', this.root), html`${tiles}`);
  },

  drawDevice(d) {
    const i = d.info || {};
    const sp = i.spec || {};
    const disp = d.config && d.config.display;
    render(
      $('[data-r="device"]', this.root),
      html`${kv([
        ['Model', `${i.model || '–'}${i.shortname ? ` (${i.shortname}${isNum(i.boardRev) ? `, board revision ${i.boardRev}` : ''})` : ''}`],
        ['SoC', sp.soc ? `${sp.soc}${i.cpu ? ` (${i.cpu})` : ''}, ${sp.cores}× ${sp.core}` : i.cpu],
        ['CPU clock', sp.clockGHz ? `${sp.clockGHz} GHz, fixed: no frequency scaling, so power follows load and idle depth only` : null],
        ['Memory', isNum(i.ramBytes) ? `${(i.ramBytes / 1073741824).toFixed(0)} GiB${sp.ram ? ` (spec ${sp.ram})` : ''}` : sp.ram],
        ['Built-in storage', sp.storage],
        ['Power supply', sp.psu ? `${sp.psu}; spec maximum draw ${sp.maxW} W` : null],
        ['Power meter', 'none on board: the SoC has no energy counters and the supply no telemetry'],
        ['Firmware', i.firmware ? `UniFi OS ${i.firmware}` : null],
        ['Build', i.build ? html`<span class="mono">${i.build}</span>` : null],
        ['Kernel', i.kernel],
        ['Made', i.made ? `${i.made.year}, week ${i.made.week}` : null],
        ['Up', uptime(i.uptimeSec)],
        ['Front display', disp ? `${disp.enabled === false ? 'off' : 'on'}${isNum(disp.brightness) ? `, brightness ${disp.brightness} %` : ''}${disp.night ? `, night mode ${disp.night.from}–${disp.night.to}` : ''}` : null],
      ])}`
    );
  },

  drawPower(d) {
    const f = d.fast;
    const cfg = d.config || {};
    const hw = f.sensors.hwmon;
    const curves = cfg.fan || [];
    const tempOf = (src) => {
      if (!src) return null;
      if (src.startsWith('/')) return { label: src.split('/').pop(), c: null };
      for (const h of hw) {
        const t = h.temps.find((x) => x.id === src);
        if (t) return t;
      }
      return { label: src, c: null };
    };
    const pwmNow = (id) => {
      for (const h of hw) {
        const p = h.pwms.find((x) => x.id === id);
        if (p) return p;
      }
      return null;
    };
    const fanRpm = (id) => {
      for (const h of hw) {
        const x = h.fans.find((y) => y.id === id);
        if (x) return x.rpm;
      }
      return null;
    };
    const duty = (v) => (isNum(v) ? `${Math.round((v / 255) * 100)} %` : '–');
    const fanBlock = curves.length
      ? html`<div class="table-wrap"><table class="data"><thead><tr><th scope="col">Fan</th><th scope="col">Follows</th><th scope="col" class="r">Curve</th><th scope="col" class="r">Now</th></tr></thead>
          <tbody>${curves.map((c) => {
            const t = tempOf(c.source);
            const p = pwmNow(c.pwm);
            const now = isNum(c.sourceValue) ? c.sourceValue : t ? t.c : null;
            return html`<tr><td>${c.fan ? fanName(c.fan) : fanName(c.pwm)}</td><td>${t ? t.label : c.source}${isNum(now) ? html` <span class="silk num">${fix(now)} °C</span>` : ''}</td>
              <td class="r num">${isNum(c.minTemp) ? `${c.minTemp} °C → ${duty(c.minPwm)}` : ''}${isNum(c.maxTemp) ? ` … ${c.maxTemp} °C → ${duty(c.maxPwm)}` : ''}</td>
              <td class="r num">${p ? `${fix(p.pct, 0)} %` : '–'}${c.fan ? html` <span class="silk">${int(fanRpm(c.fan))} rpm</span>` : ''}</td></tr>`;
          })}</tbody></table></div>
          <p class="silk small">Fan control service ${cfg.fanRunning === false ? html`<strong class="delta-up">is not running</strong>` : 'is running'}; below the low point the duty stays at its minimum, above the high point at full speed.</p>`
      : html`<p class="empty-state">No fan control configuration found.</p>`;
    const states = [];
    const cpus = f.cpu.cpus;
    for (const s0 of (cpus[0] && cpus[0].idle) || []) {
      const all = cpus.map((c) => c.idle.find((s) => s.name === s0.name)).filter(Boolean);
      const avgOf = (k) => {
        const v = all.map((s) => s[k]).filter(isNum);
        return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
      };
      states.push({ ...s0, pct: avgOf('pct'), bootPct: avgOf('bootPct'), avgUs: avgOf('avgUs'), perSec: all.map((s) => s.perSec).filter(isNum).reduce((a, b) => a + b, 0) });
    }
    render(
      $('[data-r="power"]', this.root),
      html`<h3 class="sub-h">Fan control</h3>${fanBlock}
        <h3 class="sub-h">Idle states</h3>
        ${states.length
          ? html`<div class="table-wrap"><table class="data"><thead><tr><th scope="col">State</th><th scope="col" class="r">Exit latency</th><th scope="col" class="r">Worth it after</th><th scope="col" class="r">Now</th><th scope="col" class="r">Since boot</th><th scope="col" class="r">Average stay</th><th scope="col" class="r">Entries/s</th></tr></thead>
              <tbody>${states.map(
                (s) => html`<tr><td>${s.name}${s.desc && s.desc !== s.name ? html` <span class="dim">${s.desc}</span>` : ''}</td><td class="r num">${int(s.latencyUs)} µs</td><td class="r num">${int(s.residencyUs)} µs</td>
                  <td class="r num">${pc(s.pct)}</td><td class="r num">${pc(s.bootPct)}</td><td class="r num">${isNum(s.avgUs) ? `${int(s.avgUs)} µs` : '–'}</td><td class="r num">${int(s.perSec)}</td></tr>`
              )}</tbody></table></div>
              <p class="silk small">Shares are of wall time, averaged over the cores. The deeper state saves more but only pays off for idle periods longer than its target residency, so a high interrupt rate keeps cores in the shallow one.</p>`
          : html`<p class="empty-state">No cpuidle data.</p>`}`
    );
  },

  drawCpu(d) {
    const c = d.fast.cpu;
    const names = [...new Set(c.cpus.flatMap((x) => x.idle.map((s) => s.name)))];
    const deepest = names[names.length - 1];
    const cell = (v) => html`<td class="r num">${pc(v)}</td>`;
    const row = (label, split, cpu, boot) => {
      const st = (n) => (cpu ? cpu.idle.find((s) => s.name === n) : null);
      const avgSt = (n, k) => {
        const v = c.cpus.map((x) => (x.idle.find((s) => s.name === n) || {})[k]).filter(isNum);
        return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
      };
      const get = (n, k) => (cpu ? (st(n) || {})[k] : avgSt(n, k));
      const s = split || {};
      return html`<tr><th scope="row" class="silk" style="font-weight:500;text-align:left;padding:5px 10px">${label}</th>
        ${cell(s.busy)}${cell(isNum(s.user) ? s.user + (s.nice || 0) : null)}${cell(s.system)}${cell(s.softirq)}${cell(s.iowait)}${cell(s.idle)}
        ${names.map((n) => cell(get(n, 'pct')))}
        <td class="r num">${isNum(get(deepest, 'avgUs')) ? `${int(get(deepest, 'avgUs'))} µs` : '–'}</td>
        ${cell(boot && boot.busy)}</tr>`;
    };
    $('[data-r="cpu-note"]', this.root).textContent = `busy = not idle and not waiting on I/O; the last column is the average since boot`;
    render(
      $('[data-r="cpu"]', this.root),
      html`<div class="table-wrap"><table class="data">
          <thead><tr><th scope="col">CPU</th><th scope="col" class="r">Busy</th><th scope="col" class="r">User</th><th scope="col" class="r">System</th><th scope="col" class="r">Softirq</th><th scope="col" class="r">IO wait</th><th scope="col" class="r">Idle</th>
            ${names.map((n) => html`<th scope="col" class="r">${n}</th>`)}<th scope="col" class="r">${deepest ? `Average ${deepest}` : ''}</th><th scope="col" class="r">Busy since boot</th></tr></thead>
          <tbody>${c.cpus.map((x) => row(x.cpu.replace(/^cpu/, 'CPU '), x.split, x, x.boot))}${row('All', c.total, null, c.boot)}</tbody>
        </table></div>
        <p class="silk small">Context switches ${int(c.ctxPerSec)}/s · interrupts ${int(c.irqPerSec)}/s · new processes ${fix(c.forksPerSec, 1)}/s · running ${int(c.running)}, blocked ${int(c.blocked)} ·
          load ${c.load.map((x) => fix(x, 2)).join(' / ')} over 1, 5 and 15 min (it counts tasks waiting on I/O too, so it runs high on a busy disk).</p>`
    );
  },

  drawProcs(d) {
    const p = d.fast.procs;
    $('[data-r="proc-note"]', this.root).textContent = `${int(p.count)} processes (${int(p.kernel)} kernel threads), ${int(p.threads)} threads; CPU in % of one core, ${d.info && d.info.spec ? `${d.info.spec.cores} cores = ${d.info.spec.cores * 100} %` : 'all cores add up'}`;
    const g = p.groups.slice(0, 10);
    const max = Math.max(1, ...g.map((x) => x.cpuPct));
    render(
      $('[data-r="groups"]', this.root),
      g.length
        ? html`<h3 class="sub-h">Where the CPU goes</h3><div class="bars" style="margin-bottom:16px">${g.map(
            (x) => html`<div class="name">${x.group} <span class="dim">${KINDS[x.kind] || x.kind}${x.procs > 1 ? `, ${x.procs} processes` : ''}</span></div>
              <div class="track" role="img" aria-label="${x.group}: ${fix(x.cpuPct)} % of one core"><div class="fill" style="width:${((x.cpuPct / max) * 100).toFixed(1)}%"></div></div>
              <div class="val">${fix(x.cpuPct)} %</div>`
          )}</div>`
        : ''
    );
    this.table.setRows(p.rows);
  },

  drawIrqs(d) {
    const ir = d.fast.irqs;
    const n = ir.cpus || 0;
    const cols = Array.from({ length: n }, (_, i) => i);
    render(
      $('[data-r="irqs"]', this.root),
      ir.rows.length
        ? html`<table class="data"><thead><tr><th scope="col">Source</th><th scope="col" class="r">Total</th>${cols.map((i) => html`<th scope="col" class="r">CPU ${i}</th>`)}</tr></thead>
            <tbody>${ir.rows
              .filter((r) => r.rate === null || r.rate > 0)
              .slice(0, 14)
              .map(
                (r) => html`<tr><td class="wrap">${r.name}${r.chip ? html` <span class="dim">${r.chip} ${r.id}</span>` : ''}</td><td class="r num">${int(r.rate)}</td>
                  ${cols.map((i) => html`<td class="r num ${r.perCpu && r.perCpu[i] === 0 ? 'dim' : ''}">${r.perCpu ? int(r.perCpu[i]) : '–'}</td>`)}</tr>`
              )}</tbody></table>`
        : html`<p class="empty-state">No interrupt data.</p>`
    );
    const soft = d.fast.softirqs.rows.filter((r) => r.rate === null || r.rate > 0);
    render(
      $('[data-r="softirqs"]', this.root),
      soft.length
        ? html`<table class="data"><thead><tr><th scope="col">Type</th><th scope="col" class="r">Total</th>${cols.map((i) => html`<th scope="col" class="r">CPU ${i}</th>`)}</tr></thead>
            <tbody>${soft.map(
              (r) => html`<tr><td>${r.name} <span class="dim">${SOFTIRQ[r.name] || ''}</span></td><td class="r num">${int(r.rate)}</td>
                ${cols.map((i) => html`<td class="r num">${r.perCpu ? int(r.perCpu[i]) : '–'}</td>`)}</tr>`
            )}</tbody></table>`
        : html`<p class="empty-state">No softirq data.</p>`
    );
  },

  drawSensors(d) {
    const s = d.fast.sensors;
    const rows = [];
    for (const z of s.thermal) {
      const crit = z.trips.find((t) => t.type === 'critical');
      rows.push(html`<tr><td>${z.label}</td><td class="r num">${degC(z.c)}</td><td class="silk">${crit ? `critical ${fix(crit.c, 0)} °C` : ''}</td><td class="mono dim">${z.type}, ${z.policy || 'no policy'}</td></tr>`);
    }
    for (const h of s.hwmon) {
      for (const t of h.temps) rows.push(html`<tr class="${t.fault ? 'muted' : ''}"><td>${t.label}</td><td class="r num">${t.fault ? 'no sensor' : degC(t.c)}</td><td class="silk">${isNum(t.crit) ? `critical ${fix(t.crit, 0)} °C` : ''}</td><td class="mono dim">${h.name} ${t.id}</td></tr>`);
      for (const x of h.fans) {
        const p = h.pwms.find((y) => y.id === x.pwm);
        rows.push(
          html`<tr><td>${fanName(x.id)}</td><td class="r num">${x.rpm === 0 ? 'stopped' : `${int(x.rpm)} rpm`}</td><td class="silk">${p ? `duty ${fix(p.pct, 0)} %${p.mode ? `, ${p.mode}` : ''}` : ''}${x.follows ? `, follows ${x.follows}` : ''}</td><td class="mono dim">${h.name} ${x.id}</td></tr>`
        );
      }
      for (const v of h.volts) rows.push(html`<tr><td>${v.label}</td><td class="r num">${fix(v.v, 3)} V</td><td class="silk">${isNum(v.min) && isNum(v.max) ? `limits ${fix(v.min, 3)}–${fix(v.max, 3)} V` : ''}</td><td class="mono dim">${h.name} ${v.id}</td></tr>`);
    }
    for (const m of d.sfp || []) if (isNum(m.tempC)) rows.push(html`<tr><td>SFP ${m.iface}</td><td class="r num">${degC(m.tempC)}</td><td class="silk">${m.thresholds && m.thresholds.temp ? `warning above ${fix(m.thresholds.temp.highWarn, 0)} °C` : ''}</td><td class="mono dim">module diagnostics</td></tr>`);
    for (const disk of d.fast.storage.disks) if (disk.smart && isNum(disk.smart.tempC)) rows.push(html`<tr><td>${disk.name}</td><td class="r num">${degC(disk.smart.tempC)}</td><td class="silk">${disk.smart.model || ''}</td><td class="mono dim">SMART</td></tr>`);
    render(
      $('[data-r="sensors"]', this.root),
      rows.length
        ? html`<table class="data"><thead><tr><th scope="col">Sensor</th><th scope="col" class="r">Now</th><th scope="col">Notes</th><th scope="col">Source</th></tr></thead><tbody>${rows}</tbody></table>
            <p class="silk small">VCCP and VCC are the board monitor's two rail inputs; the core rail stays flat because this SoC never changes its voltage or clock.</p>`
        : html`<p class="empty-state">No sensors found.</p>`
    );
  },

  drawMemory(d) {
    const m = d.fast.memory;
    const used = isNum(m.totalKb) && isNum(m.availableKb) ? m.totalKb - m.availableKb : null;
    render(
      $('[data-r="memory"]', this.root),
      html`${kv([
          ['In use', isNum(m.usedPct) ? `${fix(m.usedPct)} % (${mib(used)} of ${mib(m.totalKb)})` : null],
          ['Available', mib(m.availableKb)],
          ['Page cache', mib(m.cachedKb)],
        ])}
        ${m.swaps.length
          ? html`<h3 class="sub-h">Swap</h3><div class="table-wrap"><table class="data"><thead><tr><th scope="col">Device</th><th scope="col">Type</th><th scope="col" class="r">Size</th><th scope="col" class="r">Used</th><th scope="col" class="r">Priority</th></tr></thead>
              <tbody>${m.swaps.map((s) => html`<tr><td class="mono">${s.dev}</td><td>${s.type}</td><td class="r num">${mib(s.sizeKb)}</td><td class="r num">${mib(s.usedKb)}${s.sizeKb ? html` <span class="silk">${fix((s.usedKb / s.sizeKb) * 100, 0)} %</span>` : ''}</td><td class="r num">${s.prio}</td></tr>`)}</tbody></table></div>
              <p class="silk small">The kernel fills the higher priority first. Swap on a disk partition costs disk I/O (see IO wait); compressed RAM swap (zram) costs CPU instead.</p>`
          : ''}
        ${m.zram.length
          ? html`<div class="table-wrap"><table class="data"><thead><tr><th scope="col">zram</th><th scope="col" class="r">Stored</th><th scope="col" class="r">Compressed</th><th scope="col" class="r">RAM used</th><th scope="col" class="r">Size</th></tr></thead>
              <tbody>${m.zram.map((z) => html`<tr><td class="mono">${z.dev}</td><td class="r num">${mib(z.origKb)}</td><td class="r num">${mib(z.comprKb)}</td><td class="r num">${mib(z.usedKb)}</td><td class="r num">${mib(z.sizeKb)}</td></tr>`)}</tbody></table></div>`
          : ''}`
    );
  },

  drawSfp(d) {
    const list = d.sfp || [];
    const el = $('[data-r="sfp"]', this.root);
    if (!list.length) {
      render(el, html`<p class="empty-state">No pluggable modules found, or ethtool could not read them yet (first read after about a minute).</p>`);
      return;
    }
    const ifs = d.fast.net.ifaces;
    const span = (lo, hi, d, unit) => (isNum(lo) && isNum(hi) ? `${fix(lo, d)}…${fix(hi, d)} ${unit}` : '–');
    const range = (t, d, unit) => (t ? span(t.lowWarn, t.highWarn, d, unit) : '–');
    const alarm = (t, d, unit) => (t ? span(t.lowAlarm, t.highAlarm, d, unit) : '–');
    render(
      el,
      html`<div class="cards">${list.map((m) => {
        const i = ifs.find((x) => x.name === m.iface);
        const th = m.thresholds || {};
        const laserW = isNum(m.vcc) && isNum(m.biasMa) ? (m.vcc * m.biasMa) / 1000 : null;
        return html`<div class="card">
          <h3>${m.iface} ${i && i.wan ? html`<span class="tag attn">WAN</span>` : ''} <span class="silk" style="font-weight:400">${[m.vendor, m.part].filter(Boolean).join(' ')}${m.rev ? ` rev ${m.rev}` : ''}</span></h3>
          ${kv([
            ['Type', [m.type, m.connector].filter(Boolean).join(', ')],
            ['Optics', [isNum(m.wavelengthNm) ? `${m.wavelengthNm} nm` : null, m.reach, m.bitrate].filter(Boolean).join(', ') || null],
            ['Declared power', `level ${m.powerLevel}: up to ${fix(m.powerMaxW, 1)} W (module EEPROM)`],
            ['Link', i ? `${i.port && i.port.up === false ? 'down' : i.carrier ? 'up' : 'down'}${isNum(i.speed) ? `, ${linkSpeed(i.speed)}` : ''}` : null],
          ])}
          ${m.ddm
            ? html`<div class="table-wrap"><table class="data" style="margin-top:8px"><thead><tr><th scope="col">Reading</th><th scope="col" class="r">Now</th><th scope="col" class="r">Normal range</th><th scope="col" class="r">Alarm range</th></tr></thead><tbody>
                <tr><td>Temperature</td><td class="r num">${degC(m.tempC)}</td><td class="r num">${range(th.temp, 0, '°C')}</td><td class="r num">${alarm(th.temp, 0, '°C')}</td></tr>
                <tr><td>Supply voltage</td><td class="r num">${fix(m.vcc, 3)} V</td><td class="r num">${range(th.vcc, 2, 'V')}</td><td class="r num">${alarm(th.vcc, 2, 'V')}</td></tr>
                <tr><td>Laser bias</td><td class="r num">${fix(m.biasMa, 1)} mA</td><td class="r num">${range(th.bias, 0, 'mA')}</td><td class="r num">${alarm(th.bias, 0, 'mA')}</td></tr>
                <tr><td>Transmit power</td><td class="r num">${fix(m.txDbm, 2)} dBm</td><td class="r num">${range(th.tx, 1, 'dBm')}</td><td class="r num">${alarm(th.tx, 1, 'dBm')}</td></tr>
                <tr><td>Receive power</td><td class="r num">${fix(m.rxDbm, 2)} dBm</td><td class="r num">${range(th.rx, 1, 'dBm')}</td><td class="r num">${alarm(th.rx, 1, 'dBm')}</td></tr>
              </tbody></table></div>
              ${m.flags.length ? html`<div class="callout fault" style="margin:8px 0 0"><strong>Active flags:</strong> ${m.flags.join(', ')}</div>` : ''}
              <p class="silk small">Supply voltage times bias current (${fix(laserW, 2)} W) is only the laser drive: the module reports no supply current, so its real draw is not measurable here. The EEPROM power level is the maximum it may take.</p>`
            : html`<p class="silk small">No digital diagnostics: passive cables have no electronics to report.</p>`}
        </div>`;
      })}</div>`
    );
  },

  drawPorts(d) {
    const ifs = d.fast.net.ifaces;
    const sfp = new Map((d.sfp || []).map((m) => [m.iface, m]));
    const ports = ifs.filter((x) => x.kind === 'port').sort((a, b) => ((a.port && a.port.idx) ?? 99) - ((b.port && b.port.idx) ?? 99) || natural(a.name, b.name));
    const counted = (x) => x.rxGB + x.txGB > 0;
    const ctlAge = d.ctl && d.ctl.t ? fmt.ago(d.ctl.t) : null;
    $('[data-r="ports-note"]', this.root).textContent = ctlAge ? `link state of the switch ports from the controller (${ctlAge}); kernel counters where the CPU sees the traffic` : 'kernel view';
    const link = (x) => {
      if (x.port) return x.port.enabled === false ? html`<span class="dim">disabled</span>` : x.port.up ? html`<span class="tag ok">up</span>` : html`<span class="silk">down</span>`;
      return x.carrier ? html`<span class="tag ok">up</span>` : html`<span class="silk">down</span>`;
    };
    const up = (x) => (x.port ? x.port.up : x.carrier);
    const rates = (x) => {
      if (counted(x)) return [x.rxMbps, x.txMbps, ''];
      if (x.port && isNum(x.port.rxMbps)) return [x.port.rxMbps, x.port.txMbps, `average over ${Math.round((x.port.rateSec || 0) / 60)} min`];
      return [null, null, ''];
    };
    const total = (b) => (b ? bytes(b) : '–');
    const rowsP = ports.map((x) => {
      const [rx, tx, note] = rates(x);
      const p = x.port;
      const errs = p && isNum(p.rxErrors) ? p.rxErrors + (p.txErrors || 0) : x.errors;
      const mod = sfp.get(x.name);
      return html`<tr class="${up(x) ? '' : 'muted'}"><td>${p && isNum(p.idx) ? `Port ${p.idx}` : ''}</td><td class="mono">${x.name}${x.wan ? html` <span class="tag attn">WAN</span>` : ''}</td>
        <td>${(p && p.media) || (x.driver ? 'internal' : '')}</td><td>${link(x)}</td><td class="r num">${up(x) ? linkSpeed(p && p.up ? p.speed : x.speed) : ''}</td>
        <td class="r num" title="${note}">${up(x) ? mbit(rx) : ''}</td><td class="r num" title="${note}">${up(x) ? mbit(tx) : ''}</td>
        <td class="r num">${total(counted(x) ? x.rxGB * 1e9 : p ? p.rxBytes : null)}</td><td class="r num">${total(counted(x) ? x.txGB * 1e9 : p ? p.txBytes : null)}</td>
        <td class="r num ${errs > 0 ? 'attn-text' : ''}">${int(errs)}${p && p.errPerMin > 0 ? html` <span class="silk">${fix(p.errPerMin, 1)}/min</span>` : ''}</td>
        <td>${mod ? [mod.vendor, mod.part].filter(Boolean).join(' ') : ''}</td></tr>`;
    });
    const others = this.showAll ? ifs.filter((x) => x.kind !== 'port') : [];
    render(
      $('[data-r="ports"]', this.root),
      html`<table class="data"><thead><tr><th scope="col">Port</th><th scope="col">Interface</th><th scope="col">Media</th><th scope="col">Link</th><th scope="col" class="r">Speed</th>
          <th scope="col" class="r">Receive, Mbit/s</th><th scope="col" class="r">Transmit, Mbit/s</th><th scope="col" class="r">Received</th><th scope="col" class="r">Sent</th><th scope="col" class="r">Errors</th><th scope="col">Module</th></tr></thead>
        <tbody>${rowsP}</tbody></table>
        ${others.length
          ? html`<table class="data" style="margin-top:14px"><thead><tr><th scope="col">Interface</th><th scope="col">Kind</th><th scope="col">State</th><th scope="col" class="r">Receive, Mbit/s</th><th scope="col" class="r">Transmit, Mbit/s</th><th scope="col" class="r">Received</th><th scope="col" class="r">Sent</th></tr></thead>
              <tbody>${others.map(
                (x) => html`<tr class="${x.carrier ? '' : 'muted'}"><td class="mono">${x.name}${x.wan ? html` <span class="tag attn">WAN</span>` : ''}</td><td>${x.kind}</td><td>${x.operstate || '–'}</td>
                  <td class="r num">${mbit(x.rxMbps)}</td><td class="r num">${mbit(x.txMbps)}</td><td class="r num">${bytes(x.rxGB * 1e9)}</td><td class="r num">${bytes(x.txGB * 1e9)}</td></tr>`
              )}</tbody></table>`
          : ''}
        <p class="silk small">The eight LAN ports sit behind an internal switch chip: the CPU only sees their traffic as one link (switch0), so their own rates come from the controller and are averages between its reports.</p>`
    );
  },

  drawStorage(d) {
    const st = d.fast.storage;
    const kindOf = (x) => (x.kind === 'md' ? 'software RAID' : x.kind === 'usb' ? 'USB flash' : x.smart && x.smart.ssd ? 'SATA SSD' : x.smart && x.smart.rpm ? `SATA disk, ${x.smart.rpm} rpm` : x.kind.toUpperCase());
    render(
      $('[data-r="storage"]', this.root),
      html`<div class="table-wrap"><table class="data"><thead><tr><th scope="col">Device</th><th scope="col">Kind</th><th scope="col">Model</th><th scope="col" class="r">Busy</th><th scope="col" class="r">Read/s</th><th scope="col" class="r">Write/s</th><th scope="col" class="r">IOPS</th>
          <th scope="col" class="r">Read since boot</th><th scope="col" class="r">Written since boot</th><th scope="col" class="r">Temp</th><th scope="col">Health</th><th scope="col" class="r">Life left</th><th scope="col" class="r">Written</th><th scope="col" class="r">Power-on</th><th scope="col">Power mode</th></tr></thead>
        <tbody>${st.disks.map((x) => {
          const s = x.smart || {};
          return html`<tr><td class="mono">${x.name}</td><td>${kindOf(x)}</td><td>${s.model || ''}</td><td class="r num">${pc(x.busyPct)}</td><td class="r num">${kbRate(x.readKBps)}</td><td class="r num">${kbRate(x.writeKBps)}</td><td class="r num">${int(x.iops)}</td>
            <td class="r num">${isNum(x.readGB) ? `${fix(x.readGB, 0)} GB` : '–'}</td><td class="r num">${isNum(x.writtenGB) ? `${fix(x.writtenGB, 0)} GB` : '–'}</td><td class="r num">${degC(s.tempC)}</td>
            <td>${s.healthy === true ? html`<span class="tag ok">passed</span>` : s.healthy === false ? html`<span class="tag fault">failing</span>` : s.error ? html`<span class="dim" title="${s.error}">no data</span>` : ''}</td>
            <td class="r num">${isNum(s.lifePct) ? `${s.lifePct} %` : ''}</td><td class="r num">${isNum(s.writtenTB) ? `${fix(s.writtenTB, 1)} TB` : ''}</td><td class="r num">${isNum(s.hours) ? `${int(s.hours)} h` : ''}</td><td>${s.powerMode || ''}</td></tr>`;
        })}</tbody></table></div>
        ${st.md.length
          ? html`<div class="table-wrap"><table class="data" style="margin-top:14px"><thead><tr><th scope="col">Array</th><th scope="col">Level</th><th scope="col">Members</th><th scope="col" class="r">Size</th><th scope="col">Slots</th><th scope="col">State</th></tr></thead>
              <tbody>${st.md.map((m) => html`<tr><td class="mono">${m.name}</td><td>${m.level}</td><td class="mono">${m.members.join(', ')}</td><td class="r num">${isNum(m.sizeGB) ? `${fix(m.sizeGB, 0)} GB` : '–'}</td>
                <td class="mono">${m.map ? `${m.active}/${m.slots} [${m.map}]` : ''}</td><td>${m.state}${m.sync ? `, ${m.sync.action} ${fix(m.sync.pct)} %` : ''}</td></tr>`)}</tbody></table></div>
              <p class="silk small">A mirror with one of two slots in use is how a single drive bay is set up; it is not a failed disk.</p>`
          : ''}
        <p class="silk small">Busy is the share of time the device had I/O in flight. Drive readings come from SMART every 5 min, read without waking a sleeping disk.</p>`
    );
  },

  drawCtl(d) {
    const c = d.ctl;
    const el = $('[data-r="ctl"]', this.root);
    const note = $('[data-r="ctl-note"]', this.root);
    if (!c) {
      note.textContent = '';
      render(el, html`<p class="empty-state">Waiting for the controller's device report (mca-dump), which is read every 2 minutes while this page is open.</p>`);
      return;
    }
    note.textContent = `from the controller's device report, ${fmt.ago(c.t)}${c.error ? ` (last read failed: ${c.error})` : ''}`;
    const st = c.speedtest;
    const wans = c.wans || [];
    render(
      el,
      html`<div class="grid-2">
        <div>${kv([
          ['Uplink', c.uplink ? html`<span class="mono">${c.uplink}</span>` : null],
          ...wans.map((w) => [`${w.name} health`, `${isNum(w.availability) ? `${fix(w.availability, 1)} % available` : ''}${isNum(w.latencyMs) ? `, ${w.latencyMs} ms average latency` : ''}`]),
          ['Last speed test', st ? `${int(st.downMbps)} down / ${int(st.upMbps)} up Mbit/s, ${st.latencyMs} ms${st.server ? `, ${st.server}` : ''}, ${fmt.dateTime(st.at)}` : 'none'],
          ['IDS/IPS signatures', c.ips && isNum(c.ips.rules) ? `${int(c.ips.rules)} ${c.ips.type || ''} rules${c.ips.updated ? `, updated ${fmt.dateTime(Date.parse(c.ips.updated))}` : ''}` : 'none loaded'],
          ['Traffic identification', isNum(c.dpiEntries) ? `${int(c.dpiEntries)} tracked endpoints` : null],
          ['Content filtering', c.contentFiltering ? c.contentFiltering.toLowerCase().replace(/_/g, ' ') : null],
          ['Controller CPU and memory', c.systemStats ? `${fix(c.systemStats.cpuPct)} %, ${fix(c.systemStats.memPct)} %` : null],
          ...(c.storage || []).map((s) => [`${s.name || s.mount} (${s.type})`, isNum(s.sizeBytes) && isNum(s.usedBytes) ? `${bytes(s.usedBytes)} of ${bytes(s.sizeBytes)} used` : null]),
        ])}
        <p class="silk small">Signature inspection and traffic identification run on the same four cores as routing, so they show up as CPU busy (and watts) under load.</p></div>
        <div>${wans.some((w) => w.monitors.length)
          ? html`<div class="table-wrap"><table class="data"><thead><tr><th scope="col">Monitor</th><th scope="col">Type</th><th scope="col" class="r">Available</th><th scope="col" class="r">Latency</th></tr></thead>
              <tbody>${wans.flatMap((w) => w.monitors.map((m) => html`<tr><td class="mono">${m.target}</td><td>${m.type}</td><td class="r num">${pc(m.availability)}</td><td class="r num">${isNum(m.latencyMs) ? `${m.latencyMs} ms` : '–'}</td></tr>`))}</tbody></table></div>`
          : ''}</div>
      </div>`
    );
  },

  chart(name, el, sig, make) {
    if (this.sig[name] !== sig) {
      if (this.charts[name]) this.charts[name].destroy();
      this.charts[name] = make();
      this.sig[name] = sig;
    }
    return this.charts[name];
  },

  drawCharts() {
    const wrap = $('[data-r="charts"]', this.root);
    const h = this.hist;
    const all = h && h.series ? Object.keys(h.series).filter((k) => h.series[k].some((v) => v !== null)) : [];
    const note = $('[data-r="hist-note"]', this.root);
    if (!h || !h.t || !h.t.length) {
      Object.values(this.charts).forEach((c) => c && c.destroy());
      this.charts = {};
      this.sig = {};
      render(wrap, html`<p class="chart-empty">No history yet: one point is stored per minute.</p>`);
      note.textContent = '';
      return;
    }
    const mins = Math.round(h.bucketMs / 60000);
    note.textContent = `${mins === 1 ? 'one point per minute' : `${mins}-minute averages`}`;
    const ports = [...new Set(all.filter((k) => k.startsWith('rx:')).map((k) => k.slice(3)))].sort(natural);
    if (this.port && !ports.includes(this.port)) this.port = null;
    if (!this.port && ports.length) this.port = ports[0];
    // one slot per chart, created once; contents redrawn
    if (!wrap.querySelector('[data-chart]')) {
      Object.values(this.charts).forEach((c) => c && c.destroy());
      this.charts = {};
      this.sig = {};
      render(
        wrap,
        html`${this.specs.map(
          (s) => html`<div class="screen" data-chart="${s.id}"><div class="chart-head"><p class="chart-title" data-title="${s.id}"></p>${s.ports ? html`<div class="seg seg-sm" role="radiogroup" aria-label="Port" data-ports></div>` : ''}</div><div class="chart" data-plot="${s.id}"></div></div>`
        )}`
      );
    }
    const xRange = () => (this.hist ? [this.hist.from / 1000, this.hist.to / 1000] : null);
    const xs = h.t.map((t) => t / 1000);
    for (const s of this.specs) {
      const box = wrap.querySelector(`[data-chart="${s.id}"]`);
      const el = box.querySelector('[data-plot]');
      box.querySelector('[data-title]').textContent = typeof s.title === 'function' ? s.title() : s.title;
      if (s.ports) {
        render(
          box.querySelector('[data-ports]'),
          html`${ports.map((p) => html`<button type="button" role="radio" aria-checked="${p === this.port}" data-port="${p}">${p}</button>`)}`
        );
      }
      const keys = s.keys(all);
      const c = this.chart(s.id, el, keys.join(','), () =>
        keys.length
          ? lineChart(el, {
              series: keys.map((k, i) => ({ label: s.label(k), color: PALETTE[i] })),
              height: 150,
              unit: s.unit,
              fmt: s.f,
              legend: true,
              yMax: s.yMax ?? null,
              yAuto: Boolean(s.yAuto),
              xRange,
            })
          : null
      );
      if (!c) {
        render(el, html`<p class="chart-empty">No data in this range.</p>`);
        continue;
      }
      c.setData(xs, keys.map((k) => h.series[k]));
    }
    hideEmpty(wrap);
  },
};

/** Hide chart slots that have nothing to show at all, so the grid stays compact. */
function hideEmpty(wrap) {
  for (const box of wrap.querySelectorAll('[data-chart]')) {
    const empty = box.querySelector('.chart-empty');
    box.hidden = Boolean(empty) && !box.querySelector('[data-ports] button');
  }
}

