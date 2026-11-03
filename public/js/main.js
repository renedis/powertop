import { html, raw, render, $ } from './lib/html.js';
import * as fmt from './lib/fmt.js';
import { api, localApi, useHost, connectEvents } from './api.js';
import { createStore, appendLive } from './store.js';
import { spark } from './components/spark.js';
import overview from './views/overview.js';
import power from './views/power.js';
import cpu from './views/cpu.js';
import software from './views/software.js';
import devices from './views/devices.js';
import tuning from './views/tuning.js';
import wake from './views/wake.js';
import settings from './views/settings.js';

const VIEWS = [overview, power, cpu, software, devices, tuning, wake, settings];
const MODES = [
  { id: 'adaptive', label: 'Adaptive', hint: 'Every minute while this page is open, every 15 minutes otherwise' },
  { id: 'continuous', label: 'Continuous', hint: 'Every minute, always' },
  { id: 'ondemand', label: 'On demand', hint: 'Only while this page is open' },
  { id: 'paused', label: 'Paused', hint: 'Only when you press Measure now' },
];

const EMPTY = { status: null, report: null, summary: null, live: { rapl: [], wall: [] }, mqtt: null, settings: null, impact: null, events: [], conn: 'connecting' };
const store = createStore({ hosts: [], host: 'local', ...EMPTY });
let es = null;
let current = null;

// ---------- small helpers ----------
export function toast(text, kind = 'ok', ms = 4500) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), ms);
}

const hostOf = (s = store.get()) => s.hosts.find((h) => h.key === s.host) || { key: 'local', name: 'This host' };

async function guard(fn, okText) {
  try {
    const out = await fn();
    if (okText) toast(typeof okText === 'function' ? okText(out) : okText);
    return out;
  } catch (e) {
    toast(e.message, 'fault', 7000);
    return null;
  }
}

// ---------- data loading ----------
async function loadHosts() {
  try {
    const { self, peers } = await localApi('peers');
    const hosts = [
      { key: 'local', name: self.host, ok: true, summary: self },
      ...peers.map((p) => ({
        key: `p${p.idx}`,
        idx: p.idx,
        name: (p.summary && p.summary.host) || p.name,
        label: p.name,
        url: p.url,
        ok: p.ok,
        outdated: Boolean(p.outdated),
        error: p.error || null,
        summary: p.summary || null,
      })),
    ];
    store.set({ hosts });
  } catch {
    if (!store.get().hosts.length) store.set({ hosts: [{ key: 'local', name: 'This host', ok: true }] });
  }
}

async function loadReport() {
  const [data, summary] = await Promise.all([api('data').catch(() => null), api('summary').catch(() => null)]);
  store.set({ report: data && data.available ? data.data : null, summary });
}

async function loadAll() {
  const get = (p) => api(p).catch(() => null);
  const [status, live, sets, mqtt, impact] = await Promise.all([get('status'), get('power/live'), get('settings'), get('mqtt/status'), get('impact')]);
  store.set({
    status,
    live: { rapl: (live && live.rapl) || [], wall: ((live && live.wall) || []).map((p) => ({ t: p.t, v: p.v })) },
    settings: sets,
    mqtt,
    impact,
  });
  await loadReport();
}

async function switchHost(key) {
  const host = store.get().hosts.find((h) => h.key === key) || store.get().hosts[0];
  if (!host) return;
  try {
    localStorage.setItem('pt.host', host.key);
  } catch {
    /* storage unavailable */
  }
  useHost(host);
  if (es) es.close();
  store.set({ host: host.key, ...EMPTY });
  await loadAll();
  es = connectEvents(
    {
      hello: (status) => store.set({ status }),
      runner: (runner) => {
        const st = store.get().status;
        if (st) store.set({ status: { ...st, runner, lastUpdated: runner.lastUpdated ? new Date(runner.lastUpdated).toISOString() : st.lastUpdated } });
      },
      report: () => loadReport(),
      power: (s) => store.set({ live: { ...store.get().live, rapl: appendLive(store.get().live.rapl, s) } }),
      sensor: (e) => {
        const s = store.get();
        const patch = {};
        if (e.role === 'wall') patch.live = { ...s.live, wall: appendLive(s.live.wall, { t: e.ts, v: e.value }) };
        if (s.mqtt) patch.mqtt = { ...s.mqtt, sensors: s.mqtt.sensors.map((x) => (x.id === e.id ? { ...x, value: e.value, ts: e.ts, stale: false } : x)) };
        store.set(patch);
      },
      mqtt: (mqtt) => store.set({ mqtt }),
      impact: async (imp) => {
        store.set({ impact: { ...(store.get().impact || {}), ...imp } });
        const phase = imp.test && imp.test.phase;
        if (['done', 'error', 'cancelled'].includes(phase)) {
          const full = await api('impact').catch(() => null);
          if (full) store.set({ impact: full });
          if (phase === 'done') toast('Impact test finished. Results are on the Power page.');
          if (phase === 'error') toast(`Impact test failed: ${imp.test.error}`, 'fault', 8000);
        }
      },
      event: (e) => store.set({ events: [e, ...store.get().events].slice(0, 100) }),
      settings: async (sets) => {
        store.set({ settings: sets });
        const summary = await api('summary').catch(() => null);
        const data = await api('data').catch(() => null);
        store.set({ summary, report: data && data.available ? data.data : store.get().report });
      },
    },
    (conn) => store.set({ conn })
  );
}

// ---------- actions for views ----------
const actions = {
  toast,
  api,
  switchHost: (key) => switchHost(key),
  async measure() {
    const r = await guard(() => api('measure', { method: 'POST' }));
    if (r && !r.ok) toast(r.reason === 'held' ? 'Measurements are on hold right now.' : 'A measurement is already running.', 'info');
  },
  async setMode(mode) {
    const sets = await guard(() => api('settings', { method: 'PUT', body: { run: { mode } } }));
    if (sets) store.set({ settings: sets });
  },
  async apply(ids) {
    const out = await guard(() => api('tuning/apply', { method: 'POST', body: { ids } }));
    if (!out) return null;
    const ok = out.results.filter((r) => r.ok).length;
    const failed = out.results.filter((r) => !r.ok);
    toast(`Applied ${ok} of ${out.results.length}. A new measurement starts in a moment.`, failed.length ? 'info' : 'ok');
    failed.slice(0, 3).forEach((f) => toast(`${f.description || f.id}: ${f.error}`, 'fault', 8000));
    await loadReport();
    return out;
  },
  async autoTune() {
    const out = await guard(() => api('tuning/auto', { method: 'POST' }));
    if (out) {
      toast(`Auto-tune applied ${out.applied}${out.skipped ? `, skipped ${out.skipped} excluded` : ''}${out.failed ? `, ${out.failed} failed` : ''}.`, out.failed ? 'info' : 'ok');
      await loadReport();
    }
    return out;
  },
  async exclude(key, exclude) {
    const out = await guard(() => api('tuning/exclude', { method: 'POST', body: { key, exclude } }));
    if (out) await loadReport();
    return out;
  },
  async toggleWake(id) {
    const out = await guard(() => api(`wake/${encodeURIComponent(id)}/toggle`, { method: 'POST' }));
    if (out) {
      toast(out.enabled ? 'Wake enabled.' : 'Wake disabled.');
      await loadReport();
    }
    return out;
  },
  async startImpact(ids) {
    const out = await guard(() => api('impact', { method: 'POST', body: { ids } }));
    if (out) {
      store.set({ impact: out });
      toast('Impact test started. Measurements are held until it finishes.', 'info');
    }
    return out;
  },
  async cancelImpact() {
    const out = await guard(() => api('impact', { method: 'DELETE' }), 'Impact test cancelled.');
    if (out) store.set({ impact: out });
  },
  async saveSettings(patch, okText = 'Saved.') {
    const out = await api('settings', { method: 'PUT', body: patch });
    store.set({ settings: out });
    toast(okText);
    if ('peers' in patch) loadHosts();
    return out;
  },
  reloadHosts: () => loadHosts(),
  loadReport,
};

// ---------- shell rendering ----------
function renderHostSelect(s) {
  const sel = $('#host-select');
  render(
    sel,
    html`${s.hosts.map((h) => {
      const note = h.key === 'local' ? '' : h.outdated ? ' (old version)' : h.ok ? '' : ' (offline)';
      return html`<option value="${h.key}" ${h.ok === false ? raw('disabled') : ''}>${h.name}${note}</option>`;
    })}`
  );
  sel.value = s.host;
}

function renderFacts(s) {
  const h = s.status && s.status.host;
  if (!h) return render($('#facts'), '');
  const kernel = (h.kernel || '').split(' ')[0];
  const items = [
    ['CPU', h.cpu || (h.cpuCount ? `${h.cpuCount} cores` : null)],
    ['OS', h.os],
    ['Kernel', kernel],
  ].filter(([, v]) => v);
  render($('#facts'), html`${items.map(([k, v]) => html`<div><dt>${k}</dt><dd>${v}</dd></div>`)}`);
}

function renderAcq(s) {
  const st = s.status;
  const r = st && st.runner;
  if (!r) {
    render($('#acq'), html`<span class="led"></span><span class="acq-text silk">${s.conn === 'offline' ? 'Host unreachable' : 'Connecting'}</span>`);
    return;
  }
  if (r.state === 'measuring' && r.measureStartedAt) {
    const sec = Math.max(0, Math.min(r.measureSec, (Date.now() - r.measureStartedAt) / 1000));
    render(
      $('#acq'),
      html`<span class="led measuring"></span><span class="acq-text">Measuring <span class="num">${Math.floor(sec)}/${r.measureSec}</span> s</span>
        <span class="acq-meter" aria-hidden="true"><i style="width:${((sec / r.measureSec) * 100).toFixed(0)}%"></i></span>`
    );
    return;
  }
  if (r.held) {
    render($('#acq'), html`<span class="led held"></span><span class="acq-text">${r.holdReason === 'impact' ? 'Held for impact test' : 'Applying changes'}</span>`);
    return;
  }
  const failed = r.lastRun && !r.lastRun.ok;
  const next =
    r.nextRunAt && r.nextRunAt > Date.now()
      ? html`Next run in <span class="num">${fmt.countdown(r.nextRunAt - Date.now())}</span>`
      : r.mode === 'paused'
        ? 'Paused'
        : r.mode === 'ondemand'
          ? 'Waiting for viewers'
          : 'Starting';
  render(
    $('#acq'),
    html`<span class="led ${failed ? 'fault' : r.mode === 'paused' ? '' : 'idle'}" title="${failed ? `Last run failed: ${r.lastRun.error}` : ''}"></span>
      <span class="acq-text">${next}</span>
      <span class="acq-text dim">${failed ? 'last run failed' : `report ${fmt.ago(r.lastUpdated)}`}</span>`
  );
}

function renderControls(s) {
  const r = s.status && s.status.runner;
  const mode = (s.settings && s.settings.run.mode) || (r && r.mode);
  render(
    $('#mode'),
    html`${MODES.map(
      (m) => html`<button type="button" role="radio" aria-checked="${m.id === mode}" data-mode="${m.id}" title="${m.hint}">${m.label}</button>`
    )}`
  );
  $('#measure').disabled = !r || r.state === 'measuring' || r.held;
}

function readout({ label, value, unit, ch, sub, sparkValues, empty, flag }) {
  return html`<div class="readout ${empty ? 'empty' : ''}" style="${ch ? `--ch:${ch}` : ''}">
    <div class="label"><span>${label}</span>${flag ? html`<span class="flag">${flag}</span>` : ''}</div>
    <div class="value">${value}${unit ? html`<span class="unit">${unit}</span>` : ''}</div>
    ${sparkValues ? spark(sparkValues, ch) : ''}
    ${sub ? html`<div class="sub" title="${sub}">${sub}</div>` : ''}
  </div>`;
}

const meanLast = (arr, key, n = 3) => {
  const v = arr.slice(-n).map((s) => s[key]).filter((x) => typeof x === 'number');
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};

function renderReadouts(s) {
  const caps = (s.status && s.status.caps) || {};
  const k = (s.summary && s.summary.kpi) || {};
  const tiles = [];
  const wallSensor = s.mqtt && s.mqtt.sensors.find((x) => x.role === 'wall');
  const wallPts = s.live.wall;
  const lastWall = wallPts.length ? wallPts[wallPts.length - 1] : null;
  const wallNow = lastWall && Date.now() - lastWall.t < 600000 ? lastWall.v : k.wallW;
  if (wallSensor) {
    tiles.push(
      readout({
        label: 'Wall',
        value: fmt.watts(wallNow),
        unit: 'W',
        ch: 'var(--ch-wall)',
        sparkValues: wallPts.map((p) => p.v),
        sub: wallSensor.name,
        empty: wallNow === null || wallNow === undefined,
      })
    );
  } else {
    tiles.push(readout({ label: 'Wall', value: '–', ch: 'var(--ch-wall)', sub: 'Add a plug in Settings', empty: true }));
  }
  const rapl = s.live.rapl;
  if (caps.rapl && (caps.raplZones || []).includes('psys')) {
    tiles.push(readout({ label: 'Platform', value: fmt.watts(meanLast(rapl, 'psys') ?? k.psysW), unit: 'W', ch: 'var(--ch-psys)', sparkValues: rapl.map((x) => x.psys), sub: 'RAPL psys' }));
  }
  if (caps.rapl) {
    tiles.push(readout({ label: 'Package', value: fmt.watts(meanLast(rapl, 'pkg') ?? k.pkgW), unit: 'W', ch: 'var(--ch-pkg)', sparkValues: rapl.map((x) => x.pkg), sub: 'RAPL package-0' }));
  }
  if (k.cpuPct !== null && k.cpuPct !== undefined) tiles.push(readout({ label: 'CPU', value: fmt.pct(k.cpuPct), unit: '%', sub: 'busy during last measurement' }));
  if (k.wakeups !== null && k.wakeups !== undefined) tiles.push(readout({ label: 'Wakeups', value: fmt.rate(k.wakeups), unit: '/s', sub: 'timer and interrupt wakeups' }));
  if (k.deep) tiles.push(readout({ label: k.deep.label === 'PC6+' ? 'Package C6 and deeper' : `Idle in ${k.deep.label}`, value: fmt.pct(k.deep.pct), unit: '%', sub: 'residency, last measurement' }));
  if (k.openTunables !== null && k.openTunables !== undefined) {
    const excluded = s.report ? s.report.tuning.bad.filter((x) => x.excluded).length : 0;
    tiles.push(
      readout({
        label: 'Tunables',
        value: String(k.openTunables),
        flag: k.openTunables ? 'open' : '',
        sub: k.openTunables ? `can be applied${excluded ? `, ${excluded} excluded` : ''}` : excluded ? `${excluded} excluded` : 'all applied',
      })
    );
  }
  render($('#readouts'), html`${tiles}`);
}

function renderNav(s) {
  const rep = s.report;
  const counts = {
    software: rep ? rep.software.length : null,
    devices: rep ? rep.devices.filter((d) => d.group !== 'virtual').length : null,
    tuning: s.summary && s.summary.kpi ? s.summary.kpi.openTunables : null,
    wake: rep ? rep.wakeup.length : null,
  };
  const id = current ? current.view.id : 'overview';
  render(
    $('#nav'),
    html`${VIEWS.map((v) => {
      const n = counts[v.id];
      const attn = v.id === 'tuning' && n > 0;
      return html`<a href="#/${v.id}" ${v.id === id ? raw('aria-current="page"') : ''}>${v.label}${n === null || n === undefined ? '' : html`<span class="count ${attn ? 'attn' : ''}">${n}</span>`}</a>`;
    })}`
  );
}

// ---------- router ----------
function route() {
  const id = (/^#\/([a-z]+)/.exec(location.hash) || [])[1] || 'overview';
  const view = VIEWS.find((v) => v.id === id) || VIEWS[0];
  if (current && current.view === view) return;
  if (current && current.view.unmount) current.view.unmount();
  const root = $('#view');
  root.innerHTML = '';
  current = { view };
  view.mount(root, actions, store);
  view.update(store.get(), ['*']);
  renderNav(store.get());
  document.title = `${view.label} · ${hostOf().name || 'PowerTop'}`;
}

const touched = (keys, ...names) => keys.includes('*') || names.some((n) => keys.includes(n));

store.subscribe((s, keys) => {
  if (touched(keys, 'hosts', 'host')) renderHostSelect(s);
  if (touched(keys, 'status', 'conn')) {
    renderFacts(s);
    renderAcq(s);
  }
  if (touched(keys, 'status', 'settings')) renderControls(s);
  if (touched(keys, 'status', 'summary', 'live', 'mqtt', 'report')) renderReadouts(s);
  if (touched(keys, 'report', 'summary')) renderNav(s);
  if (touched(keys, 'host', 'hosts')) document.title = `${current ? current.view.label : 'Overview'} · ${hostOf(s).name || 'PowerTop'}`;
  if (current) current.view.update(s, keys);
});

// ---------- wiring ----------
$('#host-select').addEventListener('change', (e) => switchHost(e.target.value));
$('#mode').addEventListener('click', (e) => {
  const b = e.target.closest('[data-mode]');
  if (b) actions.setMode(b.dataset.mode);
});
$('#measure').addEventListener('click', () => actions.measure());
window.addEventListener('hashchange', route);
setInterval(() => renderAcq(store.get()), 1000);
setInterval(loadHosts, 60000);

(async function boot() {
  await loadHosts();
  let saved = 'local';
  try {
    saved = localStorage.getItem('pt.host') || 'local';
  } catch {
    /* ignore */
  }
  const hosts = store.get().hosts;
  const pick = hosts.find((h) => h.key === saved && h.ok) ? saved : 'local';
  route();
  await switchHost(pick);
})();

