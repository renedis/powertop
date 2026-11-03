'use strict';
const cheerio = require('cheerio');
const { parseScript, stableId } = require('./script');

const clean = (s) => String(s ?? '').replace(/ |&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

function num(s) {
  const m = /-?\d+(?:\.\d+)?/.exec(clean(s));
  return m ? Number(m[0]) : null;
}

const pctOf = (s) => (/%$/.test(clean(s)) ? num(s) : null);
const round1 = (x) => Math.round(x * 10) / 10;
const headerKey = (s) => clean(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
const cpuNum = (label) => Number((/(\d+)\s*$/.exec(label) || [])[1] ?? Infinity);
const byCpu = (a, b) => cpuNum(a.label) - cpuNum(b.label);

function cellsOf($, tr) {
  return $(tr)
    .children('th,td')
    .toArray()
    .map((c) => ({ th: c.tagName === 'th', text: clean($(c).text()) }));
}

/** Rows of a header-labelled table as objects keyed by normalised header text. */
function readTable($, table) {
  let headers = null;
  const out = [];
  $(table)
    .find('tr')
    .each((_, tr) => {
      const cells = cellsOf($, tr);
      if (!cells.length) return;
      if (cells.every((c) => c.th)) {
        headers = cells.map((c) => headerKey(c.text));
        return;
      }
      if (!headers) return;
      const values = cells.filter((c) => !c.th).map((c) => c.text);
      if (values.every((v) => v === '')) return;
      const row = {};
      headers.forEach((h, i) => {
        row[h] = values[i] ?? '';
      });
      out.push(row);
    });
  return out;
}

function parseSysinfo($) {
  const raw = {};
  $('table.emphasis1 tr').each((_, tr) => {
    const k = clean($(tr).find('th').first().text());
    if (k) raw[k] = clean($(tr).find('td').first().text());
  });
  const ver = /^(\S+)(?:\s+ran at\s+(.*))?$/.exec(raw['PowerTOP Version'] || '');
  const cpuInfo = raw['CPU Information'] || '';
  const cpu = /^(\d+)(?:\s+(.*))?$/.exec(cpuInfo);
  return {
    version: ver ? ver[1] : null,
    ranAt: ver && ver[2] ? ver[2] : null,
    kernel: (raw['Kernel Version'] || '').replace(/^Linux version\s+/, '') || null,
    system: raw['System Name'] || null,
    cpuCount: cpu ? Number(cpu[1]) : null,
    cpu: cpu ? cpu[2] || null : cpuInfo || null,
    os: raw['OS Information'] || null,
  };
}

const SUMMARY_KEYS = { system: 'wakeups', cpu: 'cpuPct', gpu: 'gpuOps', gfx: 'gfxWakeups', vfs: 'vfsOps' };

function parseSummary($) {
  const out = { cpuPct: null, wakeups: null, gpuOps: null, gfxWakeups: null, vfsOps: null };
  $('li.summary_list').each((_, li) => {
    const text = clean($(li).text());
    const i = text.indexOf(':');
    if (i < 0) return;
    const key = SUMMARY_KEYS[text.slice(0, i).trim().toLowerCase()];
    if (key) out[key] = num(text.slice(i + 1));
  });
  return out;
}

const US_PER = { ns: 0.001, us: 1, µs: 1, ms: 1000, s: 1e6 };

function toUs(usage) {
  const m = /(-?\d+(?:\.\d+)?)\s*(ns|us|µs|ms|s)\/s/.exec(usage);
  return m ? Math.round(Number(m[1]) * US_PER[m[2]] * 1000) / 1000 : null;
}

function parseTopConsumers($) {
  const rows = $('#summary table.emphasis2').toArray().flatMap((t) => readTable($, t));
  return rows.map((r) => ({
    usage: r.usage || '',
    usagePct: pctOf(r.usage),
    events: num(r.eventss),
    category: r.category || '',
    description: r.description || '',
  }));
}

function parseSoftware($) {
  const rows = $('#software table.emphasis2').toArray().flatMap((t) => readTable($, t));
  return rows
    .filter((r) => r.description || r.usage)
    .map((r) => ({
      usage: r.usage || '',
      usageUs: toUs(r.usage || ''),
      wakeups: num(r.wakeupss),
      gpuOps: num(r.gpuopss),
      diskIo: num(r.diskios),
      gfxWakeups: num(r.gfxwakeupss),
      category: r.category || '',
      description: r.description || '',
    }));
}

/** Header cells after the first: "CPU","0" pairs or "CPU 0" singles. */
function cpuLabels(texts) {
  const labels = [];
  for (let i = 0; i < texts.length; i++) {
    if (texts[i] === 'CPU' && /^\d+$/.test(texts[i + 1] || '')) {
      labels.push(`CPU ${texts[i + 1]}`);
      i++;
    } else if (/^CPU \d+$/.test(texts[i])) {
      labels.push(texts[i]);
    }
  }
  return labels;
}

function parseIdle($) {
  const pkg = [];
  const cores = [];
  const cpus = new Map();
  $('#cpuidle table').each((_, table) => {
    let mode = null;
    let labels = [];
    let states = null;
    $(table)
      .find('tr')
      .each((_, tr) => {
        const cells = cellsOf($, tr);
        if (!cells.length) return;
        if (cells.every((c) => c.th)) {
          const texts = cells.map((c) => c.text);
          if (texts[0] === 'Package') {
            mode = 'package';
          } else if (texts[0] === '' && /^Core\b/.test(texts[1] || '')) {
            mode = 'core';
            states = [];
            cores.push({ label: texts[1], states });
          } else {
            labels = cpuLabels(texts.slice(1));
            mode = labels.length ? 'cpu' : null;
            for (const l of labels) if (!cpus.has(l)) cpus.set(l, { label: l, states: [] });
          }
          return;
        }
        if (mode === 'package' || mode === 'core') {
          const [state, value] = cells.map((c) => c.text);
          if (!state || !value) return;
          (mode === 'package' ? pkg : states).push({ state, pct: num(value) });
        } else if (mode === 'cpu') {
          const state = cells[0].text;
          if (!state) return;
          const values = cells.slice(1).map((c) => c.text);
          labels.forEach((label, i) => {
            const p = values[i * 2];
            if (!p) return;
            const t = values[i * 2 + 1];
            cpus.get(label).states.push({ state, pct: num(p), avgMs: t ? num(t) : null });
          });
        }
      });
  });
  return {
    package: pkg,
    cores: cores.filter((c) => c.states.length),
    cpus: [...cpus.values()].filter((c) => c.states.length).sort(byCpu),
  };
}

function toMhz(value) {
  const m = /(\d+(?:\.\d+)?)\s*(GHz|MHz)/i.exec(value);
  if (!m) return null;
  return Math.round(Number(m[1]) * (m[2].toLowerCase() === 'ghz' ? 1000 : 1));
}

function parseFreq($) {
  const cpus = new Map();
  $('#cpufreq table').each((_, table) => {
    let labels = [];
    $(table)
      .find('tr')
      .each((_, tr) => {
        const cells = cellsOf($, tr);
        if (!cells.length) return;
        if (cells.every((c) => c.th)) {
          labels = cpuLabels(cells.slice(1).map((c) => c.text));
          return;
        }
        if (!labels.length) return;
        const state = cells[0].text;
        if (!state || /^idle$/i.test(state)) return;
        cells.slice(1).forEach((c, i) => {
          const label = labels[i];
          if (!label || !c.text) return;
          if (!cpus.has(label)) cpus.set(label, { label, states: [] });
          cpus.get(label).states.push({ state, value: c.text, mhz: toMhz(c.text) });
        });
      });
  });
  return { cpus: [...cpus.values()].filter((c) => c.states.length).sort(byCpu) };
}

/** Physical NICs: en*, eth<N>, wl*, ww*, switch<N>; everything else (bridges, veth, VLAN sub-interfaces, tunnels) is virtual. */
function isVirtualNic(ifname) {
  return !/^(en[a-z0-9]+|eth\d+|wl[a-z0-9]+|ww[a-z0-9]+|switch\d+)$/.test(ifname);
}

function groupOf(name) {
  if (/^(CPU (misc|core|use)|DRAM|GPU( misc| core)?)$/i.test(name)) return 'cpu';
  if (/^PCI Device:/i.test(name)) return 'pci';
  if (/^USB device:/i.test(name)) return 'usb';
  if (/^Audio codec/i.test(name)) return 'audio';
  const nic = /^(?:nic:|Network interface:\s*)(\S+)/i.exec(name);
  if (nic) return isVirtualNic(nic[1]) ? 'virtual' : 'net';
  if (/^runtime-/i.test(name)) return 'platform';
  if (/^I2C (Adapter|Device)/i.test(name)) return 'i2c';
  return 'other';
}

function device(usage, name) {
  const isPct = /%$/.test(usage);
  const m = isPct ? null : /^(-?\d+(?:\.\d+)?)\s*(.*)$/.exec(usage);
  return {
    usage,
    usagePct: isPct ? num(usage) : null,
    rate: m ? Number(m[1]) : null,
    unit: m ? m[2] || null : null,
    name,
    group: groupOf(name),
  };
}

function parseDevinfo($) {
  const devices = [];
  const activity = [];
  $('#devinfo table').each((_, table) => {
    const rows = readTable($, table);
    if (!rows.length) return;
    if ('devicename' in rows[0]) {
      for (const r of rows) if (r.devicename) devices.push(device(r.usage || '', r.devicename));
    } else if ('process' in rows[0] && 'device' in rows[0]) {
      let last = '';
      for (const r of rows) {
        last = r.process || last;
        if (r.device) activity.push({ process: last, device: r.device });
      }
    }
  });
  return { devices, activity };
}

const sectionOf = (title) =>
  /need of tuning/i.test(title) ? 'bad' : /untunable/i.test(title) ? 'untunable' : /optimal/i.test(title) ? 'good' : null;

/** Rows with description (+ optional script); duplicate descriptions get distinct ids. */
function scriptRows($, table, section) {
  const seen = new Map();
  const out = [];
  for (const r of readTable($, table)) {
    const description = r.description || '';
    if (!description) continue;
    const script = r.script || null;
    const key = `${description}\u0000${script || ''}`;
    const n = seen.get(key) || 0;
    seen.set(key, n + 1);
    out.push({ id: stableId(section, description, script || '', String(n)), description, script });
  }
  return out;
}

function parseTuning($) {
  const out = { bad: [], untunable: [], good: [] };
  let section = null;
  $('#tuning')
    .find('h2, table')
    .each((_, el) => {
      if (el.tagName === 'h2') {
        section = sectionOf(clean($(el).text()));
        return;
      }
      if (!section) return;
      for (const row of scriptRows($, el, section)) {
        if (section === 'bad') out.bad.push({ ...row, write: parseScript(row.script) });
        else out[section].push({ id: row.id, description: row.description });
      }
    });
  return out;
}

function parseWakeup($) {
  return $('#wakeup table')
    .toArray()
    .flatMap((t) => scriptRows($, t, 'wake'))
    .map((row) => ({ ...row, write: parseScript(row.script) }));
}

function parseReport(html) {
  const $ = cheerio.load(String(html || ''));
  const software = parseSoftware($);
  const cpuidle = parseIdle($);
  const cpufreq = parseFreq($);
  const { devices, activity } = parseDevinfo($);
  return {
    sysinfo: parseSysinfo($),
    summary: parseSummary($),
    topConsumers: parseTopConsumers($),
    software,
    cpuidle,
    cpufreq,
    devices,
    deviceActivity: activity,
    tuning: parseTuning($),
    wakeup: parseWakeup($),
    caps: { perf: software.length > 0, pkgCstates: cpuidle.package.length > 0, cpufreq: cpufreq.cpus.length > 0 },
  };
}

/** Headline idle number: Intel package C6+ residency, else the deepest generic state. */
function deepIdle(report) {
  const idle = report && report.cpuidle;
  if (!idle) return null;
  const pkg = idle.package || [];
  const numbered = pkg
    .map((s) => ({ ...s, n: Number((/^C(\d+)/i.exec(s.state) || [])[1]) }))
    .filter((s) => Number.isFinite(s.n));
  if (numbered.length) {
    const sum = numbered.filter((s) => s.n >= 6 && s.pct != null).reduce((a, s) => a + s.pct, 0);
    return { label: 'PC6+', pct: round1(sum) };
  }
  if (pkg.length) {
    const last = pkg[pkg.length - 1];
    return { label: last.state, pct: last.pct };
  }
  const cpus = (idle.cpus || []).filter((c) => c.states.length);
  if (!cpus.length) return null;
  const name = cpus[0].states[cpus[0].states.length - 1].state;
  const vals = cpus.map((c) => (c.states.find((s) => s.state === name) || {}).pct).filter((v) => v != null);
  if (!vals.length) return null;
  return { label: `${name} avg`, pct: round1(vals.reduce((a, b) => a + b, 0) / vals.length) };
}

module.exports = { parseReport, deepIdle, isVirtualNic, clean, num };
