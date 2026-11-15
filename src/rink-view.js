// SVG rink: hockey_rink geometry (src/rink.js), player tokens, puck, carrier tag, effects.
// Two ways to move things: place() for frames from the motion engine, tweens for the What-If game.
import { RINK_ICE, RINK_SVG } from './rink.js';
import { clamp, inIce, lerp, svg } from './util.js';

let seq = 0;
const R = 1.15; // token radius (m)

export class RinkView {
  constructor(model, ease = (t) => t) {
    this.model = model; this.ease = ease; this.id = `rk${++seq}`; this.tokens = new Map(); this.k = 1;
    const s = (this.svg = svg('svg', { viewBox: '-30.7 -15.7 61.4 31.4', class: 'rink', role: 'img' }));
    const defs = svg('defs', null, s);
    svg('path', { d: RINK_ICE }, svg('clipPath', { id: `${this.id}c` }, defs));
    const g = svg('linearGradient', { id: `${this.id}g`, x2: 0, y2: 1 }, defs);
    svg('stop', { class: 'ice-a' }, g); svg('stop', { offset: 1, class: 'ice-b' }, g);
    svg('g', null, s).innerHTML = RINK_SVG.replace('__ICE__', `url(#${this.id}g)`).replace('__CLIP__', `url(#${this.id}c)`);
    this.gShots = svg('g', { class: 'shotmap' }, s);
    this.gFx = svg('g', { class: 'fxl' }, s);
    this.gPlayers = svg('g', { class: 'players' }, s);
    this.pk = { el: svg('g', { class: 'puck' }, s), x: 0, y: 0, fx: 0, fy: 0, tx: 0, ty: 0, t0: 0, t1: 0, on: 0 };
    svg('circle', { r: 0.95, class: 'halo' }, this.pk.el); svg('circle', { r: 0.42, class: 'disc' }, this.pk.el);
    this.gTop = svg('g', { class: 'top' }, s);
    this.tag = svg('g', { class: 'tag' }, s);
    this.tagRect = svg('rect', { y: -0.85, height: 1.7, rx: 0.85 }, this.tag);
    this.tagText = svg('text', { y: 0.05 }, this.tag);
    this.carrier = null;
    new ResizeObserver(([e]) => { const w = e.contentRect.width; if (w) this.k = clamp(640 / w, 1, 1.75); }).observe(s);
  }
  token(id) {
    let tk = this.tokens.get(id);
    if (tk) return tk;
    const p = this.model.players.get(id) || { team: 'H', no: '' };
    const g = svg('g', { class: `tok ${p.team}${p.goalie ? ' goalie' : ''}` }, this.gPlayers);
    svg('circle', { r: R + 0.55, class: 'ring' }, g);
    svg('circle', { r: R, class: 'body' }, g);
    svg('text', { y: 0.06 }, g).textContent = p.no;
    svg('title', null, g).textContent = `#${p.no} ${p.name || ''}`;
    g.style.opacity = 0;
    tk = { id, g, x: 0, y: 0, fx: 0, fy: 0, tx: 0, ty: 0, t0: 0, t1: 0, op: 0, top: 1, fresh: true };
    this.tokens.set(id, tk);
    return tk;
  }
  clear() {
    this.tokens.forEach((tk) => tk.g.remove()); this.tokens.clear();
    this.gFx.textContent = ''; this.gShots.textContent = '';
    this.pk.on = 0; this.setCarrier(null);
  }
  /** Frame from the motion engine: everyone listed is on the ice, everyone else fades out. */
  place(sample) {
    for (const [id, x, y] of sample.players) {
      const tk = this.token(id);
      tk.x = tk.fx = tk.tx = x; tk.y = tk.fy = tk.ty = y; tk.t1 = 0; tk.top = 1;
    }
    this.tokens.forEach((tk) => { if (!sample.ids.has(tk.id)) tk.top = 0; });
    const p = this.pk;
    if (sample.puck) { [p.x, p.y] = sample.puck; p.fx = p.tx = p.x; p.fy = p.ty = p.y; p.t1 = 0; p.on = 1; } else p.on = 0;
    this.setCarrier(sample.carrier);
  }
  /** Tween (What-If game). */
  setPositions(list, dur, now) {
    for (const [id, x, y] of list) {
      const tk = this.token(id);
      if (tk.fresh || dur <= 0) { tk.x = tk.fx = tk.tx = x; tk.y = tk.fy = tk.ty = y; tk.t1 = 0; tk.fresh = false; if (dur <= 0) tk.op = 1; } else {
        tk.fx = tk.x; tk.fy = tk.y; tk.tx = x; tk.ty = y; tk.t0 = now; tk.t1 = now + dur;
      }
      tk.top = 1;
    }
  }
  movePuck(to, dur, now, from) {
    const p = this.pk;
    if (from) [p.x, p.y] = from;
    if (!p.on || dur <= 0) [p.x, p.y] = to;
    Object.assign(p, { fx: p.x, fy: p.y, tx: to[0], ty: to[1], t0: now, t1: now + Math.max(0, dur), on: 1 });
  }
  setCarrier(id) {
    if (this.carrier === id) return;
    this.tokens.get(this.carrier)?.g.classList.remove('carrier');
    this.carrier = id;
    this.tokens.get(id)?.g.classList.add('carrier');
    const lbl = id != null ? this.model.label(id) : '';
    if (lbl !== this.tagText.textContent) {
      this.tagText.textContent = lbl;
      const w = (this.tagW = lbl.length * 0.62 + 1.4);
      this.tagRect.setAttribute('width', w); this.tagRect.setAttribute('x', -w / 2);
    }
  }
  highlight(id) {
    const tk = this.tokens.get(id);
    if (!tk) return false;
    tk.g.classList.remove('hl'); void tk.g.getBBox(); tk.g.classList.add('hl');
    clearTimeout(tk.hlT); tk.hlT = setTimeout(() => tk.g.classList.remove('hl'), 4000);
    return tk.top === 1;
  }
  fx(tag, attrs, life) {
    const e = svg(tag, attrs, this.gFx);
    e.style.animationDuration = `${life}ms`;
    setTimeout(() => e.remove(), life);
  }
  line(a, b, cls, life = 1400) { if (a && b) this.fx('line', { x1: a[0], y1: -a[1], x2: b[0], y2: -b[1], class: `fx ${cls}` }, life); }
  ring(p, cls, r, life = 1200) { if (p) this.fx('circle', { cx: p[0], cy: -p[1], r, class: `fx ${cls}` }, life); }
  addShot(ev) {
    if (!ev.start) return;
    const c = svg('circle', { cx: ev.start[0], cy: -ev.start[1], r: 0.35 + 1.7 * Math.sqrt(ev.xg || 0.01), class: `shot ${ev.team} ${String(ev.res).toLowerCase()}` }, this.gShots);
    svg('title', null, c).textContent = `${this.model.label(ev.p1)} · ${ev.res}${ev.xg != null ? ` · ${ev.xg.toFixed(2)} xG` : ''}`;
  }
  toSvg(cx, cy) {
    const m = this.svg.getScreenCTM();
    if (!m) return [0, 0];
    const p = new DOMPoint(cx, cy).matrixTransform(m.inverse());
    return [p.x, -p.y];
  }
  render(now) {
    const k = this.k.toFixed(2);
    this.tokens.forEach((tk) => {
      if (tk.t1) { const e = this.ease(clamp((now - tk.t0) / (tk.t1 - tk.t0), 0, 1)); tk.x = lerp(tk.fx, tk.tx, e); tk.y = lerp(tk.fy, tk.ty, e); }
      tk.op += (tk.top - tk.op) * 0.18;
      if (Math.abs(tk.top - tk.op) < 0.01) tk.op = tk.top;
      const [x, y] = inIce(tk.x, tk.y, 0.3 + 0.6 * this.k);
      tk.g.setAttribute('transform', `translate(${x.toFixed(2)} ${(-y).toFixed(2)}) scale(${k})`);
      tk.g.style.opacity = tk.op.toFixed(2);
    });
    const p = this.pk;
    if (p.t1) { const e = this.ease(clamp((now - p.t0) / (p.t1 - p.t0), 0, 1)); p.x = lerp(p.fx, p.tx, e); p.y = lerp(p.fy, p.ty, e); }
    const [px, py] = inIce(p.x, p.y, 0.45);
    p.el.setAttribute('transform', `translate(${px.toFixed(2)} ${(-py).toFixed(2)}) scale(${Math.min(this.k, 1.4).toFixed(2)})`);
    p.el.style.opacity = p.on;
    const c = this.tokens.get(this.carrier);
    if (c && c.op > 0.5 && this.tagText.textContent) {
      const o = 2.4 * this.k, y = c.y > 14 - o ? c.y - o : c.y + o;
      const half = 29.6 - (this.tagW * this.k) / 2;
      this.tag.setAttribute('transform', `translate(${clamp(c.x, -half, half).toFixed(2)} ${(-y).toFixed(2)}) scale(${k})`);
      this.tag.style.opacity = 1;
    } else this.tag.style.opacity = 0;
  }
}
