import { html, render, $ } from '../lib/html.js';
import * as fmt from '../lib/fmt.js';
import { dataTable } from '../components/table.js';

export default {
  id: 'software',
  label: 'Software',

  mount(root) {
    this.root = root;
    render(root, html`<h1>Software</h1><div data-r="note"></div><div data-r="table"></div>`);
    this.table = dataTable($('[data-r="table"]', root), {
      placeholder: 'Search processes, timers, interrupts',
      search: (r) => `${r.description} ${r.category}`,
      chip: { label: 'Category', of: (r) => r.category },
      sort: { key: 'usage', dir: 'desc' },
      empty: 'No software activity in this report.',
      columns: [
        { key: 'usage', label: 'CPU time', align: 'r', cls: 'num', sort: (r) => r.usageUs, cell: (r) => fmt.us(r.usageUs) },
        { key: 'wakeups', label: 'Wakeups/s', align: 'r', cls: 'num', sort: (r) => r.wakeups, cell: (r) => fmt.rate(r.wakeups) },
        { key: 'diskIo', label: 'Disk IO/s', align: 'r', cls: 'num', sort: (r) => r.diskIo, cell: (r) => (r.diskIo === null ? '' : fmt.rate(r.diskIo)) },
        { key: 'category', label: 'Category', sort: (r) => r.category, cell: (r) => html`<span class="tag">${r.category}</span>` },
        { key: 'description', label: 'Description', cls: 'mono', sort: (r) => r.description, cell: (r) => html`<span class="clamp" title="${r.description}">${r.description}</span>` },
      ],
    });
  },

  unmount() {
    this.table.destroy();
  },

  update(s, keys) {
    if (!keys.includes('*') && !keys.includes('report') && !keys.includes('status')) return;
    const note = $('[data-r="note"]', this.root);
    const caps = s.status && s.status.caps;
    if (caps && s.report && !caps.perf) {
      render(
        note,
        html`<div class="callout info"><strong>No software data on this host.</strong> Its kernel is built without perf events and tracepoints
          (CONFIG_PERF_EVENTS), so powertop cannot attribute wakeups to processes. Idle states, devices and tunables still work.
          ${caps.udm ? html`The <a href="#/udm">UDM page</a> lists CPU per process, service and container from /proc instead.` : ''}</div>`
      );
    } else render(note, '');
    this.table.setRows(s.report ? s.report.software : []);
  },
};
