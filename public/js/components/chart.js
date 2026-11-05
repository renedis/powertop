// uPlot wrapper in the scope theme: graticule grid, channel colours, one y-axis.
/* global uPlot */

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export const CHANNELS = {
  wall: { label: 'Wall', color: '--ch-wall', stepped: true },
  psys: { label: 'Platform', color: '--ch-psys' },
  pkg: { label: 'Package', color: '--ch-pkg' },
  core: { label: 'Core', color: '--ch-core' },
  dram: { label: 'DRAM', color: '--ch-dram' },
};
export const CHANNEL_ORDER = ['wall', 'psys', 'pkg', 'core', 'dram'];

const pad = (n) => String(n).padStart(2, '0');
const lastOf = (arr) => {
  for (let i = (arr ? arr.length : 0) - 1; i >= 0; i--) if (arr[i] !== null && arr[i] !== undefined) return arr[i];
  return null;
};

/** 24-hour ticks; the date is added when the visible range spans days. */
function timeTicks(splits) {
  if (!splits.length) return [];
  const multiDay = splits[splits.length - 1] - splits[0] > 36 * 3600;
  const subMinute = splits.length > 1 && splits[1] - splits[0] < 60;
  return splits.map((s) => {
    const d = new Date(s * 1000);
    const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}${subMinute ? `:${pad(d.getSeconds())}` : ''}`;
    return multiDay ? `${d.getDate()} ${d.toLocaleString('en-GB', { month: 'short' })} ${hm}` : hm;
  });
}

function stamp(sec) {
  const d = new Date(sec * 1000);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString('en-GB') : `${d.getDate()} ${d.toLocaleString('en-GB', { month: 'short' })} ${d.toLocaleTimeString('en-GB')}`;
}

function niceMax(v) {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

/**
 * series: [{ label, color (css var name or colour), stepped }]
 * fmt: value formatter for axis + legend; unit appended in the legend.
 * markers: () => [{ t (ms), text }] drawn as dashed amber verticals.
 * xRange: () => [minSec, maxSec] pins the time window (kept until the user zooms).
 */
function autoRange(min, max) {
  if (min === null || max === null || !Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  const span = max - min || Math.max(1, Math.abs(max) * 0.1);
  const pad = span * 0.15;
  return [Math.floor((min - pad) * 10) / 10, Math.ceil((max + pad) * 10) / 10];
}

/** yAuto: fit the y-axis to the data instead of starting at zero (temperatures, dBm). */
export function lineChart(el, { series, height = 220, unit = '', fmt = (v) => String(v), markers = null, zoom = false, legend = true, yMax = null, yAuto = false, xRange = null }) {
  el.innerHTML = '';
  const silk = css('--silk');
  const grid = css('--graticule');
  const amber = css('--amber');
  const screen = css('--screen');
  const font = '12px "Barlow Semi Condensed", system-ui, sans-serif';
  const axis = { stroke: silk, font, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid, width: 1, size: 4 } };
  const tip = document.createElement('div');
  tip.className = 'tag';
  tip.style.cssText = 'position:absolute;pointer-events:none;display:none;background:var(--bezel-2);z-index:2;white-space:nowrap';

  const opts = {
    width: Math.max(200, el.clientWidth),
    height,
    legend: { show: legend, live: true },
    cursor: { drag: { x: zoom, y: false, setScale: zoom }, points: { size: 7, fill: screen }, focus: { prox: 16 } },
    focus: { alpha: 0.35 },
    scales: {
      x: { time: true },
      y: { range: (u, min, max) => (yAuto ? autoRange(min, max) : [0, yMax ?? niceMax((max || 0) * 1.08)]) },
    },
    axes: [
      { ...axis, values: (u, splits) => timeTicks(splits) },
      { ...axis, size: 62, values: (u, vals) => vals.map((v) => `${+v.toFixed(2)}${unit ? ` ${unit}` : ''}`) },
    ],
    series: [
      {
        label: 'Time',
        value: (u, v, si, idx) => {
          const t = idx == null ? lastOf(u.data[0]) : v;
          return t == null ? '–' : `${idx == null ? 'latest ' : ''}${stamp(t)}`;
        },
      },
      ...series.map((s) => ({
        label: s.label,
        stroke: s.color.startsWith('--') ? css(s.color) : s.color,
        width: 2,
        // lone samples are invisible as a line, so draw them as points
        points: { show: (u, si, i0, i1) => i1 - i0 < 3, size: 6 },
        spanGaps: false,
        paths: s.stepped ? uPlot.paths.stepped({ align: 1 }) : undefined,
        value: (u, v, si, idx) => {
          const x = idx == null ? lastOf(u.data[si]) : v;
          return x == null ? '–' : `${fmt(x)}${unit ? ` ${unit}` : ''}`;
        },
      })),
    ],
    hooks: {
      draw: [
        (u) => {
          const ms = markers ? markers() : [];
          if (!ms.length) return;
          const { ctx, bbox } = u;
          ctx.save();
          ctx.strokeStyle = amber;
          ctx.lineWidth = Math.max(1, devicePixelRatio);
          ctx.setLineDash([4 * devicePixelRatio, 3 * devicePixelRatio]);
          for (const m of ms) {
            const x = Math.round(u.valToPos(m.t / 1000, 'x', true));
            if (x < bbox.left || x > bbox.left + bbox.width) continue;
            ctx.beginPath();
            ctx.moveTo(x, bbox.top);
            ctx.lineTo(x, bbox.top + bbox.height);
            ctx.stroke();
          }
          ctx.restore();
        },
      ],
      setScale: [
        (u, key) => {
          if (key === 'x' && !programmatic) userZoomed = true;
        },
      ],
      setCursor: [
        (u) => {
          const ms = markers ? markers() : [];
          const left = u.cursor.left;
          if (!ms.length || left == null || left < 0) {
            tip.style.display = 'none';
            return;
          }
          const hit = ms.find((m) => Math.abs(u.valToPos(m.t / 1000, 'x') - left) < 5);
          if (!hit) {
            tip.style.display = 'none';
            return;
          }
          tip.textContent = hit.text;
          tip.style.display = 'block';
          tip.style.left = `${Math.min(left + 10, u.over.clientWidth - 220)}px`;
          tip.style.top = '6px';
        },
      ],
    },
  };
  let u = null;
  let ro = null;
  let userZoomed = false;
  let programmatic = false;
  const pinX = () => {
    const r = xRange ? xRange() : null;
    if (!u || !r || userZoomed) return;
    programmatic = true;
    u.setScale('x', { min: r[0], max: r[1] });
    programmatic = false;
  };
  return {
    setData(xs, cols) {
      if (!xs.length) {
        if (u) {
          u.destroy();
          u = null;
        }
        el.innerHTML = '';
        return false;
      }
      const data = [xs, ...cols];
      if (!u) {
        el.innerHTML = '';
        programmatic = true;
        u = new uPlot(opts, data, el);
        programmatic = false;
        u.over.appendChild(tip);
        u.over.addEventListener('dblclick', () => {
          userZoomed = false;
          setTimeout(pinX, 0);
        });
        ro = new ResizeObserver(() => u && u.setSize({ width: Math.max(200, el.clientWidth), height }));
        ro.observe(el);
      } else {
        programmatic = true;
        u.setData(data, !userZoomed);
        programmatic = false;
      }
      pinX();
      // show the latest values in the legend while the cursor is elsewhere
      if (u.cursor.idx == null) u.setLegend({ idx: null });
      return true;
    },
    redraw() {
      if (u) u.redraw(false);
    },
    destroy() {
      if (ro) ro.disconnect();
      if (u) u.destroy();
      u = null;
    },
  };
}

/** Align live RAPL samples and stepwise wall points on one time axis. */
export function liveColumns(live, keys) {
  const rapl = live.rapl || [];
  const wall = live.wall || [];
  let ts = rapl.map((s) => s.t);
  if (!ts.length && wall.length) {
    ts = wall.map((p) => p.t);
    ts.push(Date.now());
  }
  const cols = keys.map((k) => {
    if (k !== 'wall') return rapl.length ? rapl.map((s) => (s[k] ?? null)) : ts.map(() => null);
    let i = -1;
    return ts.map((t) => {
      while (i + 1 < wall.length && wall[i + 1].t <= t) i++;
      return i >= 0 && t - wall[i].t < 600000 ? wall[i].v : null;
    });
  });
  return { xs: ts.map((t) => t / 1000), cols };
}
