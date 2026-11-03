// Residency bars, per-CPU heat tables and the watts breakdown.
import { html } from '../lib/html.js';
import { pct, watts } from '../lib/fmt.js';

const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v || 0));

export function residencyBars(states, color = 'var(--ch-pkg)') {
  if (!states || !states.length) return html`<p class="empty-state">No idle-state data in this report.</p>`;
  return html`<div class="bars">${states.map(
    (s) => html`<div class="name">${s.state}</div>
      <div class="track" role="img" aria-label="${s.state}: ${pct(s.pct)} %"><div class="fill" style="width:${clamp(s.pct).toFixed(1)}%;--fill:${color}"></div></div>
      <div class="val">${pct(s.pct)} %</div>`
  )}</div>`;
}

/** rows: [{ label, states: [{ state, pct, avgMs? }] }] → one row per CPU/core, one column per state. */
export function heatTable(rows, { rowHeader = 'CPU' } = {}) {
  if (!rows || !rows.length) return html`<p class="empty-state">No data in this report.</p>`;
  const seen = [];
  for (const r of rows) for (const s of r.states) if (!seen.includes(s.state)) seen.push(s.state);
  // C0 active, POLL, then C-states by depth (C1 < C1E < C3 ...); other names keep their order
  const depth = (name, i) => {
    if (/^C0\b/.test(name)) return -2;
    if (/^POLL$/i.test(name)) return -1;
    const m = /^C(\d+)(\S*)/.exec(name);
    return m ? Number(m[1]) + (m[2] ? 0.5 : 0) : 1000 + i;
  };
  const cols = seen.map((name, i) => ({ name, d: depth(name, i) })).sort((a, b) => a.d - b.d).map((x) => x.name);
  return html`<div class="table-wrap"><table class="data heat">
    <thead><tr><th scope="col">${rowHeader}</th>${cols.map((c) => html`<th scope="col" class="r">${c}</th>`)}</tr></thead>
    <tbody>${rows.map(
      (r) => html`<tr><th scope="row" class="silk" style="font-weight:500;text-align:left;padding:5px 10px">${r.label}</th>${cols.map((c) => {
        const s = r.states.find((x) => x.state === c);
        if (!s) return html`<td class="cell"></td>`;
        const a = s.pct ? Math.max(0.06, Math.min(0.85, s.pct / 100)) : 0;
        const title = s.avgMs === null || s.avgMs === undefined ? `${c}: ${pct(s.pct)} %` : `${c}: ${pct(s.pct)} %, average ${s.avgMs} ms per entry`;
        return html`<td class="cell" style="--a:${a.toFixed(2)}" title="${title}"><span>${pct(s.pct)}</span></td>`;
      })}</tr>`
    )}</tbody>
  </table></div>`;
}

/** rows: [{ name, value (W), color }] scaled to the largest value. */
export function breakdown(rows) {
  const vals = rows.map((r) => r.value).filter((v) => typeof v === 'number');
  if (!vals.length) return html`<p class="empty-state">No live power readings yet.</p>`;
  const max = Math.max(...vals, 0.001);
  return html`<div class="breakdown">${rows.map(
    (r) => html`<div class="name"><i style="--c:${r.color}"></i>${r.name}</div>
      <div class="track" role="img" aria-label="${r.name}: ${watts(r.value)} W"><div class="fill" style="--c:${r.color};width:${clamp(((r.value || 0) / max) * 100).toFixed(1)}%"></div></div>
      <div class="val">${watts(r.value)} W</div>`
  )}</div>`;
}
