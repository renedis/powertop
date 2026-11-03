import { html, raw, render, $ } from '../lib/html.js';

export default {
  id: 'wake',
  label: 'Wake',

  mount(root, actions) {
    this.root = root;
    render(
      root,
      html`<h1>Wake sources</h1>
        <p class="silk" style="margin:-6px 0 14px;max-width:80ch">Devices allowed to wake the system from suspend. Disabling Wake-on-LAN stops remote power-on through that network card.</p>
        <div data-r="banner"></div>
        <div class="table-wrap" data-r="list"></div>`
    );
    this.onClick = async (e) => {
      const b = e.target.closest('button[data-wake]');
      if (!b || b.disabled) return;
      b.disabled = true;
      await actions.toggleWake(b.dataset.wake);
    };
    root.addEventListener('click', this.onClick);
  },

  unmount() {
    this.root.removeEventListener('click', this.onClick);
  },

  update(s, keys) {
    if (!keys.includes('*') && !keys.includes('report') && !keys.includes('status')) return;
    const enabled = Boolean(s.status && s.status.tuningEnabled);
    render(
      $('[data-r="banner"]', this.root),
      s.status && !enabled ? html`<div class="callout info"><strong>Changes are off on this host.</strong> The list is read-only.</div>` : ''
    );
    const list = s.report ? s.report.wakeup : null;
    if (!list) {
      render($('[data-r="list"]', this.root), html`<p class="empty-state">Waiting for the first measurement.</p>`);
      return;
    }
    if (!list.length) {
      render($('[data-r="list"]', this.root), html`<p class="empty-state">This host reports no wake-capable devices.</p>`);
      return;
    }
    render(
      $('[data-r="list"]', this.root),
      html`<table class="data">
        <thead><tr><th scope="col">Device</th><th scope="col">Wake</th><th scope="col">Setting</th><th scope="col"></th></tr></thead>
        <tbody>${list.map((w) => {
          const on = w.enabled === true;
          const unknown = w.enabled === null || w.enabled === undefined;
          return html`<tr>
            <td class="wrap">${w.description}</td>
            <td>${unknown ? html`<span class="tag">unknown</span>` : on ? html`<span class="tag ok">enabled</span>` : html`<span class="tag">disabled</span>`}</td>
            <td class="mono wrap">${w.write ? w.write.path : w.script}</td>
            <td class="r"><button class="btn btn-sm" type="button" data-wake="${w.id}" ${enabled && w.write ? '' : raw('disabled')}>${on ? 'Disable wake' : 'Enable wake'}</button></td>
          </tr>`;
        })}</tbody>
      </table>`
    );
  },
};
