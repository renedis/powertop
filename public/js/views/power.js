import { html, raw, render, $ } from '../lib/html.js';
import * as fmt from '../lib/fmt.js';
import { lineChart, CHANNELS, CHANNEL_ORDER } from '../components/chart.js';
import { breakdown } from '../components/bars.js';

const touched = (keys, ...n) => keys.includes('*') || n.some((k) => keys.includes(k));
const RANGES = [
  ['1h', '1 h'],
  ['6h', '6 h'],
  ['24h', '24 h'],
  ['7d', '7 d'],
];
const PHASES = [
  ['settle1', 'Settle'],
  ['baseline', 'Baseline'],
  ['apply', 'Apply'],
  ['settle2', 'Settle'],
  ['after', 'After'],
];

const meanLast = (arr, key, n = 3) => {
  const v = arr.slice(-n).map((s) => s[key]).filter((x) => typeof x === 'number');
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};

function delta(v) {
  if (typeof v !== 'number') return html`<span class="dim">–</span>`;
  if (Math.abs(v) < 0.005) return html`<span class="silk">±0 W</span>`;
  return v < 0
    ? html`<span class="delta-down" title="lower is better">▼ ${fmt.watts(-v)} W</span>`
    : html`<span class="delta-up" title="higher than before">▲ ${fmt.watts(v)} W</span>`;
}

export default {
  id: 'power',
  label: 'Power',

  mount(root, actions) {
    this.root = root;
    this.actions = actions;
    this.range = '24h';
    this.hist = null;
    this.charts = {};
    this.sig = {};
    render(
      root,
      html`<h1>Power</h1>
        <section class="panel">
          <div class="panel-head"><h2>History</h2>
            <div class="seg" role="radiogroup" aria-label="Time range" data-r="range"></div>
            <span class="spacer"></span><span class="note" data-r="hist-note"></span></div>
          <div class="screen"><div class="chart" data-r="hist"></div></div>
        </section>
        <section class="panel">
          <div class="panel-head"><h2>Per measurement</h2><span class="note">one point per powertop run</span></div>
          <div class="grid-3">
            <div class="screen"><p class="chart-title">CPU busy, %</p><div class="chart" data-r="m-cpu"></div></div>
            <div class="screen"><p class="chart-title">Wakeups per second</p><div class="chart" data-r="m-wak"></div></div>
            <div class="screen"><p class="chart-title" data-r="deep-title">Deep idle residency, %</p><div class="chart" data-r="m-deep"></div></div>
          </div>
        </section>
        <div class="grid-2">
          <section class="panel">
            <div class="panel-head"><h2>Where the watts go</h2><span class="note">live</span></div>
            <div data-r="breakdown"></div>
          </section>
          <section class="panel">
            <div class="panel-head"><h2>Sensors</h2><span class="note" data-r="mqtt-note"></span><span class="spacer"></span><a class="btn btn-quiet btn-sm" href="#/settings">Manage</a></div>
            <div class="table-wrap" data-r="sensors"></div>
          </section>
        </div>
        <section class="panel">
          <div class="panel-head"><h2>Impact tests</h2><span class="note">power before and after a change, with powertop held</span></div>
          <div data-r="impact"></div>
        </section>
        <section class="panel">
          <div class="panel-head"><h2>Events</h2><span class="note" data-r="events-note"></span></div>
          <div class="table-wrap" data-r="events"></div>
        </section>`
    );
    this.drawRange();
    this.onClick = (e) => {
      const r = e.target.closest('[data-range]');
      if (r) {
        this.range = r.dataset.range;
        this.drawRange();
        this.load();
      }
      if (e.target.closest('[data-act="cancel"]')) actions.cancelImpact();
    };
    root.addEventListener('click', this.onClick);
    this.timer = setInterval(() => this.load(), 60000);
    this.load();
  },

  unmount() {
    clearInterval(this.timer);
    Object.values(this.charts).forEach((c) => c && c.destroy());
    this.charts = {};
    this.root.removeEventListener('click', this.onClick);
  },

  async load() {
    try {
      this.hist = await this.actions.api(`history?range=${this.range}`);
    } catch (e) {
      this.hist = null;
      render($('[data-r="hist"]', this.root), html`<p class="chart-empty">Could not load history: ${e.message}</p>`);
      return;
    }
    this.drawHistory();
    this.drawMultiples();
    this.drawEvents(this.lastState);
  },

  update(s, keys) {
    this.lastState = s;
    if (keys.includes('host')) this.load();
    if (touched(keys, 'live', 'status', 'mqtt')) this.drawBreakdown(s);
    if (touched(keys, 'mqtt')) this.drawSensors(s);
    if (touched(keys, 'impact')) this.drawImpact(s);
    if (touched(keys, 'events')) this.drawEvents(s);
    if (touched(keys, 'report')) {
      const deep = s.summary && s.summary.kpi && s.summary.kpi.deep;
      const t = $('[data-r="deep-title"]', this.root);
      if (t && deep) t.textContent = deep.label === 'PC6+' ? 'Package C6 and deeper, %' : `${deep.label} residency, %`;
    }
  },

  drawRange() {
    render(
      $('[data-r="range"]', this.root),
      html`${RANGES.map(([id, label]) => html`<button type="button" role="radio" aria-checked="${id === this.range}" data-range="${id}">${label}</button>`)}`
    );
  },

  xRange() {
    return this.hist ? [this.hist.from / 1000, this.hist.to / 1000] : null;
  },

  chart(name, el, sig, make) {
    if (this.sig[name] !== sig) {
      if (this.charts[name]) this.charts[name].destroy();
      this.charts[name] = make();
      this.sig[name] = sig;
    }
    return this.charts[name];
  },

  drawHistory() {
    const el = $('[data-r="hist"]', this.root);
    const h = this.hist;
    const keys = CHANNEL_ORDER.filter((k) => h && h.power.series[k] && h.power.series[k].some((v) => v !== null));
    const markers = () => (this.hist ? this.hist.events.map((e) => ({ t: e.t, text: e.text })) : []);
    const c = this.chart('hist', el, `${keys.join(',')}`, () =>
      keys.length ? lineChart(el, { series: keys.map((k) => ({ ...CHANNELS[k], stepped: false })), height: 260, unit: 'W', fmt: fmt.watts, markers, zoom: true, xRange: () => this.xRange() }) : null
    );
    const note = $('[data-r="hist-note"]', this.root);
    if (!c || !h.power.t.length) {
      render(el, html`<p class="chart-empty">No power history yet. One point is stored per minute once RAPL or a wall sensor is available.</p>`);
      note.textContent = '';
      return;
    }
    c.setData(h.power.t.map((t) => t / 1000), keys.map((k) => h.power.series[k]));
    const mins = Math.round(h.bucketMs / 60000);
    note.textContent = `${mins === 1 ? 'one point per minute' : `${mins}-minute averages`}; drag to zoom, double-click to reset`;
  },

  drawMultiples() {
    const h = this.hist;
    const specs = [
      ['cpu', 'm-cpu', 'CPU', '%', (v) => fmt.pct(v)],
      ['wak', 'm-wak', 'Wakeups', '/s', (v) => fmt.rate(v)],
      ['deep', 'm-deep', 'Deep idle', '%', (v) => fmt.pct(v)],
    ];
    for (const [key, ref, label, unit, f] of specs) {
      const el = $(`[data-r="${ref}"]`, this.root);
      const has = h && h.runs.t.length && h.runs[key].some((v) => v !== null);
      const c = this.chart(ref, el, has ? 'y' : 'n', () =>
        has ? lineChart(el, { series: [{ label, color: '--ink' }], height: 130, unit, fmt: f, legend: true, yMax: unit === '%' && key === 'deep' ? 100 : null, xRange: () => this.xRange() }) : null
      );
      if (!c) {
        render(el, html`<p class="chart-empty">No data in this range.</p>`);
        continue;
      }
      c.setData(h.runs.t.map((t) => t / 1000), [h.runs[key]]);
    }
  },

  drawBreakdown(s) {
    const el = $('[data-r="breakdown"]', this.root);
    const rapl = s.live.rapl;
    const zones = (s.status && s.status.caps && s.status.caps.raplZones) || [];
    const lastWall = s.live.wall.length ? s.live.wall[s.live.wall.length - 1] : null;
    const wall = lastWall && Date.now() - lastWall.t < 600000 ? lastWall.v : null;
    const v = (k) => (zones.includes(k) ? meanLast(rapl, k) : null);
    const psys = v('psys');
    const pkg = v('pkg');
    const rows = [];
    if (wall !== null) rows.push({ name: 'Wall', value: wall, color: 'var(--ch-wall)' });
    if (psys !== null) rows.push({ name: 'Platform', value: psys, color: 'var(--ch-psys)' });
    if (pkg !== null) rows.push({ name: 'Package', value: pkg, color: 'var(--ch-pkg)' });
    for (const [k, name] of [['core', 'Core'], ['dram', 'DRAM'], ['uncore', 'Uncore']]) {
      const x = v(k);
      if (x !== null && (k !== 'uncore' || x >= 0.01)) rows.push({ name, value: x, color: `var(--ch-${k})` });
    }
    if (wall !== null && (psys ?? pkg) !== null) {
      rows.push({ name: psys !== null ? 'Outside the platform' : 'Outside the package', value: Math.max(0, wall - (psys ?? pkg)), color: 'var(--dim)' });
    }
    if (!rows.length) {
      render(el, html`<p class="empty-state">No live readings on this host.</p>`);
      return;
    }
    render(
      el,
      html`${breakdown(rows)}
        <p class="silk" style="font-size:13px;margin:10px 0 0">Platform and package come from RAPL counters; the package includes the cores, DRAM is separate.
        ${wall !== null ? 'The wall figure includes PSU losses, disks, network and the board.' : ''}</p>`
    );
  },

  drawSensors(s) {
    const el = $('[data-r="sensors"]', this.root);
    const m = s.mqtt;
    const note = $('[data-r="mqtt-note"]', this.root);
    note.textContent = !m || !m.configured ? '' : m.connected ? `connected to ${m.url}` : `not connected${m.error ? ` (${m.error})` : ''}`;
    if (!m || !m.sensors.length) {
      render(
        el,
        html`<p class="empty-state">No sensors yet. Add the smart plug that feeds this host to compare wall power before and after tuning.
          <a href="#/settings">Add a sensor</a></p>`
      );
      return;
    }
    render(
      el,
      html`<table class="data">
        <thead><tr><th scope="col">Sensor</th><th scope="col">Role</th><th scope="col" class="r">Value</th><th scope="col">Updated</th><th scope="col">Topic</th></tr></thead>
        <tbody>${m.sensors.map(
          (x) => html`<tr class="${x.stale ? 'muted' : ''}"><td>${x.name}</td><td>${x.role === 'wall' ? 'Wall power' : 'Extra'}</td>
            <td class="r num">${x.value === null ? '–' : `${x.unit === 'W' ? fmt.watts(x.value) : x.value} ${x.unit}`}</td>
            <td class="silk">${x.ts ? fmt.ago(x.ts) : 'no value yet'}</td><td class="mono wrap">${x.topic}${x.path ? ` → ${x.path}` : ''}</td></tr>`
        )}</tbody>
      </table>`
    );
  },

  drawImpact(s) {
    const el = $('[data-r="impact"]', this.root);
    const imp = s.impact;
    if (!imp) {
      render(el, '');
      return;
    }
    let running = '';
    if (imp.running && imp.test) {
      const t = imp.test;
      const idx = PHASES.findIndex(([p]) => p === t.phase);
      running = html`<div class="callout">
        <strong>Testing: ${t.items.length === 1 ? t.items[0] : `${t.items.length} items`}</strong>
        <div class="phases">${PHASES.map(([p, label], i) => html`<span class="${i < idx ? 'done' : i === idx ? 'now' : ''}">${label}</span>`)}</div>
        <span class="silk">${t.phaseEndsAt ? `This step ends at ${fmt.clock(t.phaseEndsAt)}.` : t.phase === 'hold' ? 'Waiting for the current measurement to finish.' : ''}
        Total about ${fmt.duration((t.settleSec * 2 + t.windowSec * 2) * 1000)}.</span>
        <div class="form-actions"><button class="btn btn-danger" type="button" data-act="cancel">Cancel test</button></div>
      </div>`;
    }
    const results = imp.results || [];
    const table = results.length
      ? html`<div class="table-wrap"><table class="data">
          <thead><tr><th scope="col">Finished</th><th scope="col">Change</th><th scope="col" class="r">Wall</th><th scope="col" class="r">Platform</th><th scope="col" class="r">Package</th>
            <th scope="col" class="r">Wall before</th><th scope="col" class="r">Window</th><th scope="col" class="r">Samples</th></tr></thead>
          <tbody>${results.map((r) => {
            const wallN = r.baseline.wall ? `${r.baseline.wall.n}+${r.after.wall ? r.after.wall.n : 0} plug` : '';
            const pkgN = r.baseline.pkg ? `${r.baseline.pkg.n}+${r.after.pkg ? r.after.pkg.n : 0} RAPL` : '';
            return html`<tr><td class="num">${fmt.dateTime(r.finishedAt)}</td>
              <td class="wrap">${r.items.length === 1 ? r.items[0] : html`${r.items.length} items<br><span class="dim">${r.items.slice(0, 3).join('; ')}${r.items.length > 3 ? ' …' : ''}</span>`}</td>
              <td class="r num">${delta(r.delta.wall)}</td><td class="r num">${delta(r.delta.psys)}</td><td class="r num">${delta(r.delta.pkg)}</td>
              <td class="r num">${r.baseline.wall ? `${fmt.watts(r.baseline.wall.mean)} W` : '–'}</td>
              <td class="r num">${fmt.duration(r.windowSec * 1000)}</td>
              <td class="r silk" style="font-size:13px">${[wallN, pkgN].filter(Boolean).join(', ') || '–'}</td></tr>`;
          })}</tbody>
        </table></div>
        <p class="silk" style="font-size:13px">Small plug readings change only in steps; few plug samples mean the wall figure is a rough estimate. RAPL deltas are precise but cover the CPU only.</p>`
      : imp.running
        ? ''
        : html`<p class="empty-state">No impact tests yet. On the Tuning page, select items and choose ${raw('<strong>Test impact</strong>')}.</p>`;
    render(el, html`${running}${table}`);
  },

  drawEvents(s) {
    const el = $('[data-r="events"]', this.root);
    if (!el) return;
    const fromHist = this.hist ? this.hist.events : [];
    const live = s ? s.events.filter((e) => !this.hist || e.t > this.hist.to) : [];
    const list = [...live, ...[...fromHist].reverse()].slice(0, 100);
    $('[data-r="events-note"]', this.root).textContent = list.length ? `tuning actions in the selected range, shown as dashed lines on the chart` : '';
    if (!list.length) {
      render(el, html`<p class="empty-state">No tuning actions in this range.</p>`);
      return;
    }
    const kinds = { tune: 'Applied', auto: 'Auto-tune', wake: 'Wake', impact: 'Impact test' };
    render(
      el,
      html`<table class="data">
        <thead><tr><th scope="col">When</th><th scope="col">Action</th><th scope="col">Details</th></tr></thead>
        <tbody>${list.map((e) => html`<tr><td class="num">${fmt.dateTime(e.t)}</td><td>${kinds[e.kind] || e.kind}</td><td class="wrap">${e.text}</td></tr>`)}</tbody>
      </table>`
    );
  },
};
