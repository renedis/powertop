import { html, raw, render, $ } from '../lib/html.js';
import * as fmt from '../lib/fmt.js';

const MODES = [
  ['adaptive', 'Adaptive', 'every minute while this page is open, at the idle interval otherwise'],
  ['continuous', 'Continuous', 'every minute, always'],
  ['ondemand', 'On demand', 'only while this page is open'],
  ['paused', 'Paused', 'only when you press Measure now'],
];
const FORMS = ['run', 'tuning', 'mqtt', 'sensors', 'peers', 'retention'];
const checked = (b) => (b ? raw('checked') : '');
const disabled = (b) => (b ? raw('disabled') : '');
const sensorOut = ({ id, name, topic, path, unit, role }) => ({ id, name, topic, path, unit, role });

export default {
  id: 'settings',
  label: 'Settings',

  mount(root, actions) {
    this.root = root;
    this.actions = actions;
    this.dirty = new Set();
    this.devices = null;
    this.discoverMsg = '';
    render(
      root,
      html`<h1>Settings</h1>
        <p class="silk" style="margin:-6px 0 18px" data-r="scope"></p>
        ${FORMS.map((f) => html`<section class="settings-section" data-section="${f}"></section>`)}`
    );
    this.onInput = (e) => {
      const form = e.target.closest('form[data-form]');
      if (form && !e.target.matches('[data-instant]')) this.dirty.add(form.dataset.form);
      if (e.target.matches('[data-r="device"]')) this.pickDevice(e.target.value);
      if (e.target.matches('[data-r="field"]')) this.pickField(e.target.value);
    };
    this.onSubmit = (e) => {
      const form = e.target.closest('form[data-form]');
      if (!form) return;
      e.preventDefault();
      this.submit(form.dataset.form, form);
    };
    this.onClick = (e) => {
      const b = e.target.closest('button[data-act]');
      if (!b) return;
      const act = b.dataset.act;
      if (act === 'discover') this.discover();
      if (act === 'rm-sensor') this.save('sensors', { sensors: this.s.sensors.filter((x) => x.id !== b.dataset.id).map(sensorOut) }, 'Sensor removed.');
      if (act === 'rm-peer') this.save('peers', { peers: this.s.peers.filter((_, i) => String(i) !== b.dataset.i) }, 'Host removed.');
      if (act === 'rm-exclude') this.save('tuning', { tuning: { exclude: this.s.tuning.exclude.filter((x) => x !== b.dataset.key) } }, 'Exclusion removed.');
    };
    this.onChange = (e) => {
      if (e.target.matches('[data-r="tuning-enabled"]')) this.save('tuning', { tuning: { enabled: e.target.checked } }, e.target.checked ? 'Tuning actions switched on.' : 'Tuning actions switched off.');
    };
    root.addEventListener('input', this.onInput);
    root.addEventListener('change', this.onInput);
    root.addEventListener('change', this.onChange);
    root.addEventListener('submit', this.onSubmit);
    root.addEventListener('click', this.onClick);
  },

  unmount() {
    this.root.removeEventListener('input', this.onInput);
    this.root.removeEventListener('change', this.onInput);
    this.root.removeEventListener('change', this.onChange);
    this.root.removeEventListener('submit', this.onSubmit);
    this.root.removeEventListener('click', this.onClick);
  },

  update(state, keys) {
    this.state = state;
    if (keys.includes('host')) {
      this.dirty.clear();
      this.devices = null;
      this.discoverMsg = '';
    }
    const host = state.hosts.find((h) => h.key === state.host);
    $('[data-r="scope"]', this.root).textContent = host ? `These settings belong to ${host.name}. Each host keeps its own.` : '';
    if (!state.settings) {
      FORMS.forEach((f) => render(this.section(f), f === 'run' ? html`<p class="empty-state">Loading settings.</p>` : ''));
      return;
    }
    this.s = state.settings;
    const all = keys.includes('*') || keys.includes('settings') || keys.includes('host');
    for (const f of FORMS) {
      if (this.dirty.has(f)) continue;
      if (all || (f === 'mqtt' && keys.includes('mqtt')) || (f === 'peers' && keys.includes('hosts')) || (f === 'sensors' && keys.includes('mqtt'))) this.draw(f);
    }
  },

  section(f) {
    return $(`[data-section="${f}"]`, this.root);
  },

  error(f, msg) {
    const el = $(`[data-section="${f}"] .form-error`, this.root);
    if (el) el.textContent = msg || '';
  },

  async save(f, patch, okText) {
    this.error(f, '');
    try {
      await this.actions.saveSettings(patch, okText);
      this.dirty.delete(f);
      this.draw(f);
      return true;
    } catch (e) {
      this.error(f, e.message);
      return false;
    }
  },

  submit(f, form) {
    const v = (name) => (form.elements[name] ? form.elements[name].value.trim() : '');
    const n = (name) => Number(v(name));
    if (f === 'run') {
      this.save('run', { run: { mode: form.elements.mode.value, fastIntervalSec: n('fast'), idleIntervalSec: n('idle'), measureSec: n('measure') } }, 'Measurement settings saved.');
    }
    if (f === 'tuning') {
      const key = v('exclude');
      if (key) this.save('tuning', { tuning: { exclude: [...this.s.tuning.exclude, key] } }, 'Exclusion added.');
    }
    if (f === 'mqtt') {
      const mqtt = { url: v('url'), username: v('username'), baseTopic: v('baseTopic') || 'zigbee2mqtt' };
      if (form.elements.clearPassword && form.elements.clearPassword.checked) mqtt.password = '';
      else if (form.elements.password.value) mqtt.password = form.elements.password.value;
      this.save('mqtt', { mqtt }, 'Broker settings saved.');
    }
    if (f === 'sensors') {
      const role = form.elements.role.value;
      const sensor = { name: v('name'), topic: v('topic'), path: v('path') || null, unit: v('unit') || 'W', role };
      if (!sensor.topic) return this.error('sensors', 'Pick a device or enter a topic first.');
      let list = this.s.sensors.map(sensorOut);
      if (role === 'wall') list = list.map((x) => (x.role === 'wall' ? { ...x, role: 'extra' } : x));
      this.save('sensors', { sensors: [...list, sensor] }, role === 'wall' ? 'Wall sensor added.' : 'Sensor added.');
    }
    if (f === 'peers') {
      const url = v('url');
      if (!url) return this.error('peers', 'Enter the address of the other PowerTop, for example http://192.168.1.20:9002');
      this.save('peers', { peers: [...this.s.peers, { name: v('name'), url }] }, 'Host added.');
    }
    if (f === 'retention') {
      this.save('retention', { history: { days: n('days') }, impact: { settleSec: n('settle'), windowSec: n('window') } }, 'Saved.');
    }
    return undefined;
  },

  draw(f) {
    const s = this.s;
    const el = this.section(f);
    if (f === 'run') {
      render(
        el,
        html`<h2>Measurement</h2>
          <p>Each powertop run traces the system for the measurement time and briefly raises CPU use, so fewer runs also mean cleaner numbers.</p>
          <form data-form="run" class="form-grid">
            <span class="silk">Mode</span>
            <div class="radio-row">${MODES.map(
              ([id, label, hint]) => html`<label title="${hint}"><input type="radio" name="mode" value="${id}" ${checked(s.run.mode === id)}> ${label}</label>`
            )}</div>
            <label for="set-fast">Interval while watched</label><div><input id="set-fast" name="fast" type="number" min="30" max="3600" value="${s.run.fastIntervalSec}"> s</div>
            <label for="set-idle">Idle interval</label><div><input id="set-idle" name="idle" type="number" min="60" max="86400" value="${s.run.idleIntervalSec}"> s</div>
            <span class="hint">Adaptive mode only: how often to measure when nobody has this page open.</span>
            <label for="set-measure">Measurement time</label><div><input id="set-measure" name="measure" type="number" min="5" max="120" value="${s.run.measureSec}"> s</div>
            <div></div><div class="form-actions"><button class="btn btn-primary" type="submit">Save measurement settings</button><span class="form-error"></span></div>
          </form>`
      );
    }
    if (f === 'tuning') {
      const locked = (s.locked || []).includes('tuning.enabled');
      render(
        el,
        html`<h2>Tuning</h2>
          <p>Tuning writes power-saving values to sysfs. Switch it off on hosts where a sleeping device could cut you off, such as a router.</p>
          <form data-form="tuning" class="form-grid">
            <span class="silk">Tuning actions</span>
            <div><label class="switch"><input type="checkbox" data-instant data-r="tuning-enabled" ${checked(s.tuning.enabled)} ${disabled(locked)}><span class="knob"></span>
              <span>${s.tuning.enabled ? 'On' : 'Off'}${locked ? ' (locked by TUNING_ENABLED=false)' : ''}</span></label></div>
            <span class="silk">Excluded from auto-tune</span>
            <div>${s.tuning.exclude.length
              ? html`<table class="data"><tbody>${s.tuning.exclude.map(
                  (x) => html`<tr><td class="mono wrap">${x}</td><td class="r"><button class="btn btn-quiet btn-sm" type="button" data-act="rm-exclude" data-key="${x}">Remove</button></td></tr>`
                )}</tbody></table>`
              : html`<span class="dim">Nothing excluded. Use the switches on the Tuning page, or add a sysfs path or description here.</span>`}</div>
            <label for="set-exclude">Add exclusion</label>
            <div style="display:flex;gap:8px"><input id="set-exclude" name="exclude" type="text" placeholder="/sys/bus/usb/devices/2-1/power/control"><button class="btn" type="submit">Add</button></div>
            <div></div><span class="form-error"></span>
          </form>`
      );
    }
    if (f === 'mqtt') {
      const m = this.state.mqtt;
      const status = !s.mqtt.url ? 'Not configured.' : !m ? '' : m.connected ? `Connected to ${m.url}.` : `Not connected${m.error ? `: ${m.error}` : '.'}`;
      render(
        el,
        html`<h2>MQTT broker</h2>
          <p>Smart plugs and other sensors are read from MQTT, for example zigbee2mqtt. Only subscriptions are made; nothing is published.</p>
          <form data-form="mqtt" class="form-grid">
            <label for="set-url">Broker</label><input id="set-url" name="url" type="text" placeholder="mqtt://192.168.1.10:1883" value="${s.mqtt.url}">
            <label for="set-user">Username</label><input id="set-user" name="username" type="text" autocomplete="off" value="${s.mqtt.username}">
            <label for="set-pass">Password</label>
            <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap"><input id="set-pass" name="password" type="password" autocomplete="new-password" placeholder="${s.mqtt.passwordSet ? 'unchanged' : 'none'}">
              ${s.mqtt.passwordSet ? html`<label class="silk"><input type="checkbox" name="clearPassword"> Remove password</label>` : ''}</div>
            <label for="set-base">zigbee2mqtt base topic</label><input id="set-base" name="baseTopic" type="text" value="${s.mqtt.baseTopic}">
            <span class="silk">Status</span><span class="${m && m.connected ? '' : 'silk'}">${status}</span>
            <div></div><div class="form-actions"><button class="btn btn-primary" type="submit">Save broker</button><span class="form-error"></span></div>
          </form>`
      );
    }
    if (f === 'sensors') {
      const values = new Map(((this.state.mqtt && this.state.mqtt.sensors) || []).map((x) => [x.id, x]));
      const devices = this.devices;
      render(
        el,
        html`<h2>Sensors</h2>
          <p>The wall sensor is the plug this host is powered from. Impact tests and the Power page compare it with the RAPL counters.</p>
          ${s.sensors.length
            ? html`<div class="table-wrap" style="margin-bottom:14px"><table class="data">
                <thead><tr><th scope="col">Name</th><th scope="col">Role</th><th scope="col">Topic</th><th scope="col">Field</th><th scope="col" class="r">Value</th><th scope="col"></th></tr></thead>
                <tbody>${s.sensors.map((x) => {
                  const live = values.get(x.id);
                  return html`<tr><td>${x.name}</td><td>${x.role === 'wall' ? 'Wall power' : 'Extra'}</td><td class="mono wrap">${x.topic}</td><td class="mono">${x.path || '(whole payload)'}</td>
                    <td class="r num">${live && live.value !== null ? `${live.value} ${x.unit}` : html`<span class="dim">–</span>`}</td>
                    <td class="r"><button class="btn btn-quiet btn-sm" type="button" data-act="rm-sensor" data-id="${x.id}">Remove</button></td></tr>`;
                })}</tbody></table></div>`
            : ''}
          <form data-form="sensors" class="form-grid">
            <span class="silk">Find device</span>
            <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
              <button class="btn" type="button" data-act="discover" ${disabled(!s.mqtt.url)}>Find zigbee2mqtt devices</button>
              ${devices && devices.length
                ? html`<select class="input" data-r="device" aria-label="Device"><option value="">Choose a device</option>${devices.map(
                    (d, i) => html`<option value="${i}">${d.name}${d.model ? ` (${d.model})` : ''}</option>`
                  )}</select>
                  <select class="input" data-r="field" aria-label="Field"><option value="">Field</option></select>`
                : html`<span class="silk">${this.discoverMsg || (s.mqtt.url ? '' : 'Save a broker first.')}</span>`}
            </div>
            <label for="set-sname">Name</label><input id="set-sname" name="name" type="text" placeholder="Server plug">
            <label for="set-topic">Topic</label><input id="set-topic" name="topic" type="text" placeholder="zigbee2mqtt/Server plug">
            <label for="set-path">Field</label><input id="set-path" name="path" type="text" placeholder="power (empty for plain numbers)">
            <label for="set-unit">Unit</label><input id="set-unit" name="unit" type="text" value="W" style="width:90px">
            <span class="silk">Role</span>
            <div class="radio-row"><label><input type="radio" name="role" value="wall" ${checked(!s.sensors.some((x) => x.role === 'wall'))}> Wall power of this host</label>
              <label><input type="radio" name="role" value="extra" ${checked(s.sensors.some((x) => x.role === 'wall'))}> Extra reading</label></div>
            <div></div><div class="form-actions"><button class="btn btn-primary" type="submit">Add sensor</button><span class="form-error"></span></div>
          </form>`
      );
    }
    if (f === 'peers') {
      const state = this.state;
      const statusOf = (i) => {
        if (state.host !== 'local') return '';
        const h = state.hosts.find((x) => x.idx === i);
        if (!h) return '';
        return h.ok ? html`<span class="tag ok">online</span>` : h.outdated ? html`<span class="tag attn">older version</span>` : html`<span class="tag fault" title="${h.error || ''}">offline</span>`;
      };
      render(
        el,
        html`<h2>Other hosts</h2>
          <p>PowerTop instances listed here appear in the host switcher and the Hosts table on the overview. Requests go through this instance.</p>
          ${s.peers.length
            ? html`<div class="table-wrap" style="margin-bottom:14px"><table class="data">
                <thead><tr><th scope="col">Name</th><th scope="col">Address</th><th scope="col">Status</th><th scope="col"></th></tr></thead>
                <tbody>${s.peers.map(
                  (p, i) => html`<tr><td>${p.name}</td><td class="mono">${p.url}</td><td>${statusOf(i)}</td>
                    <td class="r"><button class="btn btn-quiet btn-sm" type="button" data-act="rm-peer" data-i="${i}">Remove</button></td></tr>`
                )}</tbody></table></div>`
            : ''}
          <form data-form="peers" class="form-grid">
            <label for="set-pname">Name</label><input id="set-pname" name="name" type="text" placeholder="nas">
            <label for="set-purl">Address</label><input id="set-purl" name="url" type="url" placeholder="http://192.168.1.20:9002">
            <div></div><div class="form-actions"><button class="btn btn-primary" type="submit">Add host</button><span class="form-error"></span></div>
          </form>`
      );
    }
    if (f === 'retention') {
      render(
        el,
        html`<h2>History and impact tests</h2>
          <p>History keeps one power point per minute and one record per measurement, appended to disk every 10 minutes.</p>
          <form data-form="retention" class="form-grid">
            <label for="set-days">Keep history</label><div><input id="set-days" name="days" type="number" min="1" max="31" value="${s.history.days}"> days</div>
            <label for="set-settle">Impact settle time</label><div><input id="set-settle" name="settle" type="number" min="0" max="600" value="${s.impact.settleSec}"> s</div>
            <label for="set-window">Impact window</label><div><input id="set-window" name="window" type="number" min="30" max="1800" value="${s.impact.windowSec}"> s</div>
            <span class="hint">A test takes two settle periods plus two windows: about ${fmt.duration((s.impact.settleSec * 2 + s.impact.windowSec * 2) * 1000)} now.</span>
            <div></div><div class="form-actions"><button class="btn btn-primary" type="submit">Save</button><span class="form-error"></span></div>
          </form>`
      );
    }
  },

  async discover() {
    this.discoverMsg = 'Looking for devices…';
    this.devices = null;
    this.draw('sensors');
    try {
      const out = await this.actions.api('mqtt/discover');
      this.devices = out.devices;
      this.discoverMsg = out.devices.length ? '' : 'No devices with numeric readings found.';
    } catch (e) {
      this.discoverMsg = e.status === 503 ? 'Not connected to the broker. Check the broker settings above.' : e.message;
    }
    this.draw('sensors');
  },

  pickDevice(i) {
    const d = this.devices && this.devices[Number(i)];
    const form = $('form[data-form="sensors"]', this.root);
    const field = $('[data-r="field"]', this.root);
    if (!d || !form) return;
    form.elements.name.value = d.name;
    form.elements.topic.value = d.topic;
    render(field, html`${d.fields.map((x) => html`<option value="${x.property}" data-unit="${x.unit}">${x.property}${x.unit ? ` (${x.unit})` : ''}</option>`)}`);
    const def = d.fields.find((x) => x.property === 'power') || d.fields[0];
    if (def) {
      field.value = def.property;
      this.pickField(def.property);
    }
  },

  pickField(prop) {
    const form = $('form[data-form="sensors"]', this.root);
    const opt = $(`[data-r="field"] option[value="${CSS.escape(prop)}"]`, this.root);
    if (!form) return;
    form.elements.path.value = prop;
    form.elements.unit.value = (opt && opt.dataset.unit) || '';
  },
};
