// Tagged template that escapes every interpolation unless it is already
// trusted markup (another html`` result or raw()).

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ESC[c]);

class Safe {
  constructor(s) {
    this.s = s;
  }
  toString() {
    return this.s;
  }
}

export const raw = (s) => new Safe(String(s));

function value(v) {
  if (v === null || v === undefined || v === false) return '';
  if (v instanceof Safe) return v.s;
  if (Array.isArray(v)) return v.map(value).join('');
  return esc(v);
}

export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += value(values[i]) + strings[i + 1];
  return new Safe(out);
}

export function render(el, tpl) {
  if (el) el.innerHTML = tpl instanceof Safe ? tpl.s : esc(tpl ?? '');
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
