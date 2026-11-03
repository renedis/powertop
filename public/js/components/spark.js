// Tiny trend line for the readout strip.
import { html } from '../lib/html.js';

export function spark(values, color) {
  const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x));
  if (v.length < 2) return html`<svg class="spark" aria-hidden="true"></svg>`;
  const w = 120;
  const h = 22;
  let min = Math.min(...v);
  let max = Math.max(...v);
  if (max - min < 0.05) {
    min -= 0.05;
    max += 0.05;
  }
  const n = values.length - 1;
  const pts = [];
  values.forEach((y, i) => {
    if (typeof y !== 'number' || !Number.isFinite(y)) return;
    pts.push(`${((i / n) * w).toFixed(1)},${(h - 2 - ((y - min) / (max - min)) * (h - 4)).toFixed(1)}`);
  });
  return html`<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><polyline fill="none" style="stroke:${color}" stroke-width="1.5" vector-effect="non-scaling-stroke" points="${pts.join(' ')}"/></svg>`;
}
