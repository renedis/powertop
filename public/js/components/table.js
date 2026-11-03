// Sortable, searchable table with optional category chips. The tools row is
// rendered once so the search input keeps focus while the body re-renders.
import { html, render, $ } from '../lib/html.js';

/**
 * columns: [{ key, label, align: 'r', sort: row => value, cell: row => html|string, cls }]
 * search: row => string; chip: { label, of: row => string };
 * extraTools: html inserted after the chips (views wire their own handlers).
 */
export function dataTable(root, { columns, search, chip, sort = null, empty = 'Nothing to show.', rowClass = null, extraTools = '', placeholder = 'Search' }) {
  const st = { q: '', chip: null, sort };
  let rows = [];
  render(
    root,
    html`<div class="table-tools">
        ${search ? html`<input type="search" placeholder="${placeholder}" aria-label="${placeholder}" data-r="q">` : ''}
        ${chip ? html`<div class="chips" role="group" aria-label="${chip.label}" data-r="chips"></div>` : ''}
        ${extraTools}
        <span class="count" data-r="count"></span>
      </div>
      <div class="table-wrap" data-r="body"></div>`
  );
  const body = $('[data-r="body"]', root);
  const chipsEl = $('[data-r="chips"]', root);

  function draw() {
    let list = rows;
    if (st.chip && chip) list = list.filter((r) => chip.of(r) === st.chip);
    if (st.q && search) {
      const q = st.q.toLowerCase();
      list = list.filter((r) => search(r).toLowerCase().includes(q));
    }
    if (st.sort) {
      const col = columns.find((c) => c.key === st.sort.key);
      if (col && col.sort) {
        const dir = st.sort.dir === 'asc' ? 1 : -1;
        list = [...list].sort((a, b) => {
          const x = col.sort(a);
          const y = col.sort(b);
          if (x === y) return 0;
          if (x === null || x === undefined) return 1;
          if (y === null || y === undefined) return -1;
          return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * dir;
        });
      }
    }
    $('[data-r="count"]', root).textContent = list.length === rows.length ? `${rows.length}` : `${list.length} of ${rows.length}`;
    if (!list.length) {
      render(body, html`<p class="empty-state">${rows.length ? 'No rows match the filter.' : empty}</p>`);
      return;
    }
    render(
      body,
      html`<table class="data">
        <thead><tr>${columns.map((c) => {
          const sorted = st.sort && st.sort.key === c.key ? (st.sort.dir === 'asc' ? 'ascending' : 'descending') : null;
          return html`<th scope="col" class="${[c.align || '', c.sort ? 'sortable' : ''].join(' ')}" data-sort="${c.sort ? c.key : ''}" aria-sort="${sorted || 'none'}">${c.label}</th>`;
        })}</tr></thead>
        <tbody>${list.map(
          (r) => html`<tr class="${rowClass ? rowClass(r) : ''}">${columns.map(
            (c) => html`<td class="${[c.align || '', c.cls || ''].join(' ')}">${c.cell ? c.cell(r) : r[c.key]}</td>`
          )}</tr>`
        )}</tbody>
      </table>`
    );
  }

  function drawChips() {
    if (!chipsEl) return;
    const counts = new Map();
    for (const r of rows) counts.set(chip.of(r), (counts.get(chip.of(r)) || 0) + 1);
    if (st.chip && !counts.has(st.chip)) st.chip = null;
    render(
      chipsEl,
      html`${[...counts.entries()].map(
        ([k, n]) => html`<button type="button" class="chip" data-chip="${k}" aria-pressed="${st.chip === k}">${k || 'Other'}<span class="n">${n}</span></button>`
      )}`
    );
  }

  const onInput = (e) => {
    if (e.target.matches('[data-r="q"]')) {
      st.q = e.target.value.trim();
      draw();
    }
  };
  const onClick = (e) => {
    const c = e.target.closest('[data-chip]');
    if (c && root.contains(c)) {
      st.chip = st.chip === c.dataset.chip ? null : c.dataset.chip;
      drawChips();
      draw();
      return;
    }
    const th = e.target.closest('th[data-sort]');
    if (th && th.dataset.sort && root.contains(th)) {
      const key = th.dataset.sort;
      st.sort = st.sort && st.sort.key === key ? { key, dir: st.sort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' };
      draw();
    }
  };
  root.addEventListener('input', onInput);
  root.addEventListener('click', onClick);

  return {
    setRows(next) {
      rows = next || [];
      drawChips();
      draw();
    },
    destroy() {
      root.removeEventListener('input', onInput);
      root.removeEventListener('click', onClick);
    },
  };
}
