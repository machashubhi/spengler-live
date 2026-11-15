// Where events come from. Both expose now() (newest data time, ms) and nextT().

export class ReplayFeed { // a finished match, played back against the clock
  constructor(events, speed = 1) {
    this.events = events; this.i = 0; this.speed = speed; this.playing = false; this.last = null;
    this.start = events[0]?.t ?? 0; this.end = events[events.length - 1]?.t ?? 0; this.vt = this.start;
  }
  play() { this.playing = true; this.last = null; }
  pause() { this.playing = false; }
  now() { return this.vt; }
  nextT() { return this.events[this.i]?.t ?? null; }
  tick(rnow) {
    if (this.playing) { if (this.last != null) this.vt += (rnow - this.last) * this.speed; }
    this.last = rnow;
    const out = [];
    while (this.i < this.events.length && this.events[this.i].t <= this.vt) out.push(this.events[this.i++]);
    return out;
  }
  seek(t) { this.vt = t; this.i = 0; this.last = null; return this.tick(performance.now()); }
}

export class LiveFeed { // rows pushed in by the page, a WebSocket or Server-Sent Events
  constructor(onRows) { this.onRows = onRows; this.offset = null; }
  now() { return Date.now() - (this.offset ?? 0); }
  nextT() { return null; }
  note(t) { const o = Date.now() - t; if (this.offset == null || o < this.offset) this.offset = o; }
  connect(url) {
    this.close();
    const handle = (data) => { try { const m = JSON.parse(data); this.onRows(Array.isArray(m) ? m : m.events || [m]); } catch { /* skip bad frame */ } };
    if (/^wss?:/.test(url)) {
      const open = () => {
        this.ws = new WebSocket(url);
        this.ws.onmessage = (m) => handle(m.data);
        this.ws.onclose = () => { this.retry = setTimeout(open, 3000); };
      };
      open();
    } else {
      this.es = new EventSource(url);
      this.es.onmessage = (m) => handle(m.data);
    }
  }
  close() {
    clearTimeout(this.retry);
    if (this.ws) { this.ws.onclose = null; this.ws.close(); }
    this.es?.close();
    this.ws = this.es = null;
  }
}
