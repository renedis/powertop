// API client. All calls go to the selected host: the local instance or a peer
// through /api/peer/<idx>/... on the local instance.

let prefix = '/api';

export function useHost(host) {
  prefix = host && host.idx !== undefined ? `/api/peer/${host.idx}` : '/api';
}

async function request(base, path, { method = 'GET', body } = {}) {
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const r = await fetch(`${base}/${path}`, init);
  let data = null;
  try {
    data = await r.json();
  } catch {
    data = null;
  }
  if (!r.ok && r.status !== 202) {
    const err = new Error((data && data.error) || `HTTP ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return data;
}

export const api = (path, opts) => request(prefix, path, opts);
export const localApi = (path, opts) => request('/api', path, opts);

/** EventSource on the selected host; handlers keyed by event name. */
export function connectEvents(handlers, onState) {
  const es = new EventSource(`${prefix}/events`);
  for (const [name, fn] of Object.entries(handlers)) {
    es.addEventListener(name, (e) => {
      try {
        fn(JSON.parse(e.data));
      } catch (err) {
        console.warn('event', name, err);
      }
    });
  }
  es.onopen = () => onState('live');
  es.onerror = () => onState(es.readyState === EventSource.CLOSED ? 'offline' : 'reconnecting');
  return es;
}
