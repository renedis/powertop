// Number and time formatting. Units follow the owner's convention: W and Wh.

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

export function watts(v) {
  if (!isNum(v)) return '–';
  const a = Math.abs(v);
  return a < 10 ? v.toFixed(2) : a < 100 ? v.toFixed(1) : v.toFixed(0);
}

export function signedWatts(v) {
  if (!isNum(v)) return '–';
  return `${v > 0 ? '+' : v < 0 ? '−' : '±'}${watts(Math.abs(v))}`;
}

export function pct(v, digits = 1) {
  return isNum(v) ? v.toFixed(digits) : '–';
}

export function rate(v) {
  if (!isNum(v)) return '–';
  return Math.abs(v) < 100 ? v.toFixed(1) : Math.round(v).toLocaleString('en-GB');
}

export function us(v) {
  if (!isNum(v)) return '–';
  if (v >= 1000) return `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)} ms/s`;
  return `${v.toFixed(v >= 100 ? 0 : 1)} µs/s`;
}

export function clock(t) {
  if (!t) return '–';
  return new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function dateTime(t) {
  if (!t) return '–';
  const d = new Date(t);
  return `${d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })} ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
}

export function duration(ms) {
  if (!isNum(ms)) return '–';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}:${String(s % 60).padStart(2, '0')}`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
}

/** Clock-style countdown: 0:47, 14:32, 1:02:05. */
export function countdown(ms) {
  if (!isNum(ms)) return '–';
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

export function ago(t, now = Date.now()) {
  if (!t) return 'never';
  const s = Math.round((now - new Date(t).getTime()) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
