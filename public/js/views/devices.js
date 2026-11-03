import { html, raw, render, $ } from '../lib/html.js';
import * as fmt from '../lib/fmt.js';
import { dataTable } from '../components/table.js';

const GROUPS = {
  cpu: 'CPU and memory',
  pci: 'PCI',
  usb: 'USB',
  net: 'Network',
  virtual: 'Virtual network',
  audio: 'Audio',
  platform: 'Platform',
  i2c: 'I2C',
  other: 'Other',
};

function usageCell(d) {
  if (d.usagePct !== null) {
    const w = Math.max(0, Math.min(100, d.usagePct));
    return html`<span class="meter"><span class="track"><b style="width:${w.toFixed(1)}%"></b></span><span class="num">${fmt.pct(d.usagePct)} %</span></span>`;
  }
  return html`<span class="num silk">${d.usage}</span>`;
}

export default {
  id: 'devices',
  label: 'Devices',

  mount(root) {
    this.root = root;
    this.showVirtual = false;
    render(
      root,
      html`<h1>Devices</h1>
        <p class="silk" style="margin:-6px 0 14px;max-width:80ch">Share of the measurement each device was active (not runtime-suspended). Devices at 100 % never sleep; their tunables are on the Tuning page.</p>
        <div data-r="table"></div>
        <details class="fold" data-r="activity-wrap"><summary data-r="activity-title">Process device activity</summary><div class="table-wrap" data-r="activity"></div></details>`
    );
    this.table = dataTable($('[data-r="table"]', root), {
      placeholder: 'Search devices',
      search: (r) => r.name,
      chip: { label: 'Device group', of: (r) => GROUPS[r.group] || r.group },
      sort: { key: 'usage', dir: 'desc' },
      empty: 'No devices in this report.',
      extraTools: html`<label class="switch"><input type="checkbox" data-r="virtual"><span class="knob"></span><span class="silk">Show virtual interfaces</span></label>`,
      rowClass: (r) => (r.usagePct === 0 || r.rate === 0 ? 'muted' : ''),
      columns: [
        { key: 'usage', label: 'Active', sort: (r) => (r.usagePct !== null ? r.usagePct : r.rate !== null ? -1 + r.rate / 1e6 : -2), cell: usageCell },
        { key: 'name', label: 'Device', cls: 'wrap', sort: (r) => r.name },
        { key: 'group', label: 'Group', sort: (r) => GROUPS[r.group] || r.group, cell: (r) => html`<span class="tag">${GROUPS[r.group] || r.group}</span>` },
      ],
    });
    this.onChange = (e) => {
      if (e.target.matches('[data-r="virtual"]')) {
        this.showVirtual = e.target.checked;
        this.fill(this.last);
      }
    };
    root.addEventListener('change', this.onChange);
  },

  unmount() {
    this.table.destroy();
    this.root.removeEventListener('change', this.onChange);
  },

  fill(s) {
    const all = s && s.report ? s.report.devices : [];
    this.table.setRows(this.showVirtual ? all : all.filter((d) => d.group !== 'virtual'));
  },

  update(s, keys) {
    if (!keys.includes('*') && !keys.includes('report')) return;
    this.last = s;
    this.fill(s);
    const act = s.report ? s.report.deviceActivity : [];
    $('[data-r="activity-title"]', this.root).textContent = `Process device activity (${act.length})`;
    render(
      $('[data-r="activity"]', this.root),
      act.length
        ? html`<table class="data"><thead><tr><th scope="col">Process</th><th scope="col">Device</th></tr></thead>
            <tbody>${act.map((a, i) => html`<tr><td>${i && act[i - 1].process === a.process ? raw('<span class="dim">″</span>') : a.process}</td><td class="mono">${a.device}</td></tr>`)}</tbody></table>`
        : html`<p class="empty-state">No device activity recorded.</p>`
    );
  },
};
