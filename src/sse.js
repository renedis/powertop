'use strict';
const { EventEmitter } = require('events');

/** Server-sent events fan-out; the number of open streams = viewers. */
class Hub extends EventEmitter {
  constructor({ heartbeatMs = 25000 } = {}) {
    super();
    this.heartbeatMs = heartbeatMs;
    this.clients = new Set();
    this.handler = this.handler.bind(this);
  }

  handler(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 5000\n\n');
    const client = { res };
    const hb = setInterval(() => res.write(': ping\n\n'), this.heartbeatMs);
    hb.unref();
    this.clients.add(client);
    // ServerResponse 'close' fires when the client goes away
    res.on('close', () => {
      clearInterval(hb);
      if (this.clients.delete(client)) this.emit('viewers', this.clients.size);
    });
    this.emit('viewers', this.clients.size);
    this.emit('connect', client);
  }

  send(event, data, only) {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of only ? [only] : this.clients) c.res.write(frame);
  }

  count() {
    return this.clients.size;
  }

  closeAll() {
    for (const c of [...this.clients]) c.res.end();
    this.clients.clear();
  }
}

module.exports = { Hub };
