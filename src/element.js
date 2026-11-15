/*!
 * <spengler-live-match> · live 2D rink, player archetypes and the "What If?" goal game.
 * (c) 2026 the authors · CC BY-NC 4.0 (https://creativecommons.org/licenses/by-nc/4.0/)
 * Rink geometry from hockey_rink (GPL-3.0) · data © Wisehockey.
 */
import CSS from './styles.css';
import HTML from './template.html';
import { ArchetypeCards } from './archetypes.js';
import { LiveFeed, ReplayFeed } from './feeds.js';
import { MatchModel } from './model.js';
import { Motion } from './motion.js';
import { RinkView } from './rink-view.js';
import { buildScenario } from './scenario.js';
import { MatchState } from './state.js';
import { GOAL_X, clamp, esc, mmss, ordinal } from './util.js';
import { WhatIfGame } from './whatif.js';

const DELAY = 2500; // draw this far (ms of game time) behind the newest data so motion always has a next frame
const INTERMISSION = 17 * 60e3;
const BREAK = { intermission: 1, final: 1 };
const why = (w) => String(w || '').replace(/([a-z])([A-Z])/g, '$1 $2');
const WHISTLE = { Icing: 'Whistle · Icing', Offside: 'Whistle · Offside', Freeze: 'Whistle · Puck frozen', Penalty: 'Whistle · Penalty', Goal: 'Goal · back to centre ice' };
const TEAM_ATTRS = ['name', 'code', 'short', 'color', 'ink'];
function shade(hex, k) { // mix #rrggbb with white by k; also report whether the colour is light
  const n = parseInt(hex.slice(1), 16), c = [n >> 16, (n >> 8) & 255, n & 255].map((v) => Math.round(v + (255 - v) * k));
  return { hex: `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`, light: (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255 > 0.62 };
}

function marks(evs) {
  const first = (p) => evs.find((e) => e.period === p)?.t;
  const ends = evs.filter((e) => e.why === 'PeriodEnd').map((e) => e.t);
  const goal = evs.find((e) => e.type === 'Goal')?.t;
  return {
    'puck-drop': evs[0].t - 1000, 'first-goal': goal && goal - 18000, 'p1-end': ends[0] && ends[0] - 12000,
    p2: first(2) && first(2) - 1500, 'p2-end': ends[1] && ends[1] - 12000, p3: first(3) && first(3) - 1500, final: ends[2] && ends[2] - 15000,
  };
}

class SpenglerLiveMatch extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' }).innerHTML = `<style>${CSS}</style>${HTML}`;
    this.$ = (s) => this.shadowRoot.querySelector(s);
    this.loop = this.loop.bind(this);
  }
  connectedCallback() {
    if (!this.model) {
      this.model = new MatchModel();
      this.reset();
      this.root = this.$('.root');
      this.view = new RinkView(this.model);
      this.$('.live .rink-box').prepend(this.view.svg);
      this.game = new WhatIfGame(this);
      this.cards = new ArchetypeCards(this.$('.arc-grid'), this.model, (id) => this.pick(id));
      this.bind();
      const src = this.getAttribute('src'), url = this.getAttribute('feed-url');
      if (url || this.getAttribute('mode') === 'live') this.startLive(url); else if (src) this.startReplay(src);
      this.teams(); this.moments(); this.cards.render(this.state, true); this.game.setScenarios([]);
    }
    this.raf = requestAnimationFrame(this.loop);
  }
  disconnectedCallback() { cancelAnimationFrame(this.raf); }
  reset() { this.state = new MatchState(this.model, (+this.getAttribute('ot-minutes') || 5) * 60); this.motion = new Motion(this.model); this.queue = []; this.qi = 0; this.scenarios = []; }

  // ---------- public API
  /** Raw Wisehockey rows (CSV column names), one or many. */
  pushEvent(rows) {
    if (!(this.feed instanceof LiveFeed)) this.startLive();
    const evs = [].concat(rows).map((r) => (r.type && r.t ? r : this.model.fromRow(r))).sort((a, b) => a.t - b.t);
    evs.forEach((e) => this.feed.note(e.t));
    this.receive(evs);
  }
  setMeta(meta) {
    for (const k of ['home', 'away']) if (meta[k]) Object.assign(this.model.meta[k], meta[k]);
    if (meta.competition != null) this.model.meta.competition = meta.competition;
    this.teams(true);
  }
  /** Team names and colours: data file < element attributes (home-name, away-color, …) < setMeta(). */
  teams(api) {
    const meta = this.model.meta;
    for (const [side, key] of [['home', 'H'], ['away', 'A']]) {
      const m = meta[side];
      if (!api) for (const a of TEAM_ATTRS) if (this.hasAttribute(`${side}-${a}`)) m[a] = this.getAttribute(`${side}-${a}`);
      if (/^#[0-9a-f]{6}$/i.test(m.color || '')) {
        this.style.setProperty(`--${key}`, m.color);
        this.style.setProperty(`--${key}2`, shade(m.color, 0.45).hex);
        this.style.setProperty(`--${key}-ink`, m.ink || (shade(m.color, 0).light ? '#001f3f' : '#fff'));
      }
    }
    if (!api && this.hasAttribute('competition')) meta.competition = this.getAttribute('competition');
    this.paint();
  }
  get phase() { return this.state.phase; }
  seek(P) { // presentation time, replay only
    if (!(this.feed instanceof ReplayFeed)) return;
    const evs = this.feed.seek(P + DELAY);
    this.reset(); this.view.clear(); this.receive(evs); this.present(P, true);
    this.layout(true); this.moments(); this.game.setScenarios(this.scenarios, true); this.cards.render(this.state, true); this.paint(); this.syncDemo();
  }

  // ---------- data flow: feed -> motion (immediately) -> state + effects (DELAY later, in sync with the drawing)
  async startReplay(src) {
    try {
      const json = src[0] === '#' ? JSON.parse(document.querySelector(src).textContent) : await (await fetch(src)).json();
      const evs = this.model.decode(json);
      this.feed = new ReplayFeed(evs, +this.getAttribute('speed') || 1);
      this.marks = marks(evs);
      const s = this.getAttribute('start'), at = this.marks[s] ?? (s && !Number.isNaN(+s) ? this.feed.start + s * 1000 : null);
      if (at != null) this.seek(at);
      if (this.getAttribute('autoplay') !== 'false') this.feed.play();
      this.teams(); this.demo(); this.cards.render(this.state, true);
    } catch (e) {
      this.failed = `<b>Couldn't load the match</b><span>${esc(e.message)}</span>`;
      this.overlay(this.failed, 'dim');
    }
  }
  startLive(url) {
    this.feed = new LiveFeed((rows) => this.pushEvent(rows));
    if (url) this.feed.connect(url);
  }
  receive(evs) { for (const e of evs) { this.motion.ingest(e); this.queue.push(e); } }
  present(P, silent) {
    const fx = [];
    while (this.qi < this.queue.length && this.queue[this.qi].t <= P) fx.push(...this.state.apply(this.queue[this.qi++]));
    if (this.qi > 4000) { this.queue = this.queue.slice(this.qi); this.qi = 0; }
    if (fx.length) this.effects(fx, silent);
  }
  effects(fx, silent) {
    const speed = this.feed?.speed || 1, life = (ms) => clamp(ms / Math.sqrt(speed), 500, ms);
    let goal = false, phase = false, shown = 0;
    for (const f of fx) {
      if (f.kind === 'shot') this.view.addShot(f.ev);
      if (f.kind === 'goal') { this.scenarios.push(buildScenario(this.state, this.model, f.moment)); goal = true; }
      if (f.kind === 'phase') phase = true;
      if (silent || ((f.kind === 'pass' || f.kind === 'shot') && ++shown > 4)) continue;
      const e = f.ev;
      if (f.kind === 'pass' && e.start && e.end) this.view.line(e.start, e.end, `pass ${e.team}${e.type === 'Pass' ? '' : ' dump'}`, life(1600));
      if (f.kind === 'shot' && e.start) {
        this.view.line(e.start, [e.team === 'H' ? GOAL_X : -GOAL_X, 0], `shot ${e.team}`, life(2200));
        this.view.ring(e.start, `shot ${e.team}`, 0.6 + 2 * Math.sqrt(e.xg || 0.01), 1500);
        if (speed <= 16) this.toast(`<i class="dot ${e.team}"></i>Shot · ${esc(this.model.label(e.p1))} · ${esc(e.res)}${e.xg != null ? ` · ${e.xg.toFixed(2)} xG` : ''}`);
      }
      if (f.kind === 'goal') this.goal(f.moment);
      if (f.kind === 'pen') this.toast(`<b class="pen">2'</b>${esc(this.model.team(f.moment.team).code)} · ${esc(this.model.label(f.moment.player) || 'Bench')} · ${esc(why(f.moment.why))}`, 3200);
    }
    if (goal || phase) {
      const brk = BREAK[this.state.phase];
      this.moments();
      this.game.setScenarios(this.scenarios, silent || (phase && brk) || !this.game.scn);
      if (goal && !silent && !brk) this.newGoal(this.scenarios[this.scenarios.length - 1]);
    }
    if (phase && !silent) this.layout();
    this.paint();
  }
  loop(now) {
    if (this.feed) {
      if (this.feed.tick) { const due = this.feed.tick(now); if (due.length) this.receive(due); }
      this.P = this.feed.now() - DELAY;
      this.present(this.P);
      this.view.place(this.motion.sample(this.P));
    }
    if (now - (this.painted || 0) > 250) { this.painted = now; this.clock(); this.cards.render(this.state); this.syncDemo(true); }
    this.view.render(now);
    this.game.render(now);
    this.raf = requestAnimationFrame(this.loop);
  }

  // ---------- layout: during breaks the page "refreshes" with the What-If game on top
  layout(instant) {
    const ph = this.state.phase, was = this.root.dataset.phase;
    if (was === ph) return;
    const apply = () => {
      this.root.dataset.phase = ph;
      this.dispatchEvent(new CustomEvent('phasechange', { detail: { phase: ph, period: this.state.period }, bubbles: true, composed: true }));
    };
    if (instant || !BREAK[ph] === !BREAK[was]) { apply(); return; }
    this.root.classList.add('swap');
    setTimeout(() => {
      apply();
      const r = this.getBoundingClientRect();
      if (this.getAttribute('autoscroll') !== 'false' && r.top < 0 && r.bottom > 0) this.scrollIntoView({ behavior: 'smooth' });
      requestAnimationFrame(() => this.root.classList.remove('swap'));
    }, 320);
  }

  // ---------- painting
  paint() {
    const st = this.state, { home, away, competition } = this.model.meta, $ = this.$;
    for (const [t, m] of [['H', home], ['A', away]]) {
      $(`.team.${t} .crest`).textContent = m.code;
      $(`.team.${t} .tname`).innerHTML = `<span class="full">${esc(m.name)}</span><span class="short">${esc(m.short || m.name)}</span>`;
      const s = $(`.s${t}`);
      if (s.textContent !== String(st.score[t])) { s.textContent = st.score[t]; s.classList.remove('bump'); void s.offsetWidth; s.classList.add('bump'); }
      $(`.x${t}`).textContent = st.xg[t].toFixed(2);
      $(`.sog${t}`).textContent = st.sog[t];
    }
    this.shadowRoot.querySelectorAll('.home-code').forEach((e) => { e.textContent = home.code; });
    this.shadowRoot.querySelectorAll('.away-code').forEach((e) => { e.textContent = away.code; });
    $('.comp').textContent = competition || '';
    const tot = st.xg.H + st.xg.A;
    $('.xbar i.H').style.width = `${tot ? (100 * st.xg.H) / tot : 50}%`;
    $('.xbar i.A').style.width = `${tot ? (100 * st.xg.A) / tot : 50}%`;
    const per = $('.periods');
    per.style.gridTemplateColumns = `auto repeat(${st.periods.length + 1}, 2.2em)`;
    per.innerHTML = st.phase === 'pregame' ? '' : `<span></span>${st.periods.map((_, i) => `<small>${i < 3 ? i + 1 : 'OT'}</small>`).join('')}<small>T</small>${
      ['H', 'A'].map((t) => `<span class="pt"><i class="dot ${t}"></i>${esc(this.model.team(t).code)}</span>${st.periods.map((p) => `<span>${p[t]}</span>`).join('')}<b>${st.score[t]}</b>`).join('')}`;
    let s = '';
    if (st.phase === 'live') {
      const vs = st.strength.replace('v', ' on ');
      if (!st.homeGoalie || !st.awayGoalie) s = `Empty net · ${(st.homeGoalie ? away : home).code}`;
      else if (st.strengthType === 'HomePowerplay') s = `Power play · ${home.code} (${vs})`;
      else if (st.strengthType === 'AwayPowerplay') s = `Power play · ${away.code} (${vs})`;
      else if (st.strengthType === 'EqualStrength' && st.strength !== '5v5') s = vs;
    }
    $('.strength').textContent = s; $('.strength').hidden = !s;
    this.clock();
  }
  resumeIn() {
    const st = this.state;
    if (st.phase !== 'intermission') return null;
    const next = this.queue[this.qi]?.t ?? this.feed?.nextT();
    return Math.max(0, (next ?? st.periodEndT + INTERMISSION) - this.P);
  }
  clock() {
    const st = this.state, $ = this.$, ph = st.phase, res = this.resumeIn(), { home, away } = this.model.meta;
    const label = { pregame: 'Pre-game', live: 'Live', intermission: 'Intermission', final: 'Final' }[ph];
    for (const p of this.shadowRoot.querySelectorAll('.pill')) { p.textContent = label; p.dataset.phase = ph; }
    $('.clock').textContent = ph === 'live' ? `${ordinal(st.period)} · ${mmss(st.length() - st.clockAt(this.P))}`
      : ph === 'intermission' ? `End of ${ordinal(st.period)}${res != null ? ` · back in ${mmss(res / 1000)}` : ''}`
        : ph === 'final' ? 'Full time' : 'Puck drop soon';
    if (this.failed) this.overlay(this.failed, 'dim');
    else if (!this.goalOn) {
      const html = ph === 'intermission' ? `<b>${ordinal(st.period)} intermission</b><span>${res != null ? `Play resumes in ${mmss(res / 1000)}` : 'Back shortly'}</span>`
        : ph === 'final' ? `<b>Final</b><span>${esc(home.code)} ${st.score.H}–${st.score.A} ${esc(away.code)}</span>`
          : ph === 'pregame' ? '<b>Puck drop soon</b><span>Waiting for the first event</span>' : '';
      this.overlay(html, 'dim');
    }
    const w = $('.whistle'), stop = ph === 'live' && !this.goalOn && !this.failed ? st.stop : null;
    w.hidden = !stop;
    if (stop && w.dataset.k !== stop) { w.dataset.k = stop; w.innerHTML = `<i></i>${esc(WHISTLE[stop] || 'Whistle · Play stopped')}<small>Faceoff next</small>`; }
    const b = $('.banner');
    b.hidden = !BREAK[ph];
    if (!b.hidden) {
      const n = this.scenarios.filter((x) => ph === 'final' || x.moment.period === st.period).length;
      b.querySelector('small').textContent = ph === 'final' ? 'Full time' : `${ordinal(st.period)} intermission`;
      b.querySelector('strong').textContent = ph === 'final' ? `Relive all ${this.scenarios.length} goals — your way.` : n ? `${n} goal${n > 1 ? 's' : ''} this period. Can you do better?` : 'No goals this period — replay earlier ones.';
      b.querySelector('span').innerHTML = `${esc(home.code)} <b>${st.score.H}–${st.score.A}</b> ${esc(away.code)} · xG ${st.xg.H.toFixed(2)}–${st.xg.A.toFixed(2)}${res != null ? ` · <em>play resumes in ${mmss(res / 1000)}</em>` : ''}`;
    }
  }
  overlay(html, cls) {
    const o = this.$('.live .overlay');
    if (o.dataset.html !== html) { o.dataset.html = html; o.innerHTML = html; }
    o.className = `overlay ${cls}`; o.hidden = !html;
  }
  moments() {
    const list = this.$('.m-list'), ms = this.state.moments;
    list.innerHTML = ms.length ? ms.slice().reverse().map((m) => {
      if (m.kind === 'end') return `<li class="sep">End of ${ordinal(m.period)} period</li>`;
      const code = esc(this.model.team(m.team).code), time = `<time>P${m.period} ${mmss(m.clock)}</time>`;
      if (m.kind === 'pen') return `<li>${time}<b class="pen">2'</b><span><b>${code} penalty · ${esc(this.model.label(m.player) || 'Bench')}</b><small>${esc(why(m.why))}</small></span></li>`;
      const i = this.scenarios.findIndex((s) => s.moment === m);
      const tags = [m.assists.map((a) => this.model.short(a)).join(', ') || 'Unassisted', m.strength, m.xg != null && `${m.xg.toFixed(2)} xG`].filter(Boolean).join(' · ');
      return `<li>${time}<i class="goal ${m.team}"></i><span><b>${code} goal · ${esc(this.model.short(m.scorer))}</b><small>${esc(tags)}</small></span><em>${m.score.H}–${m.score.A}</em>${i >= 0 ? `<button type="button" data-wi="${i}">What if?</button>` : ''}</li>`;
    }).join('') : '<li class="empty">Goals and penalties appear here as they happen.</li>';
  }
  goal(m) {
    const { home, away } = this.model.meta, assists = m.assists.map((a) => this.model.short(a)).join(', ');
    this.overlay(`<b>Goal · ${esc(this.model.team(m.team).code)}</b><span>${esc(this.model.label(m.scorer))}${assists ? ` (${esc(assists)})` : ''}${m.strength ? ` · ${m.strength}` : ''}</span><em>${esc(home.code)} ${m.score.H}–${m.score.A} ${esc(away.code)}</em>`, `goal ${m.team}`);
    this.goalOn = true;
    clearTimeout(this.goalT);
    this.goalT = setTimeout(() => { this.goalOn = false; this.clock(); }, clamp(4200 / Math.sqrt(this.feed?.speed || 1), 1400, 4200));
    this.$('.sr').textContent = `Goal ${this.model.team(m.team).name}, ${this.model.label(m.scorer)}. ${home.code} ${m.score.H}, ${away.code} ${m.score.A}.`;
  }
  toast(html, ms = 1700) {
    const t = this.$('.toast');
    t.innerHTML = html; t.classList.add('on');
    clearTimeout(this.toastT); this.toastT = setTimeout(() => t.classList.remove('on'), ms);
  }
  newGoal(sc) {
    const n = this.$('.wi-new');
    n.innerHTML = `New: <b>${esc(this.model.short(sc.scorer))}'s goal</b> is ready to replay`;
    n.dataset.i = this.scenarios.indexOf(sc); n.hidden = false;
    clearTimeout(this.newT); this.newT = setTimeout(() => { n.hidden = true; }, 9000);
  }
  openWhatIf(i) { this.game.select(i); this.$('.whatif').scrollIntoView({ behavior: 'smooth' }); }
  pick(id) {
    if (!this.view.highlight(id)) this.toast(`${esc(this.model.label(id))} is on the bench right now`);
    else this.$('.live').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // ---------- controls
  bind() {
    this.$('[data-layer]').onclick = (e) => {
      const b = e.currentTarget, on = b.getAttribute('aria-pressed') !== 'true';
      b.setAttribute('aria-pressed', on); this.view.svg.classList.toggle('show-shots', on);
    };
    this.$('.wi-new').onclick = (e) => { e.currentTarget.hidden = true; this.openWhatIf(+e.currentTarget.dataset.i); };
    this.$('.m-list').onclick = (e) => { const b = e.target.closest('[data-wi]'); if (b) this.openWhatIf(+b.dataset.wi); };
  }
  demo() {
    if (!this.hasAttribute('controls')) return;
    const d = this.$('.demo'), f = this.feed, names = { 'puck-drop': 'Puck drop', 'first-goal': '1st goal', 'p1-end': 'End P1', p2: 'P2', 'p2-end': 'End P2', p3: 'P3', final: 'Final' };
    d.hidden = false;
    d.querySelector('.d-jumps').innerHTML = Object.entries(names).filter(([k]) => this.marks[k]).map(([k, l]) => `<button type="button" data-mark="${k}">${l}</button>`).join('')
      + '<button type="button" class="d-skip" hidden>Skip intermission ›</button>';
    d.onclick = (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.mark) { this.seek(this.marks[b.dataset.mark]); f.play(); }
      if (b.dataset.speed) f.speed = +b.dataset.speed;
      if (b.classList.contains('d-play')) f.playing ? f.pause() : f.play();
      if (b.classList.contains('d-skip')) { const n = this.queue[this.qi]?.t ?? f.nextT(); if (n) this.seek(n - 2000); f.play(); }
      this.syncDemo();
    };
    const r = d.querySelector('input');
    Object.assign(r, { min: f.start - 1000, max: f.end + 1000, step: 1000 });
    r.oninput = () => { this.scrubbing = true; };
    r.onchange = () => { this.scrubbing = false; this.seek(+r.value); };
    this.syncDemo();
  }
  syncDemo(tick) {
    const d = this.$('.demo'), f = this.feed;
    if (d.hidden || !f) return;
    if (!this.scrubbing) d.querySelector('input').value = this.P;
    d.querySelector('.d-skip').hidden = this.state.phase !== 'intermission';
    const st = this.state;
    d.querySelector('.d-time').textContent = st.phase === 'live' ? `P${st.period} ${mmss(st.clockAt(this.P))} elapsed` : st.phase[0].toUpperCase() + st.phase.slice(1);
    if (tick) return;
    d.querySelector('.d-play').textContent = f.playing ? 'Pause' : 'Play';
    d.querySelectorAll('[data-speed]').forEach((b) => b.setAttribute('aria-pressed', +b.dataset.speed === f.speed));
  }
}

if (!customElements.get('spengler-live-match')) customElements.define('spengler-live-match', SpenglerLiveMatch);