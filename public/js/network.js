// Tiny event-emitter WebSocket wrapper.
export class Network {
  constructor() {
    this.handlers = new Map();
    this.ws = null;
    this.queue = [];
    this.connected = false;
  }

  connect(url) {
    this.ws = new WebSocket(url);
    this.ws.addEventListener('open', () => {
      this.connected = true;
      for (const m of this.queue) this.ws.send(m);
      this.queue.length = 0;
      this._fire('open');
    });
    this.ws.addEventListener('close', () => {
      this.connected = false;
      this._fire('close');
    });
    this.ws.addEventListener('message', (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      this._fire(msg.type, msg);
    });
  }

  send(msg) {
    const data = JSON.stringify(msg);
    if (this.connected) this.ws.send(data);
    else this.queue.push(data);
  }

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(fn);
  }

  _fire(type, payload) {
    const list = this.handlers.get(type);
    if (list) for (const fn of list) fn(payload);
  }
}
