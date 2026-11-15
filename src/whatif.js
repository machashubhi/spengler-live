// "What If?": take the puck three passes before a real goal and try to build a better chance.
import { RinkView } from './rink-view.js';
import { scenarioStart } from './scenario.js';
import { GOAL_X, add, angDiff, clamp, dist, easeInOut, esc, lerp, mmss, ordinal, sigmoid, stepTo, store, svg, unit } from './util.js';

// Arcade physics (m, s). The interception model is calibrated on this game's 602 passes: its average
// risk (14%) matches the real interception rate (13%), and passes that were intercepted score ~2x riskier.
const G = {
  PUCK: 19, SHOT: 32, DEF: 5.6, ATT: 5, GOALIE: 2.4, REACT: 0.3, REACH: 1.2, LUNGE: 3.5, SKIP: 1.8,
  B0: -1.2, B1: -1.2, PASSES: 6, BOOST: 1.8, ANIM: 1.15,
};
const STAR = 'M0 -1.1L.32 -.34H1.1L.47 .13L.7 .9L0 .44L-.7 .9L-.47 .13L-1.1 -.34H-.32Z';

export class WhatIfGame {
  constructor(host) {
    this.host = host; this.model = host.model; this.root = host.$('.whatif');
    const q = (s) => this.root.querySelector(s);
    this.el = {
      title: q('.wi-title'), sub: q('.wi-sub'), chips: q('.wi-chips'), count: q('.wi-count'), you: q('.wi-you'), step: q('.wi-step'),
      hint: q('.wi-hint'), shoot: q('.wi-shoot'), real: q('.wi-real'), reset: q('.wi-reset'), result: q('.wi-result'),
      locked: q('.wi-locked'), body: q('.wi-body'), overlay: q('.wi-rink .overlay'), tally: q('.wi-tally'),
    };
    this.view = new RinkView(this.model, easeInOut);
    this.view.svg.classList.add('play');
    q('.wi-rink').prepend(this.view.svg);
    const top = this.view.gTop;
    this.aim = svg('line', { class: 'aim' }, top);
    this.aimLbl = svg('g', { class: 'aimlbl' }, top);
    this.aimRect = svg('rect', { y: -0.95, height: 1.9, rx: 0.5 }, this.aimLbl);
    this.aimText = svg('text', { y: 0.05 }, this.aimLbl);
    this.net = svg('rect', { x: GOAL_X - 0.4, y: -2.2, width: 2.6, height: 4.4, rx: 0.8, class: 'net' }, top);
    this.scenarios = []; this.scn = null; this.idx = -1; this.gen = 0; this.best = store.get('spengler-whatif', {});
    this.el.shoot.onclick = () => this.shoot();
    this.el.real.onclick = () => this.watchReal();
    this.el.reset.onclick = () => this.reset();
    this.el.chips.onclick = (e) => { const b = e.target.closest('[data-i]'); if (b) this.select(+b.dataset.i); };
    this.bindPointer();
  }

  setScenarios(list, latest) {
    this.scenarios = list;
    this.el.locked.hidden = !!list.length; this.el.body.hidden = !list.length;
    if (!list.length) { this.scn = null; this.idx = -1; this.el.count.textContent = ''; this.chips(); return; }
    const keep = list.findIndex((s) => s === this.scn);
    if (latest || keep < 0) this.select(list.length - 1); else this.chips();
  }
  chips() {
    const { home, away } = this.model.meta;
    this.el.chips.innerHTML = this.scenarios.map((s, i) => {
      const n = this.best[s.key] || 0;
      return `<button type="button" role="tab" class="chip" data-i="${i}" aria-selected="${i === this.idx}"><span><i class="dot ${s.team}"></i>${esc((s.team === 'H' ? home : away).code)} · ${esc(this.model.short(s.scorer))}</span><small>P${s.moment.period} ${mmss(s.moment.clock)}<b>${'★'.repeat(n)}${'☆'.repeat(3 - n)}</b></small></button>`;
    }).join('');
    const total = Object.values(this.best).reduce((a, b) => a + b, 0);
    this.el.tally.textContent = this.scenarios.length ? `★ ${total} / ${this.scenarios.length * 3}` : '';
  }
  select(i) {
    if (!this.scenarios[i]) return;
    this.idx = i; this.scn = this.scenarios[i];
    const s = this.scn, m = s.moment, { home, away } = this.model.meta, team = this.model.team(s.team);
    const kind = { PP: 'power-play goal', SH: 'short-handed goal', EN: 'empty-net goal' }[m.strength] || 'goal';
    this.el.title.textContent = `${this.model.short(s.scorer)}'s ${kind}`;
    this.el.sub.innerHTML = `${esc(team.name)} · ${ordinal(m.period)} period ${mmss(m.clock)} · made it <b>${esc(home.code)} ${m.score.H}–${m.score.A} ${esc(away.code)}</b><br>Real build-up: ${esc(s.chain.join(' → '))} · ${s.realXg != null ? `${s.realXg.toFixed(2)} xG` : 'empty net'}`;
    this.el.count.textContent = `${i + 1} / ${this.scenarios.length}`;
    this.el.you.innerHTML = `<i class="dot ${s.team}"></i>You play ${esc(team.name)}`;
    this.chips();
    const c = this.el.chips, b = c.querySelector(`[data-i="${i}"]`); // centre the chip by scrolling the strip only, never the page
    if (b) c.scrollTo({ left: c.scrollLeft + b.getBoundingClientRect().left - c.getBoundingClientRect().left - (c.clientWidth - b.offsetWidth) / 2, behavior: 'smooth' });
    this.reset();
  }
  reset() {
    if (!this.scn) return;
    this.gen++; this.replay = null; this.busy = this.over = false; this.passes = 0; this.lateral = false;
    const st = scenarioStart(this.scn, this.model), team = this.scn.team, v = this.view, now = performance.now();
    this.pos = new Map(st.players.map((p) => [p.id, [p.x, p.y]]));
    this.att = st.players.filter((p) => p.team === team && !p.goalie).map((p) => p.id);
    this.def = st.players.filter((p) => p.team !== team && !p.goalie).map((p) => p.id);
    this.goalie = st.players.find((p) => p.team !== team && p.goalie)?.id ?? null;
    this.carrier = st.carrier; this.puck = st.puck;
    v.clear();
    v.setPositions(st.players.map((p) => [p.id, p.x, p.y]), 0, now);
    v.tokens.forEach((tk, id) => tk.g.classList.toggle('att', this.att.includes(id)));
    v.movePuck(this.puck, 0, now); v.setCarrier(this.carrier);
    if (this.scn.realShot) {
      const g = svg('g', { class: 'ghost', transform: `translate(${this.scn.realShot[0]} ${-this.scn.realShot[1]})` }, v.gShots);
      svg('path', { d: STAR }, g); svg('title', null, g).textContent = 'Where the real goal was scored from';
    }
    this.net.style.display = ''; this.hideAim(); this.overlay();
    this.el.result.textContent = ''; this.el.result.className = 'wi-result';
    this.el.shoot.disabled = this.el.real.disabled = false;
    this.hud();
    this.hint(`You have the puck with <b>${esc(this.model.label(this.carrier))}</b>. Tap a teammate to pass, or drag from the puck to aim. Tap the net to shoot.`);
  }
  hud() {
    const q = this.quality(this.puck);
    this.el.step.textContent = `Passes ${this.passes}/${G.PASSES} · shot now ${q.xg.toFixed(2)} xG`;
    this.el.shoot.innerHTML = `Shoot <small>${q.xg.toFixed(2)} xG</small>`;
  }
  hint(html) { this.el.hint.innerHTML = html; }
  overlay(html, cls = '') {
    const o = this.el.overlay;
    o.hidden = !html;
    if (html) { o.innerHTML = html; o.className = `overlay ${cls}`; }
  }
  wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

  // ---- input: tap a teammate / the net, or drag from the puck
  bindPointer() {
    const s = this.view.svg;
    const target = (p) => {
      let id = null, bd = 2.8;
      for (const a of this.att) { if (a === this.carrier) continue; const d = dist(p, this.pos.get(a)); if (d < bd) { bd = d; id = a; } }
      if (id != null) return { pass: id, at: this.pos.get(id) };
      return p[0] > GOAL_X - 2.2 && p[0] < GOAL_X + 3 && Math.abs(p[1]) < 3.2 ? { at: [GOAL_X, 0] } : null;
    };
    const idle = () => this.scn && !this.busy && !this.over;
    s.onpointerdown = (e) => {
      if (!idle()) return;
      const p = this.view.toSvg(e.clientX, e.clientY);
      this.drag = { p, moved: false, fromPuck: dist(p, this.puck) < 2.8 };
      s.setPointerCapture?.(e.pointerId);
      if (this.drag.fromPuck) e.preventDefault();
    };
    s.onpointermove = (e) => {
      if (!idle()) return;
      const p = this.view.toSvg(e.clientX, e.clientY), t = target(p), d = this.drag;
      if (d && dist(p, d.p) > 0.9) d.moved = true;
      if (d ? d.fromPuck && d.moved : e.pointerType === 'mouse') { if (t || d) this.showAim(t ? t.at : p, t); else this.hideAim(); }
    };
    s.onpointerup = (e) => {
      const d = this.drag; this.drag = null; this.hideAim();
      if (!d || !idle() || (d.moved && !d.fromPuck)) return;
      const t = target(this.view.toSvg(e.clientX, e.clientY));
      if (t) { if (t.pass != null) this.pass(t.pass); else this.shoot(); }
    };
    s.onpointercancel = () => { this.drag = null; this.hideAim(); };
    s.onpointerleave = (e) => { if (!this.drag && e.pointerType === 'mouse') this.hideAim(); };
  }
  showAim(at, t) {
    const a = this.puck;
    let cls = 'aim', label = '';
    if (t?.pass != null) {
      const r = this.risk(a, this.pos.get(t.pass)).p;
      cls += r < 0.25 ? ' safe' : r < 0.5 ? ' risky' : ' danger';
      label = `Pass ${this.model.short(t.pass)} · ${Math.round(r * 100)}% risk`;
    } else if (t) {
      const q = this.quality(a);
      cls += ' shot'; label = `Shoot · ${q.xg.toFixed(2)} xG${q.blockers.length ? ' · lane blocked' : ''}`;
    }
    for (const [k, v] of Object.entries({ x1: a[0], y1: -a[1], x2: at[0], y2: -at[1], class: cls })) this.aim.setAttribute(k, v);
    this.aim.style.display = 'inline';
    this.view.tag.style.visibility = 'hidden'; // the aim label takes the carrier tag's place
    if (!label) { this.aimLbl.style.display = 'none'; return; }
    const k = this.view.k, w = label.length * 0.56 + 1.2;
    this.aimText.textContent = label;
    this.aimRect.setAttribute('width', w); this.aimRect.setAttribute('x', -w / 2);
    const lx = clamp(at[0], -29 + (w * k) / 2, 29 - (w * k) / 2), ly = at[1] > 15 - 3.6 * k ? at[1] - 2.6 * k : at[1] + 2.6 * k;
    this.aimLbl.setAttribute('transform', `translate(${lx} ${-ly}) scale(${k})`);
    this.aimLbl.style.display = 'inline';
  }
  hideAim() { this.aim.style.display = this.aimLbl.style.display = 'none'; this.view.tag.style.visibility = ''; }

  // ---- simulation
  risk(a, b) { // chance the pass a -> b is picked off, and by whom
    const L = dist(a, b);
    let keep = 1, best = { p: 0, by: null, at: b.slice() };
    const test = (id, reach, lunge, scale) => {
      const d = this.pos.get(id);
      let m = Infinity, at = null;
      for (let k = 1; k <= 24; k++) {
        const s = k / 24;
        if (s * L < G.SKIP) continue; // a defender on top of the passer is already beaten once the puck leaves
        const P = [lerp(a[0], b[0], s), lerp(a[1], b[1], s)];
        const mm = dist(d, P) - (reach + lunge * Math.max(0, (s * L) / G.PUCK - G.REACT));
        if (mm < m) { m = mm; at = P; }
      }
      if (!at || m > 3.5) return;
      const p = sigmoid(G.B0 + G.B1 * m) * scale;
      keep *= 1 - p;
      if (p > best.p) best = { p, by: id, at };
    };
    this.def.forEach((id) => test(id, G.REACH, G.LUNGE, 1));
    if (this.goalie != null) test(this.goalie, 0.9, 1.2, 0.8);
    return { ...best, p: clamp(1 - keep + Math.max(0, L - 20) * 0.01 + Math.max(0, this.passes - 3) * 0.04, 0.02, 0.97) };
  }
  quality(p) { // shot xG from this match's fitted model + goalie position + traffic in the lane
    const dx = GOAL_X - p[0], dy = p[1], d = Math.hypot(dx, dy), blockers = [];
    if (dx < 0.4) return { xg: 0.01, blockers };
    const [b0, b1, b2] = this.model.xg;
    let z = 2.5 - 0.075 * d; // empty net
    if (this.goalie != null) {
      z = b0 + b1 * d + b2 * ((Math.atan2(Math.abs(dy), dx) * 180) / Math.PI);
      const g = this.pos.get(this.goalie);
      if (dist(g, [GOAL_X, 0]) > 0.3) z += Math.min(1.5, (Math.abs(angDiff(Math.atan2(dy, -dx), Math.atan2(g[1], g[0] - GOAL_X))) * 180) / Math.PI / 20);
    }
    if (this.lateral) z += 0.3;
    const u = unit(p, [GOAL_X, 0]);
    let pressured = false;
    for (const id of this.def) {
      const q = this.pos.get(id), w = [q[0] - p[0], q[1] - p[1]], t = (w[0] * u[0] + w[1] * u[1]) / d;
      if (t > 0.06 && t < 0.93 && Math.abs(w[0] * u[1] - w[1] * u[0]) < 0.95) blockers.push(id);
      if (dist(p, q) < 1.8) pressured = true;
    }
    if (pressured) z -= 0.3;
    return { xg: clamp(sigmoid(z), 0.01, 0.95), blockers };
  }
  keepOut(p) { // skaters stay on the ice and out of the crease
    p[0] = clamp(p[0], -29.2, 29.2); p[1] = clamp(p[1], -14.2, 14.2);
    const d = dist(p, [GOAL_X, 0]);
    if (d < 1.9 && p[0] < GOAL_X + 0.2) { const u = unit([GOAL_X, 0], p); p[0] = GOAL_X + u[0] * 1.9; p[1] = u[1] * 1.9; }
    return p;
  }
  plan(T, o) { // where everyone skates while the puck travels for T seconds
    const P = new Map([...this.pos].map(([k, v]) => [k, v.slice()]));
    const goal = [GOAL_X, 0], slot = [GOAL_X - 7.5, 0], press = 1 + 0.1 * this.passes;
    for (const id of this.att) { // attackers find space; the passer skates on
      if (id === o.receiver) continue;
      const p = P.get(id);
      let near = null, nd = 5;
      for (const d of this.def) { const dd = dist(p, P.get(d)); if (dd < nd) { nd = dd; near = P.get(d); } }
      let t = near ? add(p, unit(near, p), Math.min(2.2, 5 - nd)) : p.slice();
      t = id === o.passer ? add(t, unit(p, slot), 2.5) : p[0] < GOAL_X - 12 ? add(t, [1, 0], 1.5) : t;
      t[0] = Math.min(t[0], GOAL_X + 1.5);
      P.set(id, this.keepOut(stepTo(p, t, G.ATT * T * 0.75)));
    }
    const move = (id, t, k = 1) => P.set(id, this.keepOut(stepTo(this.pos.get(id), t, G.DEF * T * press * k)));
    const free = this.def.filter((id) => id !== o.chaser);
    const cp = o.receiver != null ? P.get(o.receiver) : o.end;
    free.sort((a, b) => dist(P.get(a), cp) - dist(P.get(b), cp));
    if (free.length) move(free.shift(), add(cp, unit(cp, goal), 1.3)); // pressure the new carrier
    const pairs = []; // mark the rest goal-side, sagging toward the slot
    for (const d of free) for (const a of this.att) if (a !== o.receiver) pairs.push([dist(P.get(d), P.get(a)), d, a]);
    pairs.sort((x, y) => x[0] - y[0]);
    const usedD = new Set(), usedA = new Set();
    for (const [, d, a] of pairs) {
      if (usedD.has(d) || usedA.has(a)) continue;
      usedD.add(d); usedA.add(a);
      const ap = P.get(a), gs = add(ap, unit(ap, goal), 1.8);
      move(d, [lerp(gs[0], slot[0], 0.25), lerp(gs[1], slot[1], 0.25)]);
    }
    free.filter((d) => !usedD.has(d)).forEach((d) => move(d, slot));
    if (o.chaser != null) { if (o.intercepted) P.set(o.chaser, o.at.slice()); else move(o.chaser, o.at, 1.1); }
    if (this.goalie != null) P.set(this.goalie, stepTo(this.pos.get(this.goalie), add(goal, unit(goal, o.end), 1.15).map((v, i) => (i ? v : Math.min(v, GOAL_X - 0.35))), G.GOALIE * T));
    return P;
  }
  async pass(to) {
    if (this.busy || this.over) return;
    if (this.passes >= G.PASSES) { this.hint('No passes left: <b>shoot!</b>'); return; }
    this.busy = true;
    const gen = this.gen, from = this.puck.slice(), r = this.risk(from, this.pos.get(to));
    const lost = Math.random() < r.p, end = lost ? r.at : this.pos.get(to).slice();
    const T = clamp(dist(from, end) / G.PUCK, 0.28, 1.6), dur = T * 1000 * G.ANIM, now = performance.now();
    const P = this.plan(T, { receiver: lost ? null : to, passer: this.carrier, chaser: r.by, at: r.at, intercepted: lost, end });
    this.view.setPositions([...P].map(([id, p]) => [id, ...p]), dur, now);
    this.view.movePuck(end, dur, now, from); this.view.setCarrier(null);
    this.view.line(from, end, `pass ${this.scn.team}`, dur + 900);
    this.hint(`${esc(this.model.short(this.carrier))} → ${esc(this.model.short(to))}…`);
    await this.wait(dur);
    if (gen !== this.gen) return;
    this.pos = P; this.puck = end.slice();
    if (lost) { this.carrier = r.by; this.view.setCarrier(r.by); this.finish('INTERCEPTED', { by: r.by, risk: r.p }); return; }
    this.passes++;
    this.lateral = Math.abs(end[1] - from[1]) > 5 && end[0] > GOAL_X - 16;
    this.carrier = to; this.view.setCarrier(to); this.busy = false; this.hud();
    const left = G.PASSES - this.passes;
    this.hint(`Clean pass to <b>${esc(this.model.label(to))}</b>${this.lateral ? ' — cross-ice, the goalie has to move' : ''}. ${left ? `${left} pass${left > 1 ? 'es' : ''} left, or shoot.` : 'Last chance: <b>shoot!</b>'}`);
  }
  async shoot() {
    if (this.busy || this.over || !this.scn) return;
    this.busy = true;
    const gen = this.gen, p = this.puck.slice(), q = this.quality(p);
    const aimY = clamp(-p[1] * 0.08 + (Math.random() - 0.5) * 1.3, -0.72, 0.72);
    let out, by = null, end;
    if (q.blockers.length && Math.random() < 1 - 0.6 ** q.blockers.length) { out = 'BLOCKED'; by = q.blockers[0]; end = this.pos.get(by).slice(); }
    else if (Math.random() < 1 - (1 - q.xg) ** G.BOOST) { out = 'GOAL'; end = [GOAL_X + 0.75, aimY]; }
    else if (this.goalie == null || Math.random() < 0.3) { out = 'WIDE'; end = [GOAL_X + 1.4, (aimY >= 0 ? 1 : -1) * (1.25 + Math.random() * 1.2)]; }
    else { out = 'SAVED'; by = this.goalie; end = this.pos.get(by).slice(); }
    const dur = clamp(dist(p, end) / G.SHOT, 0.16, 0.8) * 1000 * G.ANIM;
    this.view.setCarrier(null); this.view.movePuck(end, dur, performance.now(), p);
    this.view.line(p, end, `shot ${this.scn.team}`, dur + 1200);
    this.net.style.display = 'none';
    await this.wait(dur);
    if (gen !== this.gen) return;
    if (by != null) this.view.movePuck(add(end, [-1, (Math.random() - 0.5) * 2], 3), 320, performance.now());
    this.finish(out, { by, xg: q.xg });
  }
  finish(out, { by, xg, risk }) {
    this.over = true; this.busy = false; this.el.shoot.disabled = true; this.net.style.display = 'none';
    const s = this.scn, real = s.realXg, better = xg != null && (real == null ? xg >= 0.5 : xg >= real);
    const stars = out === 'GOAL' ? (better ? 3 : 2) : better && out !== 'INTERCEPTED' ? 1 : 0;
    const realTxt = real != null ? `${real.toFixed(2)} xG` : 'an empty net', who = esc(this.model.label(by));
    const msg = {
      GOAL: ['good', `You scored from a <b>${xg?.toFixed(2)} xG</b> chance. The real goal came from ${realTxt}${real && xg / real >= 1.15 ? ` — yours was <b>${(xg / real).toFixed(1)}×</b> better` : ''}.`],
      SAVED: ['meh', `${who} stops your ${xg?.toFixed(2)} xG shot. The real chance was ${realTxt}.`],
      WIDE: ['meh', `Your ${xg?.toFixed(2)} xG shot misses the net. The real chance was ${realTxt}.`],
      BLOCKED: ['bad', `${who} was in the lane. Move the puck to open a shooting line.`],
      INTERCEPTED: ['bad', `${who} reads the pass (${Math.round((risk || 0) * 100)}% risk). Shorter passes into space are safer.`],
    }[out];
    this.overlay(`<b>${out}${out === 'GOAL' ? '!' : ''}</b><span>${'★'.repeat(stars)}${'☆'.repeat(3 - stars)}</span>`, msg[0]);
    this.el.result.className = `wi-result ${msg[0]}`;
    this.el.result.innerHTML = `<b>${out}</b> ${msg[1]}`;
    if (stars > (this.best[s.key] || 0)) { this.best[s.key] = stars; store.set('spengler-whatif', this.best); }
    this.chips();
    this.hint('Tap <b>↺</b> to try again, or watch the real goal.');
    this.host.dispatchEvent(new CustomEvent('whatif-result', { detail: { goal: s.key, outcome: out, xg, stars }, bubbles: true, composed: true }));
  }

  // ---- the real goal, replayed through the motion engine
  watchReal() {
    if (!this.scn) return;
    this.reset();
    this.busy = this.over = true; this.el.shoot.disabled = this.el.real.disabled = true; this.net.style.display = 'none';
    this.view.tokens.forEach((tk) => tk.g.classList.remove('att'));
    this.replay = { T: this.scn.t0, i: 0, last: null };
    this.hint('Replaying the real build-up…');
  }
  render(now) {
    const r = this.replay;
    if (r) {
      const s = this.scn, evs = s.events;
      if (r.last != null) r.T += now - r.last;
      r.last = now;
      while (r.i < evs.length && evs[r.i].t <= r.T) {
        const e = evs[r.i++];
        if (e.t < s.t0) continue;
        if (e.type === 'Pass' && e.team === s.team) this.view.line(e.start, e.end, `pass ${s.team}`, 1800);
        if (e.type === 'Shot') this.view.line(e.start, [GOAL_X + 0.6, 0], `shot ${s.team}`, 2200);
      }
      const smp = s.motion.sample(Math.min(r.T, s.tEnd));
      if (r.T >= s.tEnd - 400 && !smp.puck) smp.puck = [GOAL_X + 0.6, 0];
      this.view.place(smp);
      if (r.T > s.tEnd + 700) {
        this.replay = null;
        this.overlay(`<b>GOAL · ${esc(this.model.short(s.scorer).toUpperCase())}</b><span>the real one</span>`, 'good');
        this.el.result.className = 'wi-result';
        this.el.result.innerHTML = `<b>The real goal:</b> ${esc(s.chain.join(' → '))} · ${s.realXg != null ? `${s.realXg.toFixed(2)} xG` : 'empty net'}. Can you build a better chance?`;
        this.el.real.disabled = false; this.busy = false;
        this.hint('Tap <b>↺</b> to take control from the same moment.');
      }
    }
    this.view.render(now);
  }
}