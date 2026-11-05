'use strict';
const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const { EventEmitter } = require('events');
const { round } = require('./stats');

/*
 * UniFi console (UDM) page: the hardware and OS numbers a UniFi OS gateway
 * exposes when RAPL, cpufreq and perf are missing. Everything comes from the
 * host's /proc and /sys (the container runs with pid: host and the host /sys),
 * plus a few host tools run through nsenter: ethtool -m (SFP modules),
 * smartctl (drives) and mca-dump (the controller's own device report).
 * Only active when /proc/ubnthal/system.info exists.
 */

const HZ = 100; // USER_HZ, the tick unit of /proc/stat and /proc/<pid>/stat
const CPU_FIELDS = ['user', 'nice', 'system', 'idle', 'iowait', 'irq', 'softirq', 'steal'];
const NOISE_IFACES = /^(lo|dummy\d*|erspan\d*|gre\d*|gretap\d*|ifb\d*|ip6_vti\d*|ip6tnl\d*|ip_vti\d*|ip6gre\d*|sit\d*|teql\d*|tunl\d*)$/;
const DISK_SKIP = /^(loop|ram|zram|mtdblock|nbd|dm-)/;
const SECRET_RE = /(pass(?:word|wd)?|token|secret|api[-_]?key|auth)([=:])\S+/gi;

/** Public spec-sheet values per model (ubnthal shortname). */
const SPECS = {
  UDMPRO: {
    model: 'UniFi Dream Machine Pro',
    soc: 'Annapurna Labs Alpine AL-324',
    cores: 4,
    core: 'Arm Cortex-A57',
    clockGHz: 1.7,
    scaling: false,
    ram: '4 GB',
    storage: '16 GB eMMC',
    psu: 'internal, 50 W',
    maxW: 33,
  },
};

/** Names UniFi itself uses for the board monitor channels (temps) and the kernel's (rails). */
const CHIP_LABELS = { adt7475: { temp1: 'CPU', temp2: 'Local', temp3: 'PHY', in1: 'VCCP', in2: 'VCC' } };
const ZONE_LABELS = { 'cpu-thermal': 'SoC' };

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const natural = (a, b) => String(a).localeCompare(String(b), 'en', { numeric: true });
const milli = (v, digits = 1) => {
  const n = num(v);
  return n === null ? null : round(n / 1000, digits);
};
const avg = (xs) => {
  const v = xs.filter((x) => typeof x === 'number' && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};
const rate = (a, b, dt, digits = 1) => (dt > 0 && Number.isFinite(a) && Number.isFinite(b) ? round(Math.max(0, b - a) / dt, digits) : null);

// ---------------------------------------------------------------- parsers

function parseKv(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const i = line.indexOf('=');
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    if (!(k in out)) out[k] = line.slice(i + 1).trim();
  }
  return out;
}

/** "UDMPRO.al324.v5.1.33.abc.260909.0025" -> { firmware: "5.1.33", build } */
function parseVersion(text) {
  const s = String(text || '').trim().split('\n')[0];
  const m = /\.v(\d+\.\d+\.\d+)(?:\.|$)/.exec(s);
  return { firmware: m ? m[1] : null, build: s || null };
}

function parseStat(text) {
  const out = { cpus: {}, total: null, ctxt: null, intr: null, processes: null, running: null, blocked: null, btime: null };
  for (const line of String(text || '').split('\n')) {
    const f = line.trim().split(/\s+/);
    if (/^cpu\d+$/.test(f[0])) out.cpus[f[0]] = f.slice(1, 9).map(Number);
    else if (f[0] === 'cpu') out.total = f.slice(1, 9).map(Number);
    else if (f[0] === 'ctxt') out.ctxt = Number(f[1]);
    else if (f[0] === 'intr') out.intr = Number(f[1]);
    else if (f[0] === 'processes') out.processes = Number(f[1]);
    else if (f[0] === 'procs_running') out.running = Number(f[1]);
    else if (f[0] === 'procs_blocked') out.blocked = Number(f[1]);
    else if (f[0] === 'btime') out.btime = Number(f[1]);
  }
  return out;
}

/** Share of each /proc/stat field between two snapshots, in % of the elapsed CPU time. */
function cpuSplit(a, b) {
  if (!b) return null;
  const d = b.map((v, i) => Math.max(0, v - ((a && a[i]) || 0)));
  const total = d.reduce((x, y) => x + (Number.isFinite(y) ? y : 0), 0);
  if (!total) return null;
  const out = {};
  CPU_FIELDS.forEach((k, i) => {
    out[k] = round(((d[i] || 0) / total) * 100, 2);
  });
  out.busy = round(Math.max(0, 100 - out.idle - out.iowait), 2);
  return out;
}

function parseInterrupts(text) {
  const lines = String(text || '').split('\n');
  const ncpu = (lines[0] && lines[0].match(/CPU\d+/g)) || [];
  const rows = [];
  for (const line of lines.slice(1)) {
    const m = /^\s*([^:\s]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const parts = m[2].trim().split(/\s+/).filter(Boolean);
    const counts = [];
    let i = 0;
    while (i < parts.length && counts.length < Math.max(1, ncpu.length) && /^\d+$/.test(parts[i])) counts.push(Number(parts[i++]));
    if (!counts.length) continue;
    const rest = parts.slice(i);
    let chip = '';
    let name;
    if (/^\d+$/.test(m[1]) && rest.length >= 3) {
      chip = rest[0];
      name = rest.slice(3).join(' ') || rest.join(' ');
    } else name = rest.join(' ') || m[1];
    rows.push({ id: m[1], name, chip, counts, total: counts.reduce((a, b) => a + b, 0) });
  }
  return { cpus: ncpu.length, rows };
}

function parseSoftirqs(text) {
  const lines = String(text || '').split('\n');
  const rows = [];
  for (const line of lines.slice(1)) {
    const m = /^\s*([A-Z_]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const counts = m[2].trim().split(/\s+/).filter(Boolean).map(Number);
    rows.push({ name: m[1], counts, total: counts.reduce((a, b) => a + b, 0) });
  }
  return rows;
}

function parseNetDev(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const i = line.indexOf(':');
    if (i < 0 || /\|/.test(line)) continue;
    const name = line.slice(0, i).trim();
    const f = line.slice(i + 1).trim().split(/\s+/).map(Number);
    if (!name || f.length < 16) continue;
    out[name] = { rxBytes: f[0], rxPackets: f[1], rxErrs: f[2], rxDrop: f[3], txBytes: f[8], txPackets: f[9], txErrs: f[10], txDrop: f[11] };
  }
  return out;
}

function parseDiskstats(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 14) continue;
    out[f[2]] = {
      reads: Number(f[3]),
      readSectors: Number(f[5]),
      writes: Number(f[7]),
      writeSectors: Number(f[9]),
      inflight: Number(f[11]),
      ioMs: Number(f[12]),
    };
  }
  return out;
}

function parseMdstat(text) {
  const lines = String(text || '').split('\n');
  const arrays = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(md\d+)\s*:\s*(\S+)\s+(?:\((?:auto-)?read-only\)\s+)?(\S+)\s+(.+)$/.exec(lines[i]);
    if (!m) continue;
    const next = lines[i + 1] || '';
    const st = /\[(\d+)\/(\d+)\]\s*\[([U_]+)\]/.exec(next);
    const blocks = /^\s*(\d+) blocks/.exec(next);
    const sync = /(resync|recovery|check|reshape)\s*=\s*([\d.]+)%/.exec(`${lines[i + 2] || ''} ${lines[i + 3] || ''}`);
    arrays.push({
      name: m[1],
      state: m[2],
      level: m[3],
      members: m[4].trim().split(/\s+/).map((x) => x.replace(/\[\d+\].*$/, '')),
      sizeGB: blocks ? round((Number(blocks[1]) * 1024) / 1e9, 1) : null,
      slots: st ? Number(st[1]) : null,
      active: st ? Number(st[2]) : null,
      map: st ? st[3] : null,
      sync: sync ? { action: sync[1], pct: Number(sync[2]) } : null,
    });
  }
  return arrays;
}

function parseSwaps(text) {
  return String(text || '')
    .split('\n')
    .slice(1)
    .map((l) => l.trim().split(/\s+/))
    .filter((f) => f.length >= 5)
    .map((f) => ({ dev: f[0], type: f[1], sizeKb: Number(f[2]), usedKb: Number(f[3]), prio: Number(f[4]) }));
}

function parseMeminfo(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const m = /^([\w()]+):\s+(\d+)/.exec(line);
    if (m) out[m[1]] = Number(m[2]);
  }
  return out;
}

/** First column of /proc/net/stat/nf_conntrack (hex) is the table size. */
function parseConntrackStat(text) {
  const lines = String(text || '').trim().split('\n');
  if (lines.length < 2) return null;
  const v = parseInt(lines[1].trim().split(/\s+/)[0], 16);
  return Number.isFinite(v) ? v : null;
}

/** /proc/<pid>/stat; comm may contain spaces and parentheses. */
function parsePidStat(text) {
  if (!text) return null;
  const l = text.indexOf('(');
  const r = text.lastIndexOf(')');
  if (l < 0 || r < l) return null;
  const f = text.slice(r + 2).trim().split(/\s+/);
  if (f.length < 22) return null;
  return {
    pid: Number(text.slice(0, l).trim()),
    comm: text.slice(l + 1, r),
    state: f[0],
    ppid: Number(f[1]),
    utime: Number(f[11]),
    stime: Number(f[12]),
    threads: Number(f[17]),
    start: Number(f[19]),
    rss: Number(f[21]),
  };
}

function parseCgroup(text) {
  const lines = String(text || '').split('\n').filter(Boolean);
  const v2 = lines.find((l) => l.startsWith('0::'));
  const sd = lines.find((l) => /:name=systemd:/.test(l));
  const pick = v2 || sd || lines[0];
  return pick ? pick.slice(pick.indexOf(':', pick.indexOf(':') + 1) + 1) : null;
}

/** cgroup path -> the service, container or session a process belongs to. */
function cgroupGroup(cg) {
  if (!cg || cg === '/') return null;
  const c = /\/docker[-/]([0-9a-f]{12,64})(?:\.scope)?(?:\/|$)/.exec(cg) || /\/(?:libpod|crio|cri-containerd)[-:]([0-9a-f]{12,64})/.exec(cg);
  if (c) return { kind: 'container', id: c[1] };
  const seg = cg.split('/').filter(Boolean);
  const last = seg[seg.length - 1] || '';
  if (/^session-.*\.scope$/.test(last)) return { kind: 'session', name: 'login session' };
  if (/\.(service|scope)$/.test(last)) return { kind: 'service', name: last.replace(/\.(service|scope)$/, '') };
  if (/\.slice$/.test(last)) return { kind: 'service', name: last.replace(/\.slice$/, '') };
  return { kind: 'other', name: last };
}

const redact = (s) => String(s).replace(SECRET_RE, '$1$2***');

const dbm = (v) => {
  const m = /([-+\d.]+|-inf)\s*dBm/.exec(String(v || ''));
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) ? n : null;
};
const mw = (v) => {
  const m = /([\d.]+)\s*mW/.exec(String(v || ''));
  return m ? Number(m[1]) : null;
};
const firstNum = (v) => {
  const m = /-?[\d.]+/.exec(String(v || ''));
  return m ? Number(m[0]) : null;
};

/** `ethtool -m <iface>` text. Serial number and date code are dropped on purpose. */
function parseModule(text) {
  const kv = {};
  const multi = {};
  for (const line of String(text || '').split('\n')) {
    const m = /^\s*([^:]+?)\s+:\s?(.*)$/.exec(line);
    if (!m) continue;
    const k = m[1].trim();
    const v = m[2].trim();
    if (k === 'Option' || k === 'Transceiver type') (multi[k] = multi[k] || []).push(v);
    else if (!(k in kv)) kv[k] = v;
  }
  if (!kv.Identifier) return null;
  const opts = multi.Option || [];
  const level = opts.some((o) => /Power level 3/i.test(o)) ? 3 : opts.some((o) => /Power level 2/i.test(o)) ? 2 : 1;
  const lengths = [];
  const km = firstNum(kv['Length (SMF,km)']);
  if (km) lengths.push(`${km} km single-mode`);
  for (const [key, label] of [
    ['Length (OM4)', 'OM4'],
    ['Length (OM3)', 'OM3'],
    ['Length (50um)', 'OM2'],
    ['Length (62.5um)', 'OM1'],
    ['Length (Copper)', 'copper'],
  ]) {
    const n = firstNum(kv[key]);
    if (n) lengths.push(`${n} m ${label}`);
  }
  const flags = Object.entries(kv)
    .filter(([k, v]) => /(alarm|warning)$/i.test(k) && v === 'On')
    .map(([k]) => k);
  const thr = (name) => {
    const g = (s) => kv[`${name} ${s} threshold`];
    const parse = name.includes('power') ? (v) => dbm(v) : (v) => firstNum(v);
    return g('high alarm') === undefined ? null : { highAlarm: parse(g('high alarm')), lowAlarm: parse(g('low alarm')), highWarn: parse(g('high warning')), lowWarn: parse(g('low warning')) };
  };
  const ddm = Boolean(kv['Module temperature'] || kv['Laser output power']);
  return {
    identifier: kv.Identifier.replace(/^0x[0-9a-f]+\s*/i, '').replace(/[()]/g, '') || kv.Identifier,
    connector: (kv.Connector || '').replace(/^0x[0-9a-f]+\s*/i, '').replace(/[()]/g, '') || null,
    type: (multi['Transceiver type'] || []).join(', ') || null,
    vendor: kv['Vendor name'] || null,
    part: kv['Vendor PN'] || null,
    rev: kv['Vendor rev'] || null,
    wavelengthNm: firstNum(kv['Laser wavelength']),
    reach: lengths.join(', ') || null,
    bitrate: kv['BR, Nominal'] || kv['BR Nominal'] || null,
    powerLevel: level,
    powerMaxW: level === 3 ? 2 : level === 2 ? 1.5 : 1,
    ddm,
    tempC: ddm ? firstNum(kv['Module temperature']) : null,
    vcc: ddm ? firstNum(kv['Module voltage']) : null,
    biasMa: ddm ? firstNum(kv['Laser bias current']) : null,
    txMw: ddm ? mw(kv['Laser output power']) : null,
    txDbm: ddm ? dbm(kv['Laser output power']) : null,
    rxMw: ddm ? mw(kv['Receiver signal average optical power']) : null,
    rxDbm: ddm ? dbm(kv['Receiver signal average optical power']) : null,
    flags,
    thresholds: ddm
      ? {
          temp: thr('Module temperature'),
          vcc: thr('Module voltage'),
          bias: thr('Laser bias current'),
          tx: thr('Laser output power'),
          rx: thr('Laser rx power'),
        }
      : null,
  };
}

/** `smartctl -j -i -A -H` output. Serial and WWN are dropped on purpose. */
function parseSmart(j) {
  const msgs = ((j && j.smartctl && j.smartctl.messages) || []).map((m) => m.string || '');
  const standby = msgs.some((s) => /STANDBY|SLEEP/i.test(s));
  const attrs = (j && j.ata_smart_attributes && j.ata_smart_attributes.table) || [];
  const a = (id) => attrs.find((x) => x.id === id) || null;
  const life = [231, 233, 202, 177, 169].map(a).find(Boolean) || null;
  const lbas = a(241);
  const bs = (j && j.logical_block_size) || 512;
  const raw = (x) => (x && x.raw && typeof x.raw.value === 'number' ? x.raw.value : null);
  const nvme = j && j.nvme_smart_health_information_log;
  return {
    model: (j && j.model_name) || null,
    family: (j && j.model_family) || null,
    firmware: (j && j.firmware_version) || null,
    ssd: j && typeof j.rotation_rate === 'number' ? j.rotation_rate === 0 : nvme ? true : null,
    rpm: j && j.rotation_rate > 0 ? j.rotation_rate : null,
    form: (j && j.form_factor && j.form_factor.name) || null,
    capacityBytes: (j && j.user_capacity && j.user_capacity.bytes) || null,
    link: (j && j.interface_speed && j.interface_speed.current && j.interface_speed.current.string) || null,
    tempC: j && j.temperature && typeof j.temperature.current === 'number' ? j.temperature.current : null,
    hours: j && j.power_on_time && typeof j.power_on_time.hours === 'number' ? j.power_on_time.hours : null,
    cycles: j && typeof j.power_cycle_count === 'number' ? j.power_cycle_count : null,
    healthy: j && j.smart_status ? j.smart_status.passed !== false : null,
    lifePct: life ? life.value : nvme && typeof nvme.percentage_used === 'number' ? 100 - nvme.percentage_used : null,
    lifeAttr: life ? life.name : nvme ? 'Percentage used' : null,
    writtenTB: raw(lbas) !== null ? round((raw(lbas) * bs) / 1e12, 1) : null,
    reallocated: raw(a(5)),
    pending: raw(a(197)),
    crcErrors: raw(a(199)),
    powerMode: standby ? 'standby' : 'active or idle',
  };
}

/** lm-sensors fancontrol config (pwmconfig format). */
function parseFancontrol(text) {
  if (!text) return [];
  const kv = {};
  for (const rawLine of String(text).split('\n')) {
    const line = rawLine.replace(/#.*/, '').trim();
    const m = /^([A-Z]+)=(.*)$/.exec(line);
    if (m) kv[m[1]] = m[2].trim();
  }
  const pairs = (v) => {
    const o = {};
    for (const p of String(v || '').split(/\s+/)) {
      const i = p.indexOf('=');
      if (i > 0) o[p.slice(0, i)] = p.slice(i + 1);
    }
    return o;
  };
  const temps = pairs(kv.FCTEMPS);
  const fans = pairs(kv.FCFANS);
  const g = Object.fromEntries(['MINTEMP', 'MAXTEMP', 'MINSTART', 'MINSTOP', 'MINPWM', 'MAXPWM'].map((k) => [k, pairs(kv[k])]));
  const attr = (p) => (p.startsWith('/') ? p : path.basename(p).replace(/_input$/, ''));
  return Object.keys(temps)
    .sort(natural)
    .map((pwmPath) => ({
      pwm: path.basename(pwmPath),
      source: attr(temps[pwmPath]),
      fan: fans[pwmPath] ? attr(fans[pwmPath]) : null,
      minTemp: num(g.MINTEMP[pwmPath]),
      maxTemp: num(g.MAXTEMP[pwmPath]),
      minStart: num(g.MINSTART[pwmPath]),
      minStop: num(g.MINSTOP[pwmPath]),
      minPwm: num(g.MINPWM[pwmPath]) ?? 0,
      maxPwm: num(g.MAXPWM[pwmPath]) ?? 255,
      intervalSec: num(kv.INTERVAL),
    }));
}

const scalar = (v) => {
  const s = String(v).trim().replace(/^['"]|['"]$/g, '');
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~' || s === '') return null;
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : s;
};

/** Top-level YAML maps of scalars only (enough for the console's settings.yaml). */
function parseYamlBlocks(text) {
  const out = {};
  let cur = null;
  for (const line of String(text || '').split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const top = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (top) {
      if (top[2] === '') {
        cur = {};
        out[top[1]] = cur;
      } else {
        cur = null;
        out[top[1]] = scalar(top[2]);
      }
      continue;
    }
    const sub = /^ {2}([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (sub && cur) cur[sub[1]] = scalar(sub[2]);
  }
  return out;
}

const minToHm = (m) => (typeof m === 'number' ? `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}` : null);

/** The parts of the controller's device report (mca-dump) worth showing. */
function parseMca(d) {
  if (!d || typeof d !== 'object') return null;
  const st = d['speedtest-status'];
  const ips = d.ids_ips_rule;
  const wans = [];
  for (const [name, w] of Object.entries(d.uptime_stats || {})) {
    if (!w || typeof w !== 'object') continue;
    const seen = new Set();
    const monitors = [];
    for (const m of [...(w.monitors || []), ...(w.alerting_monitors || [])]) {
      const key = `${m.type}|${m.target}`;
      if (seen.has(key)) continue;
      seen.add(key);
      monitors.push({ target: m.target || null, type: m.type || null, availability: num(m.availability), latencyMs: num(m.latency_average) });
    }
    wans.push({ name, availability: num(w.availability), latencyMs: num(w.latency_average), monitors });
  }
  return {
    uplink: typeof d.uplink === 'string' ? d.uplink : null,
    ips: ips && typeof ips === 'object' ? { rules: num(ips.rule_count), type: ips.signature_type || null, updated: ips.update_time || null } : null,
    speedtest:
      st && st.rundate
        ? {
            at: st.rundate * 1000,
            downMbps: num(st.xput_download),
            upMbps: num(st.xput_upload),
            latencyMs: num(st.latency),
            server: [st.server && st.server.city, st.server && st.server.provider].filter(Boolean).join(', ') || null,
            iface: String(st.source_interface || '').replace(/^if!/, '') || null,
          }
        : null,
    wans,
    dpiEntries: Array.isArray(d.dpi_stats) ? d.dpi_stats.length : null,
    contentFiltering: (d.content_filtering_status && d.content_filtering_status.feature_status) || null,
    systemStats: d['system-stats'] ? { cpuPct: num(d['system-stats'].cpu), memPct: num(d['system-stats'].mem) } : null,
    temperatures: Array.isArray(d.temperatures) ? d.temperatures.map((t) => ({ name: t.name, type: t.type, c: num(t.value) })) : [],
    storage: Array.isArray(d.storage)
      ? d.storage.map((s) => ({ name: s.name || null, mount: s.mount_point || null, type: s.type || null, sizeBytes: num(s.size), usedBytes: num(s.used) }))
      : [],
    // per-port link and counters from the switch chip (sysfs shows the internal ports as always up)
    ports: Array.isArray(d.port_table)
      ? d.port_table
          .map((p) => ({
            idx: num(p.port_idx),
            name: p.name || null,
            media: p.media || null,
            up: p.up === true,
            enabled: p.enable !== false,
            speed: num(p.speed),
            fullDuplex: p.full_duplex === true,
            uplink: p.is_uplink === true,
            rxBytes: num(p.rx_bytes),
            txBytes: num(p.tx_bytes),
            rxErrors: num(p.rx_errors),
            txErrors: num(p.tx_errors),
            rxDropped: num(p.rx_dropped),
            txDropped: num(p.tx_dropped),
          }))
          .sort((a, b) => (a.idx ?? 99) - (b.idx ?? 99))
      : [],
    version: d.version || null,
    model: d.model_display || d.model || null,
  };
}

// ---------------------------------------------------------------- sources

/** Real host: files under /proc, /sys and the host root; commands via nsenter into the host. */
class FsSource {
  constructor({ procRoot = '/proc', sysRoot = '/sys', hostRoot = '/proc/1/root', nsenter = ['nsenter', '-t', '1', '-m', '-n', '--'] } = {}) {
    this.roots = { proc: procRoot, sys: sysRoot, host: hostRoot };
    this.nsenter = nsenter;
  }

  _p(kind, rel) {
    return path.join(this.roots[kind], rel || '');
  }

  read(kind, rel) {
    try {
      return fs.readFileSync(this._p(kind, rel), 'utf8');
    } catch {
      return null;
    }
  }

  list(kind, rel) {
    try {
      return fs.readdirSync(this._p(kind, rel));
    } catch {
      return [];
    }
  }

  exists(kind, rel) {
    try {
      fs.lstatSync(this._p(kind, rel));
      return true;
    } catch {
      return false;
    }
  }

  link(kind, rel) {
    try {
      return fs.readlinkSync(this._p(kind, rel));
    } catch {
      return null;
    }
  }

  real(kind, rel) {
    try {
      return fs.realpathSync(this._p(kind, rel));
    } catch {
      return null;
    }
  }

  exec(args, timeoutMs = 15000) {
    const [cmd, ...rest] = [...this.nsenter, ...args];
    return new Promise((resolve) => {
      childProcess.execFile(cmd, rest, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0;
        resolve({ code, stdout: stdout || '', stderr: String(stderr || (err && code === -1 ? err.message : '')) });
      });
    });
  }
}

/**
 * In-memory host for tests and the dev simulator:
 * { files: { 'proc/stat': '...' }, links: { 'sys/class/net/eth9/device/driver': '../al_eth' }, exec: { 'ethtool -m eth9': { stdout } } }
 * A function argument is called with the sample time on every refresh().
 */
class MemSource {
  constructor(snapOrGen) {
    this.gen = typeof snapOrGen === 'function' ? snapOrGen : null;
    this.snap = this.gen ? this.gen(Date.now()) : snapOrGen || {};
  }

  set(snap) {
    this.snap = snap;
  }

  refresh(t) {
    if (this.gen) this.snap = this.gen(t);
  }

  _keys() {
    return [...Object.keys(this.snap.files || {}), ...Object.keys(this.snap.links || {})];
  }

  read(kind, rel) {
    const v = (this.snap.files || {})[`${kind}/${rel}`];
    return v === undefined || v === null ? null : String(v);
  }

  list(kind, rel) {
    const pre = rel ? `${kind}/${rel.replace(/\/+$/, '')}/` : `${kind}/`;
    const out = new Set();
    for (const k of this._keys()) if (k.startsWith(pre)) out.add(k.slice(pre.length).split('/')[0]);
    return [...out];
  }

  exists(kind, rel) {
    const key = `${kind}/${rel}`;
    return key in (this.snap.files || {}) || key in (this.snap.links || {}) || this.list(kind, rel).length > 0;
  }

  link(kind, rel) {
    const v = (this.snap.links || {})[`${kind}/${rel}`];
    return v === undefined ? null : v;
  }

  real(kind, rel) {
    return this.link(kind, rel);
  }

  async exec(args) {
    const r = (this.snap.exec || {})[args.join(' ')];
    return r ? { code: 0, stderr: '', ...r } : { code: 1, stdout: '', stderr: 'not supported' };
  }
}

function detectPageSize() {
  try {
    const pages = Number(fs.readFileSync('/proc/self/statm', 'utf8').split(' ')[1]);
    const ratio = process.memoryUsage().rss / pages;
    for (const p of [4096, 16384, 65536]) if (pages > 0 && Math.abs(ratio - p) / p < 0.3) return p;
  } catch {
    /* not Linux */
  }
  return 4096;
}

// ---------------------------------------------------------------- collector

class Udm extends EventEmitter {
  constructor({
    source = null,
    procRoot,
    sysRoot,
    hostRoot,
    enabled = true,
    history = null,
    now = Date.now,
    hr = process.hrtime.bigint,
    log = console,
    fastMs = 10000,
    idleMs = 60000,
    slowMs = 60000,
    slowIdleMs = 300000,
    smartMs = 300000,
    ctlMs = 120000,
    ctlIdleMs = 1800000,
    recordMs = 60000,
    configMs = 3600000,
    pageSize = detectPageSize(),
  } = {}) {
    super();
    this.src = source || new FsSource({ procRoot, sysRoot, hostRoot });
    Object.assign(this, { enabled, history, now, hr, log, fastMs, idleMs, slowMs, slowIdleMs, smartMs, ctlMs, ctlIdleMs, recordMs, configMs, pageSize });
    this.available = false;
    this.viewers = 0;
    this.stopped = false;
    this.info = null;
    this.config = null;
    this.disks = [];
    this.fast = null;
    this.prev = null;
    this.sfp = {};
    this.sfpFail = new Map();
    this.smart = {};
    this.ctl = null;
    this.meta = new Map();
    this.containers = new Map();
    this.dockerRootsCache = null;
    this.linkCache = new Map();
    this.self = null;
    this.prevPorts = null;
    this.acc = new Map();
    this.timers = {};
    this.loops = {};
    this.busy = {};
    this.updated = {};
  }

  _refresh() {
    if (this.src.refresh) this.src.refresh(this.now());
  }

  _r(kind, rel) {
    const t = this.src.read(kind, rel);
    return t === null ? null : t.trim();
  }

  detect() {
    if (!this.enabled) return false;
    this._refresh();
    const sys = parseKv(this.src.read('proc', 'ubnthal/system.info'));
    this.available = Boolean(sys.shortname || sys.cpu);
    if (this.available) this.loadStatic(sys);
    return this.available;
  }

  loadStatic(sys = parseKv(this.src.read('proc', 'ubnthal/system.info'))) {
    const board = parseKv(this.src.read('proc', 'ubnthal/board'));
    const ver = parseVersion(this.src.read('host', 'usr/lib/version'));
    const spec = SPECS[sys.shortname] || null;
    const mfg = /^(\d{4})(\d{2})$/.exec(sys.mfgweek || '');
    this.info = {
      shortname: sys.shortname || null,
      model: spec ? spec.model : sys.shortname || 'UniFi console',
      boardRev: num(sys.boardrevision),
      boardId: board.boardid || null,
      bomRev: board.bomrev || null,
      made: mfg ? { year: Number(mfg[1]), week: Number(mfg[2]) } : null,
      cpu: sys.cpu || null,
      ramBytes: num(sys.ramsize),
      displays: num(sys.lcm_count),
      firmware: ver.firmware,
      build: ver.build,
      kernel: this._r('proc', 'sys/kernel/osrelease'),
      spec,
    };
  }

  readConfig() {
    const fan = parseFancontrol(this.src.read('host', 'etc/fancontrol'));
    for (const c of fan) {
      if (!c.source.startsWith('/')) continue;
      const v = num(this._r('host', c.source.slice(1)));
      c.sourceValue = v === null ? null : v > 1000 ? round(v / 1000, 1) : v;
    }
    const y = parseYamlBlocks(this.src.read('host', 'data/unifi-core/config/settings.yaml'));
    const lcm = y.lcmSettings && typeof y.lcmSettings === 'object' ? y.lcmSettings : null;
    const night = y.nightMode && typeof y.nightMode === 'object' ? y.nightMode : null;
    const led = y.ledSettings && typeof y.ledSettings === 'object' ? y.ledSettings : null;
    this.config = {
      fan,
      display:
        lcm || night
          ? {
              enabled: lcm ? lcm.enabled : null,
              brightness: lcm ? num(lcm.brightness) : null,
              night: night && (night.onMinute !== undefined || night.offMinute !== undefined) ? { from: minToHm(night.onMinute), to: minToHm(night.offMinute) } : null,
              led: led ? led.enabled : null,
            }
          : null,
    };
  }

  refreshDisks() {
    this.disks = this.src
      .list('sys', 'block')
      .filter((n) => !DISK_SKIP.test(n))
      .filter((n) => /^md\d+$/.test(n) || this.src.exists('sys', `block/${n}/device`))
      .sort(natural)
      .map((name) => {
        if (/^md\d+$/.test(name)) return { name, kind: 'md' };
        const real = this.src.real('sys', `block/${name}/device`) || '';
        return { name, kind: /\/usb\d*\//.test(real) || /usb/.test(real) ? 'usb' : /nvme/.test(name) ? 'nvme' : 'sata' };
      });
  }

  readCpuidle() {
    const out = {};
    const cpus = this.src
      .list('sys', 'devices/system/cpu')
      .filter((n) => /^cpu\d+$/.test(n))
      .sort(natural);
    for (const cpu of cpus) {
      const base = `devices/system/cpu/${cpu}/cpuidle`;
      const states = this.src
        .list('sys', base)
        .filter((n) => /^state\d+$/.test(n))
        .sort(natural)
        .map((st) => {
          const r = (f) => this._r('sys', `${base}/${st}/${f}`);
          return { name: r('name') || st, desc: r('desc'), latencyUs: num(r('latency')), residencyUs: num(r('residency')), timeUs: num(r('time')), usage: num(r('usage')), disabled: r('disable') === '1' };
        });
      if (states.length) out[cpu] = states;
    }
    return out;
  }

  readThermal() {
    return this.src
      .list('sys', 'class/thermal')
      .filter((n) => /^thermal_zone\d+$/.test(n))
      .sort(natural)
      .map((z) => {
        const r = (f) => this._r('sys', `class/thermal/${z}/${f}`);
        const type = r('type') || z;
        const trips = [];
        for (let i = 0; i < 16; i++) {
          const tt = r(`trip_point_${i}_temp`);
          if (tt === null) break;
          trips.push({ type: r(`trip_point_${i}_type`), c: milli(tt) });
        }
        return { id: z, type, label: ZONE_LABELS[type] || type, c: milli(r('temp')), policy: r('policy'), trips };
      });
  }

  readHwmon() {
    const chips = [];
    const ids = this.src
      .list('sys', 'class/hwmon')
      .filter((n) => /^hwmon\d+$/.test(n))
      .sort(natural);
    for (const h of ids) {
      const base = `class/hwmon/${h}`;
      let dir = base;
      let files = this.src.list('sys', dir);
      if (!files.some((f) => /_input$/.test(f))) {
        dir = `${base}/device`;
        files = this.src.list('sys', dir);
      }
      const name = this._r('sys', `${base}/name`) || this._r('sys', `${base}/device/name`) || h;
      const labels = CHIP_LABELS[name] || {};
      const r = (f) => this._r('sys', `${dir}/${f}`);
      const pick = (re) =>
        files
          .map((f) => re.exec(f))
          .filter(Boolean)
          .map((m) => m[1])
          .sort(natural);
      chips.push({
        id: h,
        name,
        temps: pick(/^(temp\d+)_input$/).map((id) => ({ id, label: r(`${id}_label`) || labels[id] || id, c: milli(r(`${id}_input`)), max: milli(r(`${id}_max`)), crit: milli(r(`${id}_crit`)), fault: r(`${id}_fault`) === '1' })),
        fans: pick(/^(fan\d+)_input$/).map((id) => ({ id, label: r(`${id}_label`) || labels[id] || id, rpm: num(r(`${id}_input`)), min: num(r(`${id}_min`)) })),
        pwms: pick(/^(pwm\d+)$/).map((id) => {
          const v = num(r(id));
          const en = num(r(`${id}_enable`));
          return { id, label: labels[id] || id, value: v, pct: v === null ? null : round((v / 255) * 100, 1), mode: en === null ? null : en === 0 ? 'full speed' : en === 1 ? 'manual' : 'automatic' };
        }),
        volts: pick(/^(in\d+)_input$/).map((id) => ({ id, label: r(`${id}_label`) || labels[id] || id, v: milli(r(`${id}_input`), 3), min: milli(r(`${id}_min`), 3), max: milli(r(`${id}_max`), 3) })),
      });
    }
    return chips;
  }

  /** Hide unconnected fan inputs and unused PWM outputs; note which temperature drives each fan. */
  fanView(chips) {
    const curves = (this.config && this.config.fan) || [];
    const byPwm = new Map(curves.map((c) => [c.pwm, c]));
    const byFan = new Map(curves.filter((c) => c.fan).map((c) => [c.fan, c]));
    for (const chip of chips) {
      const tempLabel = (src) => (src && src.startsWith('/') ? path.basename(src) : (chip.temps.find((x) => x.id === src) || {}).label || src);
      chip.fans = chip.fans
        .filter((f) => f.rpm > 0 || f.min > 0 || byFan.has(f.id) || !curves.length)
        .map((f) => ({ ...f, follows: byFan.has(f.id) ? tempLabel(byFan.get(f.id).source) : null, pwm: byFan.has(f.id) ? byFan.get(f.id).pwm : null }));
      chip.pwms = chip.pwms.filter((p) => !curves.length || byPwm.has(p.id)).map((p) => ({ ...p, follows: byPwm.has(p.id) ? tempLabel(byPwm.get(p.id).source) : null }));
    }
    return chips;
  }

  readLinks(names) {
    const out = {};
    for (const name of names) {
      const base = `class/net/${name}`;
      const r = (f) => this._r('sys', `${base}/${f}`);
      let st = this.linkCache.get(name);
      if (!st) {
        // driver, kind and MTU rarely change: read them once per config refresh
        const drv = this.src.link('sys', `${base}/device/driver`);
        st = {
          mtu: num(r('mtu')),
          driver: drv ? path.basename(drv) : null,
          kind: /^(eth|switch|sfp|lan|wan)\d+$/.test(name) || drv ? 'port' : name.includes('.') ? 'vlan' : this.src.exists('sys', `${base}/bridge`) ? 'bridge' : 'virtual',
        };
        this.linkCache.set(name, st);
      }
      const carrier = r('carrier');
      const speed = num(r('speed'));
      out[name] = {
        operstate: r('operstate'),
        carrier: carrier === null ? null : carrier === '1',
        speed: speed !== null && speed > 0 ? speed : null,
        duplex: r('duplex'),
        ...st,
      };
    }
    return out;
  }

  readProcs() {
    const out = new Map();
    for (const name of this.src.list('proc', '')) {
      if (!/^\d+$/.test(name)) continue;
      const st = parsePidStat(this.src.read('proc', `${name}/stat`));
      if (st) out.set(st.pid, st);
    }
    return out;
  }

  dockerRoots() {
    if (!this.dockerRootsCache) {
      const roots = ['var/lib/docker', 'data/docker', 'mnt/data/docker'];
      for (const v of this.src.list('host', 'volume')) roots.push(`volume/${v}/docker`);
      this.dockerRootsCache = roots.filter((r) => this.src.exists('host', `${r}/containers`));
    }
    return this.dockerRootsCache;
  }

  containerName(id) {
    if (this.containers.has(id)) return this.containers.get(id);
    let name = null;
    for (const root of this.dockerRoots()) {
      const txt = this.src.read('host', `${root}/containers/${id}/config.v2.json`);
      if (!txt) continue;
      try {
        name = String(JSON.parse(txt).Name || '').replace(/^\//, '') || null;
      } catch {
        name = null;
      }
      if (name) break;
    }
    name = name || id.slice(0, 12);
    this.containers.set(id, name);
    return name;
  }

  /** This container's own name and cgroup namespace (its processes show "/" as cgroup). */
  selfInfo() {
    if (!this.self) {
      const mi = this.src.read('proc', 'self/mountinfo') || '';
      const m = /\/containers\/([0-9a-f]{64})\//.exec(mi);
      this.self = { ns: this.src.link('proc', 'self/ns/cgroup'), name: m ? this.containerName(m[1]) : null };
    }
    return this.self;
  }

  procMeta(row) {
    let m = this.meta.get(row.key);
    if (!m) {
      const cmdRaw = this.src.read('proc', `${row.pid}/cmdline`);
      const cmd = cmdRaw ? redact(cmdRaw.replace(/\0+$/, '').split('\0').join(' ')).slice(0, 400) : '';
      let kind = 'other';
      let group = 'system';
      if (row.kthread) {
        kind = 'kernel';
        group = 'kernel';
      } else {
        const cg = parseCgroup(this.src.read('proc', `${row.pid}/cgroup`));
        const g = cgroupGroup(cg);
        if (g) {
          kind = g.kind;
          group = g.kind === 'container' ? this.containerName(g.id) : g.name;
        } else if (cg === '/') {
          const self = this.selfInfo();
          if (self.ns && this.src.link('proc', `${row.pid}/ns/cgroup`) === self.ns) {
            kind = 'container';
            group = self.name || 'this container';
          } else group = 'root cgroup';
        }
      }
      m = { cmd: cmd || `[${row.comm}]`, group, kind };
      this.meta.set(row.key, m);
    }
    return m;
  }

  sampleFast() {
    this._refresh();
    const t = this.now();
    const hr = this.hr();
    const stat = parseStat(this.src.read('proc', 'stat'));
    const idle = this.readCpuidle();
    const irqs = parseInterrupts(this.src.read('proc', 'interrupts'));
    const soft = parseSoftirqs(this.src.read('proc', 'softirqs'));
    const netdev = parseNetDev(this.src.read('proc', '1/net/dev') || this.src.read('proc', 'net/dev'));
    const disks = parseDiskstats(this.src.read('proc', 'diskstats'));
    const procs = this.readProcs();
    const prev = this.prev;
    const dt = prev ? Number(hr - prev.hr) / 1e9 : null;
    const uptimeSec = num((this._r('proc', 'uptime') || '').split(/\s+/)[0]);
    const load = (this._r('proc', 'loadavg') || '').split(/\s+/).slice(0, 3).map(num);

    // CPU: /proc/stat split and cpuidle residency per CPU
    const cpus = Object.keys(stat.cpus)
      .sort(natural)
      .map((name) => {
        const a = prev && prev.stat.cpus[name];
        const states = (idle[name] || []).map((s, i) => {
          const p = prev && prev.idle[name] && prev.idle[name][i] && prev.idle[name][i].name === s.name ? prev.idle[name][i] : null;
          const dTime = p && dt ? s.timeUs - p.timeUs : null;
          const dUse = p && dt ? s.usage - p.usage : null;
          return {
            name: s.name,
            desc: s.desc,
            latencyUs: s.latencyUs,
            residencyUs: s.residencyUs,
            disabled: s.disabled,
            pct: dTime !== null ? round(Math.min(100, Math.max(0, dTime / (dt * 1e6)) * 100), 2) : null,
            avgUs: dUse > 0 ? round(dTime / dUse, 0) : null,
            perSec: dUse !== null ? round(Math.max(0, dUse) / dt, 1) : null,
            bootPct: uptimeSec ? round(Math.min(100, (s.timeUs / (uptimeSec * 1e6)) * 100), 2) : null,
          };
        });
        const known = states.filter((s) => s.pct !== null);
        return {
          cpu: name,
          split: a ? cpuSplit(a, stat.cpus[name]) : null,
          boot: cpuSplit(null, stat.cpus[name]),
          idle: states,
          activePct: known.length ? round(Math.max(0, 100 - known.reduce((x, s) => x + s.pct, 0)), 2) : null,
        };
      });

    // interrupts and softirqs
    const prevIrq = new Map(prev ? prev.irqs.rows.map((r) => [`${r.id}|${r.name}`, r]) : []);
    const irqRows = irqs.rows
      .map((r) => {
        const p = prevIrq.get(`${r.id}|${r.name}`);
        return {
          id: r.id,
          name: r.name,
          chip: r.chip,
          total: r.total,
          rate: p ? rate(p.total, r.total, dt) : null,
          perCpu: p && dt ? r.counts.map((c, i) => rate(p.counts[i] || 0, c, dt)) : null,
        };
      })
      .sort((x, y) => (y.rate ?? -1) - (x.rate ?? -1) || y.total - x.total);
    const prevSoft = new Map(prev ? prev.soft.map((r) => [r.name, r]) : []);
    const softRows = soft.map((r) => {
      const p = prevSoft.get(r.name);
      return { name: r.name, total: r.total, rate: p ? rate(p.total, r.total, dt) : null, perCpu: p && dt ? r.counts.map((c, i) => rate(p.counts[i] || 0, c, dt)) : null };
    });

    // processes
    const rows = [];
    let threads = 0;
    for (const [pid, p] of procs) {
      threads += p.threads || 0;
      const q = prev && prev.procs.get(pid);
      const same = q && q.start === p.start;
      const cpuPct = same && dt ? round(Math.max(0, ((p.utime + p.stime - q.utime - q.stime) / HZ / dt) * 100), 2) : null;
      rows.push({
        pid,
        key: `${pid}:${p.start}`,
        comm: p.comm,
        state: p.state,
        ppid: p.ppid,
        threads: p.threads,
        cpuPct,
        cpuSec: round((p.utime + p.stime) / HZ, 0),
        rssMb: round((p.rss * this.pageSize) / 1048576, 1),
        kthread: pid === 2 || p.ppid === 2,
      });
    }
    const live = new Set(rows.map((r) => r.key));
    for (const k of this.meta.keys()) if (!live.has(k)) this.meta.delete(k);
    const active = rows.filter((r) => r.cpuPct > 0).sort((a, b) => b.cpuPct - a.cpuPct);
    const heavy = [...rows].sort((a, b) => b.cpuSec - a.cpuSec).slice(0, 25);
    const picked = new Map();
    for (const r of [...active.slice(0, 150), ...heavy]) picked.set(r.pid, r);
    const procRows = [...picked.values()].map((r) => {
      const m = this.procMeta(r);
      const { key, ...rest } = r;
      return { ...rest, ...m };
    });
    const groups = new Map();
    for (const r of procRows) {
      if (!(r.cpuPct > 0)) continue;
      const k = `${r.kind}|${r.group}`;
      const g = groups.get(k) || { group: r.group, kind: r.kind, cpuPct: 0, procs: 0 };
      g.cpuPct += r.cpuPct;
      g.procs += 1;
      groups.set(k, g);
    }

    // network
    const links = this.readLinks(Object.keys(netdev).filter((n) => !NOISE_IFACES.test(n)));
    const ifaces = Object.keys(links)
      .sort(natural)
      .map((name) => {
        const c = netdev[name];
        const p = prev && prev.netdev[name];
        const mbps = (a, b) => (p && dt ? round((Math.max(0, b - a) * 8) / dt / 1e6, 3) : null);
        return {
          name,
          ...links[name],
          rxMbps: mbps(p && p.rxBytes, c.rxBytes),
          txMbps: mbps(p && p.txBytes, c.txBytes),
          rxPps: p ? rate(p.rxPackets, c.rxPackets, dt) : null,
          txPps: p ? rate(p.txPackets, c.txPackets, dt) : null,
          errPerSec: p ? rate(p.rxErrs + p.txErrs, c.rxErrs + c.txErrs, dt, 2) : null,
          dropPerSec: p ? rate(p.rxDrop + p.txDrop, c.rxDrop + c.txDrop, dt, 2) : null,
          rxGB: round(c.rxBytes / 1e9, 1),
          txGB: round(c.txBytes / 1e9, 1),
          errors: c.rxErrs + c.txErrs,
          drops: c.rxDrop + c.txDrop,
        };
      });
    const ctEntries = parseConntrackStat(this.src.read('proc', '1/net/stat/nf_conntrack') || this.src.read('proc', 'net/stat/nf_conntrack'));

    // memory
    const mem = parseMeminfo(this.src.read('proc', 'meminfo'));
    const swaps = parseSwaps(this.src.read('proc', 'swaps'));
    const swapSize = swaps.reduce((a, s) => a + s.sizeKb, 0);
    const swapUsed = swaps.reduce((a, s) => a + s.usedKb, 0);
    const zram = this.src
      .list('sys', 'block')
      .filter((n) => /^zram\d+$/.test(n))
      .sort(natural)
      .map((dev) => {
        const f = (this._r('sys', `block/${dev}/mm_stat`) || '').split(/\s+/).map(num);
        const kb = (v) => (typeof v === 'number' ? Math.round(v / 1024) : null);
        return { dev, origKb: kb(f[0]), comprKb: kb(f[1]), usedKb: kb(f[2]), sizeKb: kb(num(this._r('sys', `block/${dev}/disksize`))) };
      });

    // storage
    const diskRows = this.disks.map((d) => {
      const c = disks[d.name];
      const p = prev && prev.disks[d.name];
      if (!c) return { ...d, missing: true };
      const kb = (a, b) => (p && dt ? round((Math.max(0, b - a) * 512) / 1024 / dt, 1) : null);
      return {
        ...d,
        readKBps: kb(p && p.readSectors, c.readSectors),
        writeKBps: kb(p && p.writeSectors, c.writeSectors),
        iops: p ? rate(p.reads + p.writes, c.reads + c.writes, dt) : null,
        busyPct: p && dt && d.kind !== 'md' ? round(Math.min(100, (Math.max(0, c.ioMs - p.ioMs) / (dt * 1000)) * 100), 1) : null,
        readGB: round((c.readSectors * 512) / 1e9, 1),
        writtenGB: round((c.writeSectors * 512) / 1e9, 1),
      };
    });

    this.fast = {
      t,
      dtSec: dt === null ? null : round(dt, 2),
      uptimeSec,
      cpu: {
        total: prev ? cpuSplit(prev.stat.total, stat.total) : null,
        boot: cpuSplit(null, stat.total),
        cpus,
        ctxPerSec: prev ? rate(prev.stat.ctxt, stat.ctxt, dt, 0) : null,
        irqPerSec: prev ? rate(prev.stat.intr, stat.intr, dt, 0) : null,
        forksPerSec: prev ? rate(prev.stat.processes, stat.processes, dt, 2) : null,
        running: stat.running,
        blocked: stat.blocked,
        load,
      },
      procs: {
        count: rows.length,
        kernel: rows.filter((r) => r.kthread).length,
        threads,
        rows: procRows,
        groups: [...groups.values()].map((g) => ({ ...g, cpuPct: round(g.cpuPct, 2) })).sort((a, b) => b.cpuPct - a.cpuPct),
      },
      irqs: { cpus: irqs.cpus, rows: irqRows.slice(0, 25) },
      softirqs: { rows: softRows },
      sensors: { thermal: this.readThermal(), hwmon: this.fanView(this.readHwmon()) },
      net: { conntrack: ctEntries === null ? null : { entries: ctEntries, max: num(this._r('proc', 'sys/net/netfilter/nf_conntrack_max')) }, ifaces },
      memory: {
        totalKb: mem.MemTotal ?? null,
        availableKb: mem.MemAvailable ?? null,
        cachedKb: mem.Cached ?? null,
        usedPct: mem.MemTotal ? round(((mem.MemTotal - (mem.MemAvailable ?? mem.MemFree ?? 0)) / mem.MemTotal) * 100, 1) : null,
        swapUsedPct: swapSize ? round((swapUsed / swapSize) * 100, 1) : null,
        swaps,
        zram,
      },
      storage: { disks: diskRows, md: parseMdstat(this.src.read('proc', 'mdstat')) },
      fanRunning: [...procs.values()].some((p) => p.comm === 'fancontrol'),
    };
    this.prev = { hr, stat, idle, irqs, soft, netdev, disks, procs };
    this.updated.fast = t;
    if (dt) this._accumulate(this.fast);
    return this.fast;
  }

  _accumulate(f) {
    const add = (k, v) => {
      if (typeof v !== 'number' || !Number.isFinite(v)) return;
      const a = this.acc.get(k) || [0, 0];
      a[0] += v;
      a[1] += 1;
      this.acc.set(k, a);
    };
    const c = f.cpu.total;
    if (c) {
      add('busy', c.busy);
      add('usr', c.user + c.nice);
      add('sys', c.system);
      add('iow', c.iowait);
      add('sirq', c.softirq);
    }
    const withIdle = f.cpu.cpus.filter((x) => x.activePct !== null);
    if (withIdle.length) {
      add('act', avg(withIdle.map((x) => x.activePct)));
      const names = [...new Set(withIdle.flatMap((x) => x.idle.map((s) => s.name)))];
      for (const n of names) add(`I:${n}`, avg(withIdle.map((x) => (x.idle.find((s) => s.name === n) || {}).pct)));
    }
    add('ctx', f.cpu.ctxPerSec);
    add('int', f.cpu.irqPerSec);
    add('mem', f.memory.usedPct);
    add('swap', f.memory.swapUsedPct);
    if (f.net.conntrack) add('ct', f.net.conntrack.entries);
    for (const z of f.sensors.thermal) add(`T:${z.label}`, z.c);
    for (const chip of f.sensors.hwmon) {
      for (const x of chip.temps) if (!x.fault) add(`T:${x.label}`, x.c);
      for (const x of chip.fans) add(`F:${x.label}`, x.rpm);
    }
    for (const i of f.net.ifaces) {
      if (i.kind !== 'port' || !i.carrier || !(i.rxGB + i.txGB > 0)) continue;
      add(`rx:${i.name}`, i.rxMbps);
      add(`tx:${i.name}`, i.txMbps);
    }
    for (const d of f.storage.disks) add(`db:${d.name}`, d.busyPct);
  }

  /** One history record per minute: means of the fast samples plus the latest slow readings. */
  record() {
    if (!this.history || !this.acc.size) return null;
    const rec = { t: this.now() };
    for (const [k, [s, n]] of this.acc) rec[k] = round(s / n, 3);
    this.acc = new Map();
    for (const [iface, m] of Object.entries(this.sfp)) {
      if (m.tempC !== null) rec[`T:SFP ${iface}`] = m.tempC;
      if (m.rxDbm !== null) rec[`rxp:${iface}`] = m.rxDbm;
      if (m.txDbm !== null) rec[`txp:${iface}`] = m.txDbm;
    }
    for (const [disk, s] of Object.entries(this.smart)) if (s && typeof s.tempC === 'number') rec[`T:${disk}`] = s.tempC;
    if (this.ctl && Array.isArray(this.ctl.ports) && rec.t - this.ctl.t < 900000) {
      for (const p of this.ctl.ports) {
        if (!p.up || typeof p.rxMbps !== 'number' || `rx:${p.name}` in rec) continue;
        rec[`rx:${p.name}`] = p.rxMbps;
        rec[`tx:${p.name}`] = p.txMbps;
      }
    }
    return this.history.addUdm(rec);
  }

  async sampleSlow() {
    this._refresh();
    const t = this.now();
    if (!this.updated.config || t - this.updated.config >= this.configMs) {
      this.loadStatic();
      this.readConfig();
      this.refreshDisks();
      this.linkCache.clear();
      this.updated.config = t;
    }
    const ports = this.fast ? this.fast.net.ifaces.filter((i) => i.kind === 'port' && i.driver).map((i) => i.name) : [];
    for (const iface of ports) {
      const failed = this.sfpFail.get(iface);
      if (failed && t - failed < 1800000) continue;
      const r = await this.src.exec(['ethtool', '-m', iface], 10000);
      const mod = r.code === 0 ? parseModule(r.stdout) : null;
      if (!mod) {
        this.sfpFail.set(iface, t);
        delete this.sfp[iface];
        continue;
      }
      this.sfpFail.delete(iface);
      this.sfp[iface] = { iface, ...mod, t };
    }
    for (const iface of Object.keys(this.sfp)) if (!ports.includes(iface)) delete this.sfp[iface];
    this.updated.sfp = t;
  }

  async sampleSmart() {
    this._refresh();
    const t = this.now();
    const next = {};
    for (const d of this.disks.filter((x) => x.kind === 'sata' || x.kind === 'nvme')) {
      const r = await this.src.exec(['smartctl', '-j', '-n', 'standby', '-i', '-A', '-H', `/dev/${d.name}`], 20000);
      let j = null;
      try {
        j = JSON.parse(r.stdout);
      } catch {
        j = null;
      }
      const prev = this.smart[d.name];
      if (!j) next[d.name] = { error: (r.stderr || 'smartctl returned no data').trim().slice(0, 200), t };
      else {
        const s = parseSmart(j);
        next[d.name] = s.powerMode === 'standby' && prev && !prev.error ? { ...prev, powerMode: 'standby', t } : { ...s, t };
      }
    }
    this.smart = next;
    this.updated.smart = t;
  }

  async sampleCtl() {
    this._refresh();
    const t = this.now();
    const r = await this.src.exec(['mca-dump'], 30000);
    let j = null;
    try {
      j = JSON.parse(r.stdout);
    } catch {
      j = null;
    }
    if (!j) {
      this.ctl = { ...(this.ctl || {}), error: (r.stderr || 'mca-dump returned no data').trim().slice(0, 200), t };
      return;
    }
    const ctl = { ...parseMca(j), t };
    const prev = this.prevPorts;
    if (prev && t > prev.t) {
      const dt = (t - prev.t) / 1000;
      const old = new Map(prev.ports.map((p) => [p.name, p]));
      for (const p of ctl.ports) {
        const o = old.get(p.name);
        if (!o) continue;
        const mbps = (a, b) => (Number.isFinite(a) && Number.isFinite(b) ? round((Math.max(0, b - a) * 8) / dt / 1e6, 3) : null);
        p.rxMbps = mbps(o.rxBytes, p.rxBytes);
        p.txMbps = mbps(o.txBytes, p.txBytes);
        p.errPerMin = Number.isFinite(o.rxErrors) && Number.isFinite(p.rxErrors) ? round((Math.max(0, p.rxErrors + (p.txErrors || 0) - o.rxErrors - (o.txErrors || 0)) / dt) * 60, 2) : null;
        p.rateSec = round(dt, 0);
      }
    }
    this.prevPorts = { t, ports: ctl.ports.map(({ name, rxBytes, txBytes, rxErrors, txErrors }) => ({ name, rxBytes, txBytes, rxErrors, txErrors })) };
    this.ctl = ctl;
    this.updated.ctl = t;
  }

  kpi() {
    const f = this.fast;
    if (!this.available || !f) return null;
    const zone = f.sensors.thermal.find((z) => z.c !== null);
    const fans = f.sensors.hwmon.flatMap((c) => c.fans).filter((x) => typeof x.rpm === 'number');
    const spinning = fans.filter((x) => x.rpm > 0);
    return {
      busyPct: f.cpu.total ? f.cpu.total.busy : null,
      socC: zone ? zone.c : null,
      fanRpm: fans.length ? (spinning.length ? Math.max(...spinning.map((x) => x.rpm)) : 0) : null,
      conntrack: f.net.conntrack ? f.net.conntrack.entries : null,
    };
  }

  snapshot() {
    if (!this.available) return { available: false };
    const f = this.fast;
    const uplink = this.ctl && this.ctl.uplink ? this.ctl.uplink : null;
    const wanPort = uplink ? uplink.split('.')[0] : null;
    return {
      available: true,
      t: this.now(),
      info: { ...this.info, uptimeSec: f ? f.uptimeSec : null },
      config: this.config ? { ...this.config, fanRunning: f ? f.fanRunning : null } : null,
      fast: f
        ? {
            ...f,
            net: {
              ...f.net,
              ifaces: f.net.ifaces.map((i) => {
                const port = this.ctl && Array.isArray(this.ctl.ports) ? this.ctl.ports.find((p) => p.name === i.name) : null;
                return { ...i, wan: i.name === uplink || i.name === wanPort, port: port || null };
              }),
            },
            storage: { ...f.storage, disks: f.storage.disks.map((d) => ({ ...d, smart: this.smart[d.name] || null })) },
          }
        : null,
      sfp: Object.values(this.sfp).sort((a, b) => natural(a.iface, b.iface)),
      ctl: this.ctl,
      updated: this.updated,
    };
  }

  // ------------------------------------------------------------ scheduling

  _arm(name, ms) {
    clearTimeout(this.timers[name]);
    const t = setTimeout(this.loops[name].tick, ms);
    if (t.unref) t.unref();
    this.timers[name] = t;
  }

  _loop(name, fn, interval, firstDelay) {
    const tick = async () => {
      this.timers[name] = null;
      if (!this.busy[name]) {
        this.busy[name] = true;
        try {
          await fn();
        } catch (e) {
          this.log.warn(`udm: ${name} sample failed (${e.message})`);
        } finally {
          this.busy[name] = false;
        }
      }
      if (!this.stopped) this._arm(name, interval());
    };
    this.loops[name] = { tick, interval };
    this._arm(name, firstDelay ?? interval());
  }

  start() {
    this.stopped = false;
    if (!this.detect()) return false;
    try {
      this.readConfig();
      this.refreshDisks();
      this.updated.config = this.now();
      this.sampleFast();
    } catch (e) {
      this.log.warn(`udm: first sample failed (${e.message})`);
    }
    this._loop('fast', () => this.sampleFast(), () => (this.viewers > 0 ? this.fastMs : this.idleMs));
    this._loop('slow', () => this.sampleSlow(), () => (this.viewers > 0 ? this.slowMs : this.slowIdleMs), 2000);
    this._loop('smart', () => this.sampleSmart(), () => this.smartMs, 4000);
    this._loop('ctl', () => this.sampleCtl(), () => (this.viewers > 0 ? this.ctlMs : this.ctlIdleMs), 15000);
    const rec = setInterval(() => this.record(), this.recordMs);
    if (rec.unref) rec.unref();
    this.timers.record = rec;
    return true;
  }

  /** A viewer arriving speeds sampling up at once and refreshes stale controller data. */
  setViewers(n) {
    const was = this.viewers;
    this.viewers = n;
    if (!this.available || this.stopped || !(was === 0 && n > 0)) return;
    for (const name of ['fast', 'slow']) if (this.loops[name] && !this.busy[name]) this._arm(name, 300);
    if (this.loops.ctl && !this.busy.ctl && (!this.updated.ctl || this.now() - this.updated.ctl > this.ctlMs)) this._arm('ctl', 1000);
  }

  stop() {
    this.stopped = true;
    for (const t of Object.values(this.timers)) clearTimeout(t);
    this.timers = {};
  }
}

module.exports = {
  Udm,
  FsSource,
  MemSource,
  SPECS,
  parse: {
    parseKv,
    parseVersion,
    parseStat,
    cpuSplit,
    parseInterrupts,
    parseSoftirqs,
    parseNetDev,
    parseDiskstats,
    parseMdstat,
    parseSwaps,
    parseMeminfo,
    parseConntrackStat,
    parsePidStat,
    parseCgroup,
    cgroupGroup,
    parseModule,
    parseSmart,
    parseFancontrol,
    parseYamlBlocks,
    parseMca,
    redact,
  },
};
