// Motion engine: turns sparse tracking snapshots into smooth, physically plausible movement.
//
// Wisehockey sends a snapshot of every player at each event (about 1 per second, irregular),
// with measured velocity on passes, shots, dumps and blue-line crossings. Like frame generation
// in games, we render "in between" frames:
//   - players: cubic Hermite curves through the snapshots, using the measured velocity as the
//     tangent where we have it and a centred estimate where we don't; speeds are capped so
//     curves never overshoot. Past the newest snapshot we dead-reckon briefly, then hold.
//   - puck: keyframes from the PuckControl chain (each segment starts where the last ended).
//     When a team controls it, the puck rides on the carrier's stick; loose pucks glide.
//   - contact: at every puck keyframe, whoever touches it (credited carrier, the inferred one
//     when the feed names none, or the passer releasing it) is pulled to within a stick's length,
//     so the puck never moves without a player reaching it.
// Rendering runs a couple of seconds behind the newest data, so there is always a next snapshot
// to interpolate towards.
import { clamp, dist, lerp, unit } from './util.js';

const MAX_SPEED = 11;  // m/s, ~40 km/h — fastest skater in this game hit 10.5 m/s
const STICK = 0.8;     // puck-to-player distance when touching (m)
const SAME = 120;      // snapshots closer than this (ms) are the same moment
const PIN_MAX = 2;     // most a contact may move a player (m)
const PIN_SPREAD = 500; // ...eased into his samples within this many ms either side

function find(ts, T) { // index of the last t <= T, or -1
  let lo = 0, hi = ts.length - 1, r = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (ts[m] <= T) { r = m; lo = m + 1; } else hi = m - 1; }
  return r;
}
const cap = (vx, vy, lim) => { const s = Math.hypot(vx, vy); return s > lim ? [(vx * lim) / s, (vy * lim) / s] : [vx, vy]; };

class Track {
  constructor() { this.t = []; this.x = []; this.y = []; this.vx = []; this.vy = []; this.pin = []; }
  put(t, x, y, vx, vy) {
    const n = this.t.length - 1;
    if (n >= 0 && t < this.t[n]) return;
    if (n >= 0 && t - this.t[n] < SAME) { // refresh the same moment, but never undo a contact pin
      if (!this.pin[n]) { this.x[n] = x; this.y[n] = y; }
      if (vx != null) { this.vx[n] = vx; this.vy[n] = vy; }
      return;
    }
    this.t.push(t); this.x.push(x); this.y.push(y); this.vx.push(vx ?? NaN); this.vy.push(vy ?? NaN); this.pin.push(false);
  }
  pinAt(t, x, y) { // move the sample at t onto (x, y), easing the shift into neighbours so nobody jumps
    let i = find(this.t, t + SAME);
    if (i < 0 || Math.abs(this.t[i] - t) > SAME) {
      const [px, py] = this.at(t);
      this.t.splice(++i, 0, t); this.x.splice(i, 0, px); this.y.splice(i, 0, py); this.vx.splice(i, 0, NaN); this.vy.splice(i, 0, NaN); this.pin.splice(i, 0, false);
    }
    let dx = x - this.x[i], dy = y - this.y[i];
    const d = Math.hypot(dx, dy);
    if (d > PIN_MAX) { dx *= PIN_MAX / d; dy *= PIN_MAX / d; }
    for (let j = i; j >= 0 && this.t[i] - this.t[j] < PIN_SPREAD; j--) this.nudge(j, dx, dy, 1 - (this.t[i] - this.t[j]) / PIN_SPREAD);
    for (let j = i + 1; j < this.t.length && this.t[j] - this.t[i] < PIN_SPREAD; j++) this.nudge(j, dx, dy, 1 - (this.t[j] - this.t[i]) / PIN_SPREAD);
    this.pin[i] = true;
  }
  nudge(j, dx, dy, w) { if (!this.pin[j] || w === 1) { this.x[j] += dx * w; this.y[j] += dy * w; } }
  vel(i) {
    if (Number.isFinite(this.vx[i])) return [this.vx[i], this.vy[i]];
    const a = Math.max(0, i - 1), b = Math.min(this.t.length - 1, i + 1), dt = (this.t[b] - this.t[a]) / 1000;
    return b > a && dt > 0 && dt < 3 ? [(this.x[b] - this.x[a]) / dt, (this.y[b] - this.y[a]) / dt] : [0, 0];
  }
  at(T) {
    const n = this.t.length;
    if (!n) return null;
    const i = find(this.t, T);
    if (i < 0) return [this.x[0], this.y[0]];
    if (i === n - 1) { // ahead of the data: glide on the last velocity and ease to a stop within 0.5 s
      const [vx, vy] = this.vel(i), s = Math.min((T - this.t[i]) / 1000, 0.5), k = s - s * s;
      return [this.x[i] + vx * k, this.y[i] + vy * k];
    }
    const t0 = this.t[i], t1 = this.t[i + 1], h = (t1 - t0) / 1000, s = (T - t0) / (t1 - t0);
    const x0 = this.x[i], y0 = this.y[i], x1 = this.x[i + 1], y1 = this.y[i + 1];
    if (h > 4) { const e = s * s * (3 - 2 * s); return [lerp(x0, x1, e), lerp(y0, y1, e)]; } // stoppage / back from the bench
    const lim = Math.min(MAX_SPEED, (2 * Math.hypot(x1 - x0, y1 - y0)) / h + 1.5);
    const [ax, ay] = cap(...this.vel(i), lim), [bx, by] = cap(...this.vel(i + 1), lim);
    const s2 = s * s, s3 = s2 * s, h00 = 2 * s3 - 3 * s2 + 1, h10 = s3 - 2 * s2 + s, h01 = 3 * s2 - 2 * s3, h11 = s3 - s2;
    return [h00 * x0 + h10 * h * ax + h01 * x1 + h11 * h * bx, h00 * y0 + h10 * h * ay + h01 * y1 + h11 * h * by];
  }
}

export class Motion {
  constructor(model) {
    this.model = model;
    this.tracks = new Map();
    this.lineups = { t: [], ids: [] }; // only when the set of players on the ice changes
    this.pk = { t: [], x: [], y: [], ex: [], ey: [], kind: [], who: [] }; // puck keys: kind C(ontrolled) L(oose) S(topped)
  }
  track(id) { let tr = this.tracks.get(id); if (!tr) this.tracks.set(id, (tr = new Track())); return tr; }

  ingest(ev) {
    if (ev.pos) {
      for (const [id, x, y, vx, vy] of ev.pos) this.track(id).put(ev.t, x, y, vx, vy);
      const L = this.lineups, last = L.ids[L.ids.length - 1], ids = ev.pos.map((p) => p[0]);
      if (!last || last.size !== ids.length || ids.some((id) => !last.has(id))) { L.t.push(ev.t); L.ids.push(new Set(ids)); }
    }
    const K = this.pk, n = K.t.length - 1;
    if (ev.type === 'StoppageOfPlay' && n >= 0) this.key(ev.t, [K.x[n], K.y[n]], null, 'S', null);
    if (ev.type !== 'PuckControl' || !ev.start) return;
    const team = /Control$/.test(ev.st || '') ? ev.st[0] : null; // 'H' | 'A' | null
    let who;
    if (team) who = ev.p1 ?? this.nearest(ev, ev.start, team, 4);
    else if (n >= 0 && K.kind[n] === 'C' && K.who[n] != null && dist(this.posOf(ev, K.who[n]) || [99, 99], ev.start) < 4) who = K.who[n]; // the release
    else who = this.nearest(ev, ev.start, null, 2.2); // a touch nobody was credited for
    if (who != null) this.reach(ev, who, ev.start);
    this.key(ev.t, ev.start, ev.end, team ? 'C' : 'L', team ? who : null);
  }
  key(t, p, e, kind, who) {
    const K = this.pk;
    K.t.push(t); K.x.push(p[0]); K.y.push(p[1]); K.ex.push(e ? e[0] : p[0]); K.ey.push(e ? e[1] : p[1]); K.kind.push(kind); K.who.push(who);
  }
  posOf(ev, id) {
    const p = ev.pos && ev.pos.find((q) => q[0] === id);
    return p ? [p[1], p[2]] : this.tracks.get(id)?.at(ev.t) || null;
  }
  nearest(ev, at, team, max) {
    let best = null, bd = max;
    for (const [id, x, y] of ev.pos || []) {
      if (team && this.model.players.get(id)?.team !== team) continue;
      const d = Math.hypot(x - at[0], y - at[1]);
      if (d < bd) { bd = d; best = id; }
    }
    return best;
  }
  reach(ev, id, puck) { // contact: the toucher ends up within a stick's length of the puck
    const p = this.posOf(ev, id);
    if (!p || dist(p, puck) <= STICK) return;
    const u = unit(puck, p);
    this.track(id).pinAt(ev.t, puck[0] + u[0] * STICK, puck[1] + u[1] * STICK);
  }

  playerAt(id, T) { return this.tracks.get(id)?.at(T) || null; }
  onIce(T) { const i = find(this.lineups.t, T); return i < 0 ? null : this.lineups.ids[i]; }

  /** Everything needed to draw one frame at time T. */
  sample(T) {
    const ids = this.onIce(T) || new Set(), players = [];
    for (const id of ids) { const p = this.playerAt(id, T); if (p) players.push([id, p[0], p[1]]); }
    const K = this.pk, i = find(K.t, T);
    let puck = null, carrier = null;
    if (i >= 0 && K.kind[i] !== 'S') {
      const j = i + 1 < K.t.length ? i + 1 : -1;
      const from = [K.x[i], K.y[i]];
      if (j > 0 && K.kind[j] !== 'S') {
        const s = (T - K.t[i]) / (K.t[j] - K.t[i]);
        puck = [lerp(from[0], K.x[j], s), lerp(from[1], K.y[j], s)];
      } else { // no next key yet (or a stoppage next): head to this segment's end point at loose-puck speed
        const to = [K.ex[i], K.ey[i]], span = j > 0 ? K.t[j] - K.t[i] : (dist(from, to) / 15) * 1000;
        const s = span > 0 ? clamp((T - K.t[i]) / span, 0, 1) : 1;
        puck = [lerp(from[0], to[0], s), lerp(from[1], to[1], s)];
      }
      if (K.kind[i] === 'C' && K.who[i] != null) {
        carrier = K.who[i];
        const c = this.playerAt(carrier, T);
        if (c) { // ride on the stick
          const dx = puck[0] - c[0], dy = puck[1] - c[1], d = Math.hypot(dx, dy);
          if (d > STICK) puck = [c[0] + (dx / d) * STICK, c[1] + (dy / d) * STICK];
        }
      }
    }
    return { players, ids, puck, carrier };
  }
}
