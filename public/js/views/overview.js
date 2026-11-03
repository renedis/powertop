import { html, render, $ } from '../lib/html.js';
import * as fmt from '../lib/fmt.js';
import { lineChart, liveColumns, CHANNELS, CHANNEL_ORDER } from '../components/chart.js';
import { residencyBars } from '../components/bars.js';

const touched = (keys, ...n) => keys.includes('*') || n.some((k) => keys.includes(k));

export function liveKeys(s) {
  const zones = (s.status && s.status.caps && s.status.caps.raplZones) || [];
  const hasWall = Boolean(s.mqtt && s.mqtt.sensors.some((x) => x.role === 'wall'));
  return CHANNEL_ORDER.filter((k) => (k === 'wall' ? hasWall : zones.includes(k)));
}

export default {
  id: 'overview',
  label: 'Overview',

  mount(root, actions) {
    this.root = root;
    this.actions = actions;
    this.chart = null;
    this.sig = null;
    render(
      root,
      html`<h1 class="visually-hidden">Overview</h1>
        <section class="panel">
          <div class="panel-head"><h2>Live power</h2><span class="note" data-r="live-note"></span></div>
          <div class="screen"><div class="chart" data-r="chart"></div></div>
        </section>
        <div class="grid-2">
          <section class="panel">
            <div class="panel-head"><h2 data-r="idle-title">Package idle states</h2><span class="note" data-r="idle-note"></span></div>
            <div data-r="idle"></div>
          </section>
          <section class="panel">
            <div class="panel-head"><h2>Top consumers</h2><span class="note">from the last measurement</span></div>
            <div class="table-wrap" data-r="top"></div>
          </section>
        </div>
        <section class="panel" data-r="tuning"></section>
        <section class="panel" data-r="fleet"></section>`
    );
    this.onClick = (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      if (b.dataset.act === 'auto' && window.confirm(`Apply ${b.dataset.n} tunables on this host now?`)) actions.autoTune();
      if (b.dataset.act === 'host') actions.switchHost(b.dataset.host);
    };
    this.onKey = (e) => {
      const row = e.target.closest('[data-act="host"]');
      if (row && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        actions.switchHost(row.dataset.host);
      }
    };
    root.addEventListener('click', this.onClick);
    root.addEventListener('keydown', this.onKey);
  },

  unmount() {
    if (this.chart) this.chart.destroy();
    this.chart = null;
    this.root.removeEventListener('click', this.onClick);
    this.root.removeEventListener('keydown', this.onKey);
  },

  update(s, keys) {
    if (touched(keys, 'live', 'status', 'mqtt')) this.drawLive(s);
    if (touched(keys, 'report', 'status')) {
      this.drawIdle(s);
      this.drawTop(s);
    }
    if (touched(keys, 'summary', 'report', 'status', 'settings')) this.drawTuning(s);
    if (touched(keys, 'hosts', 'host')) this.drawFleet(s);
  },

  drawLive(s) {
    const el = $('[data-r="chart"]', this.root);
    const note = $('[data-r="live-note"]', this.root);
    const keys = liveKeys(s);
    const sig = keys.join(',');
    if (sig !== this.sig) {
      if (this.chart) this.chart.destroy();
      this.chart = keys.length
        ? lineChart(el, { series: keys.map((k) => CHANNELS[k]), height: 240, unit: 'W', fmt: fmt.watts, xRange: () => [Date.now() / 1000 - 600, Date.now() / 1000] })
        : null;
      this.sig = sig;
    }
    if (!s.status) {
      render(el, html`<p class="chart-empty">Connecting to the host.</p>`);
      return;
    }
    if (!this.chart) {
      render(
        el,
        html`<p class="chart-empty">No live power source on this host. The kernel exposes no RAPL energy counters here.
          <a href="#/settings">Add a smart plug under Settings</a> to chart wall power.</p>`
      );
      note.textContent = '';
      return;
    }
    const { xs, cols } = liveColumns(s.live, keys);
    if (!this.chart.setData(xs, cols)) render(el, html`<p class="chart-empty">Waiting for the first samples. RAPL is read every 5 seconds.</p>`);
    note.textContent = xs.length ? `last 10 minutes, ${xs.length} samples` : '';
  },

  drawIdle(s) {
    const idle = s.report && s.report.cpuidle;
    const title = $('[data-r="idle-title"]', this.root);
    const note = $('[data-r="idle-note"]', this.root);
    const el = $('[data-r="idle"]', this.root);
    if (!idle) {
      render(el, html`<p class="empty-state">Waiting for the first measurement.</p>`);
      return;
    }
    const intel = idle.package.some((x) => /^C\d/.test(x.state));
    title.textContent = intel ? 'Package idle states' : 'Idle states';
    note.textContent = intel ? 'share of time the whole package spent in each state' : 'share of time in each state, all CPUs';
    render(el, residencyBars(idle.package.length ? idle.package : (idle.cpus[0] || { states: [] }).states));
  },

  drawTop(s) {
    const el = $('[data-r="top"]', this.root);
    const rows = s.report ? s.report.topConsumers : [];
    if (!s.report) {
      render(el, html`<p class="empty-state">Waiting for the first measurement.</p>`);
      return;
    }
    if (!rows.length) {
      render(el, html`<p class="empty-state">The report lists no consumers.</p>`);
      return;
    }
    render(
      el,
      html`<table class="data">
        <thead><tr><th scope="col" class="r">Usage</th><th scope="col" class="r">Events/s</th><th scope="col" class="hide-sm">Category</th><th scope="col">Description</th></tr></thead>
        <tbody>${rows.map(
          (r) => html`<tr><td class="r num">${r.usage}</td><td class="r num">${r.events === null ? '–' : fmt.rate(r.events)}</td>
            <td class="hide-sm"><span class="tag">${r.category}</span></td><td class="mono wrap">${r.description}</td></tr>`
        )}</tbody>
      </table>`
    );
  },

  drawTuning(s) {
    const el = $('[data-r="tuning"]', this.root);
    const k = s.summary && s.summary.kpi;
    if (!s.report || !k || k.openTunables === null) {
      render(el, '');
      return;
    }
    const excluded = s.report.tuning.bad.filter((x) => x.excluded).length;
    const enabled = s.status && s.status.tuningEnabled;
    if (!k.openTunables) {
      render(
        el,
        html`<div class="callout info"><strong>All tunables are applied.</strong>
          ${excluded ? ` ${fmt.plural(excluded, 'item')} stay excluded from auto-tune.` : ''}</div>`
      );
      return;
    }
    if (!enabled) {
      render(
        el,
        html`<div class="callout info"><strong>${fmt.plural(k.openTunables, 'tunable')} open.</strong>
          Tuning actions are switched off on this host${s.status.tuningLocked ? ' by TUNING_ENABLED=false' : ''}. <a href="#/tuning">Review the list</a>.</div>`
      );
      return;
    }
    render(
      el,
      html`<div class="callout"><strong>${fmt.plural(k.openTunables, 'tunable')} can be applied on this host.</strong>
        ${excluded ? ` Auto-tune skips the ${fmt.plural(excluded, 'excluded item')}.` : ''}
        <div class="form-actions"><a class="btn" href="#/tuning">Review tunables</a>
        <button class="btn btn-primary" type="button" data-act="auto" data-n="${k.openTunables}">Auto-tune</button></div></div>`
    );
  },

  drawFleet(s) {
    const el = $('[data-r="fleet"]', this.root);
    if (s.hosts.length < 2) {
      render(el, '');
      return;
    }
    render(
      el,
      html`<div class="panel-head"><h2>Hosts</h2><span class="note">select a row to switch</span></div>
        <div class="table-wrap"><table class="data fleet">
          <thead><tr><th scope="col">Host</th><th scope="col" class="r">Wall</th><th scope="col" class="r">Package</th><th scope="col" class="r">CPU</th>
            <th scope="col" class="r">Deep idle</th><th scope="col" class="r">Tunables</th><th scope="col">Report</th></tr></thead>
          <tbody>${s.hosts.map((h) => {
            const k = (h.summary && h.summary.kpi) || {};
            const state = h.ok === false ? (h.outdated ? 'older version' : h.error || 'offline') : h.summary ? fmt.ago(h.summary.runner.lastUpdated) : '–';
            return html`<tr class="${h.key === s.host ? 'current' : ''}" data-act="host" data-host="${h.key}" tabindex="0">
              <td>${h.name}</td>
              <td class="r num">${k.wallW === null || k.wallW === undefined ? '–' : `${fmt.watts(k.wallW)} W`}</td>
              <td class="r num">${k.pkgW === null || k.pkgW === undefined ? '–' : `${fmt.watts(k.pkgW)} W`}</td>
              <td class="r num">${k.cpuPct === null || k.cpuPct === undefined ? '–' : `${fmt.pct(k.cpuPct)} %`}</td>
              <td class="r num">${k.deep ? `${fmt.pct(k.deep.pct)} %` : '–'}</td>
              <td class="r num">${k.openTunables === null || k.openTunables === undefined ? '–' : k.openTunables}</td>
              <td class="${h.ok === false ? 'dim' : 'silk'}">${state}</td>
            </tr>`;
          })}</tbody>
        </table></div>`
    );
  },
};
