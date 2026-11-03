// Minimal state container: set() merges and notifies with the changed keys.

export function createStore(initial) {
  let state = initial;
  const subs = new Set();
  return {
    get: () => state,
    set(patch) {
      state = { ...state, ...patch };
      const keys = Object.keys(patch);
      subs.forEach((fn) => fn(state, keys));
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

export const LIVE_MS = 10 * 60 * 1000;

/** Append and trim a time series to the live window (keeps one point before it). */
export function appendLive(list, point, now = Date.now()) {
  const next = list.concat(point);
  const cutoff = now - LIVE_MS;
  let i = 0;
  while (i < next.length - 1 && next[i + 1].t < cutoff) i++;
  return i ? next.slice(i) : next;
}
