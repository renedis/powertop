import { html, raw, render, $, $$ } from '../lib/html.js';
import * as fmt from '../lib/fmt.js';

const exclusionKey = (item) => (item.write ? item.write.path : item.description);

export default {
  id: 'tuning',
  label: 'Tuning',

  mount(root, actions) {
    this.root = root;
    this.actions = actions;
    this.sel = new Set();
    this.busy = false;
    render(
      root,
      html`<h1>Tuning</h1>
        <div data-r="banner"></div>
        <section class="panel">
          <div class="panel-head"><h2>Can be applied</h2><span class="note" data-r="open-note"></span></div>
          <div class="table-tools" data-r="tools"></div>
          <div class="table-wrap" data-r="open"></div>
        </section>
        <details class="fold"><summary data-r="good-title">Applied</summary><div data-r="good"></div></details>
        <details class="fold"><summary data-r="untunable-title">Cannot be tuned</summary><div data-r="untunable"></div></details>`
    );
    this.onClick = async (e) => {
      const b = e.target.closest('button[data-act]');
      if (!b || b.disabled || this.busy) return;
      const act = b.dataset.act;
      const s = this.last;
      const open = s && s.report ? s.report.tuning.bad : [];
      this.busy = true;
      try {
        if (act === 'apply-one') await actions.apply([b.dataset.id]);
        if (act === 'apply-sel') await actions.apply([...this.sel]);
        if (act === 'impact') {
          await actions.startImpact([...this.sel]);
          location.hash = '#/power';
        }
        if (act === 'auto') {
          const n = open.filter((x) => !x.excluded && x.write).length;
          if (window.confirm(`Apply ${fmt.plural(n, 'tunable')} now? Excluded items are skipped.`)) await actions.autoTune();
        }
        if (act === 'clear') {
          this.sel.clear();
          this.draw(this.last);
        }
      } finally {
        this.busy = false;
      }
    };
    this.onChange = async (e) => {
      const t = e.target;
      if (t.matches('[data-sel]')) {
        if (t.checked) this.sel.add(t.dataset.sel);
        else this.sel.delete(t.dataset.sel);
        this.drawTools(this.last);
      }
      if (t.matches('[data-sel-all]')) {
        const ids = $$('[data-sel]', this.root).map((x) => x.dataset.sel);
        if (t.checked) ids.forEach((id) => this.sel.add(id));
        else this.sel.clear();
        this.draw(this.last);
      }
      if (t.matches('[data-exclude]')) {
        t.disabled = true;
        await actions.exclude(t.dataset.exclude, t.checked);
      }
    };
    root.addEventListener('click', this.onClick);
    root.addEventListener('change', this.onChange);
  },

  unmount() {
    this.root.removeEventListener('click', this.onClick);
    this.root.removeEventListener('change', this.onChange);
  },

  update(s, keys) {
    if (!keys.includes('*') && !['report', 'status', 'impact', 'summary', 'settings'].some((k) => keys.includes(k))) return;
    this.last = s;
    this.draw(s);
  },

  enabled(s) {
    return Boolean(s && s.status && s.status.tuningEnabled);
  },

  drawTools(s) {
    const open = s && s.report ? s.report.tuning.bad : [];
    const enabled = this.enabled(s);
    const autoN = open.filter((x) => !x.excluded && x.write).length;
    const n = this.sel.size;
    const impactRunning = Boolean(s && s.impact && s.impact.running);
    render(
      $('[data-r="tools"]', this.root),
      html`<button class="btn btn-primary" type="button" data-act="auto" ${!enabled || !autoN ? raw('disabled') : ''}>Auto-tune ${autoN ? `(${autoN})` : ''}</button>
        <button class="btn" type="button" data-act="apply-sel" ${!enabled || !n ? raw('disabled') : ''}>Apply selected${n ? ` (${n})` : ''}</button>
        <button class="btn" type="button" data-act="impact" ${!enabled || !n || impactRunning ? raw('disabled') : ''}
          title="${impactRunning ? 'An impact test is already running' : 'Measure power before and after applying the selection'}">Test impact${n ? ` (${n})` : ''}</button>
        ${n ? html`<button class="btn btn-quiet" type="button" data-act="clear">Clear selection</button>` : ''}
        <span class="count">${impactRunning ? 'impact test running' : ''}</span>`
    );
  },

  draw(s) {
    const rep = s && s.report;
    const enabled = this.enabled(s);
    const banner = $('[data-r="banner"]', this.root);
    if (s && s.status && !enabled) {
      render(
        banner,
        html`<div class="callout info"><strong>Tuning actions are off on this host.</strong>
          ${s.status.tuningLocked ? 'They are locked by the TUNING_ENABLED=false environment variable.' : 'Switch them on under Settings.'}
          The list below is read-only.</div>`
      );
    } else render(banner, '');
    if (!rep) {
      render($('[data-r="open"]', this.root), html`<p class="empty-state">Waiting for the first measurement.</p>`);
      return;
    }
    const open = rep.tuning.bad;
    const ids = new Set(open.map((x) => x.id));
    for (const id of [...this.sel]) if (!ids.has(id)) this.sel.delete(id);
    const excluded = open.filter((x) => x.excluded).length;
    $('[data-r="open-note"]', this.root).textContent = open.length
      ? `${fmt.plural(open.length, 'item')}${excluded ? `, ${excluded} excluded from auto-tune` : ''}`
      : '';
    this.drawTools(s);
    render(
      $('[data-r="open"]', this.root),
      open.length
        ? html`<table class="data">
            <thead><tr>
              <th scope="col" style="width:28px"><input type="checkbox" data-sel-all aria-label="Select all" ${enabled ? '' : raw('disabled')} ${this.sel.size && this.sel.size === open.length ? raw('checked') : ''}></th>
              <th scope="col">Setting</th><th scope="col">Writes</th><th scope="col">Excluded</th><th scope="col"></th></tr></thead>
            <tbody>${open.map(
              (x) => html`<tr class="${x.excluded ? 'muted' : ''}">
                <td><input type="checkbox" data-sel="${x.id}" aria-label="Select ${x.description}" ${this.sel.has(x.id) ? raw('checked') : ''} ${enabled && x.write ? '' : raw('disabled')}></td>
                <td class="wrap">${x.description}</td>
                <td class="mono wrap">${x.write ? html`${x.write.value} <span class="dim">→</span> ${x.write.path}` : html`<span class="dim">${x.script}</span>`}</td>
                <td><label class="switch" title="Excluded items are skipped by auto-tune">
                  <input type="checkbox" data-exclude="${exclusionKey(x)}" ${x.excluded ? raw('checked') : ''} ${enabled ? '' : raw('disabled')} aria-label="Exclude ${x.description} from auto-tune">
                  <span class="knob"></span></label></td>
                <td class="r"><button class="btn btn-sm" type="button" data-act="apply-one" data-id="${x.id}" ${enabled && x.write ? '' : raw('disabled')}
                  title="${x.write ? 'Write this value now' : 'This script form cannot be applied from here'}">Apply</button></td>
              </tr>`
            )}</tbody>
          </table>`
        : html`<p class="empty-state">Nothing to tune. Every setting powertop checks is already at its power-saving value.</p>`
    );
    $('[data-r="good-title"]', this.root).textContent = `Applied (${rep.tuning.good.length})`;
    $('[data-r="untunable-title"]', this.root).textContent = `Cannot be tuned (${rep.tuning.untunable.length})`;
    const list = (items) =>
      items.length
        ? html`<table class="data"><tbody>${items.map((x) => html`<tr><td class="wrap">${x.description}</td></tr>`)}</tbody></table>`
        : html`<p class="empty-state">None.</p>`;
    render($('[data-r="good"]', this.root), list(rep.tuning.good));
    render($('[data-r="untunable"]', this.root), list(rep.tuning.untunable));
  },
};
