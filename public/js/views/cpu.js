import { html, render, $ } from '../lib/html.js';
import { residencyBars, heatTable } from '../components/bars.js';

export default {
  id: 'cpu',
  label: 'CPU',

  mount(root) {
    this.root = root;
    render(root, html`<h1>CPU</h1><div data-r="body"></div>`);
  },

  unmount() {},

  update(s, keys) {
    if (!keys.includes('*') && !keys.includes('report') && !keys.includes('status')) return;
    const el = $('[data-r="body"]', this.root);
    const rep = s.report;
    if (!rep) {
      render(el, html`<p class="empty-state">Waiting for the first measurement.</p>`);
      return;
    }
    const idle = rep.cpuidle;
    const intel = idle.package.some((x) => /^C\d/.test(x.state));
    const freq = rep.cpufreq.cpus;
    const freqCols = [];
    for (const c of freq) for (const st of c.states) if (!freqCols.includes(st.state)) freqCols.push(st.state);
    render(
      el,
      html`<div class="grid-2">
          <section class="panel">
            <div class="panel-head"><h2>${intel ? 'Package idle states' : 'Idle states'}</h2>
              <span class="note">${intel ? 'deeper package states save the most power' : 'generic idle states reported by the kernel'}</span></div>
            ${residencyBars(idle.package)}
          </section>
          <section class="panel">
            <div class="panel-head"><h2>Cores</h2><span class="note">residency per physical core, %</span></div>
            ${idle.cores.length ? heatTable(idle.cores, { rowHeader: 'Core' }) : html`<p class="empty-state">No per-core data on this platform.</p>`}
          </section>
        </div>
        <section class="panel">
          <div class="panel-head"><h2>Logical CPUs</h2><span class="note">residency per CPU, %; hover a cell for the average time per entry</span></div>
          ${heatTable(idle.cpus, { rowHeader: 'CPU' })}
        </section>
        <section class="panel">
          <div class="panel-head"><h2>Frequency</h2><span class="note">from the last measurement</span></div>
          ${freq.length
            ? html`<div class="table-wrap"><table class="data">
                <thead><tr><th scope="col">CPU</th>${freqCols.map((c) => html`<th scope="col" class="r">${c}</th>`)}</tr></thead>
                <tbody>${freq.map(
                  (c) => html`<tr><td class="silk">${c.label}</td>${freqCols.map((col) => {
                    const st = c.states.find((x) => x.state === col);
                    return html`<td class="r num">${st ? st.value : ''}</td>`;
                  })}</tr>`
                )}</tbody>
              </table></div>`
            : html`<p class="empty-state">No frequency data: the kernel on this host has no cpufreq support or reports no residency.</p>`}
        </section>`
    );
  },
};
