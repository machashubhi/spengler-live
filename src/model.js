// Players, team metadata, and conversion of incoming data into one event shape:
// { t, period, clock, type, team, p1, p2, start, end, strengthType, strength, homeGoalie, awayGoalie,
//   res, xg, dir, a (assists), why, st (puck state), c (contesting ids), pos: [[id, x, y, vx, vy]] }

const xy = (v) => {
  if (Array.isArray(v)) return v;
  if (typeof v !== 'string' || !v.includes(',')) return null;
  const [a, b] = v.split(',').map(Number);
  return Number.isFinite(a) && Number.isFinite(b) ? [a, b] : null;
};
const num = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));
const bool = (v) => v == null || v === true || v === 'True' || v === 'true' || v === 1;
const side = (v) => (v === 'Home' ? 'H' : v === 'Away' ? 'A' : null);

export class MatchModel {
  constructor() {
    this.players = new Map();
    this.meta = { home: { code: 'HOME', name: 'Home team' }, away: { code: 'AWAY', name: 'Away team' }, competition: '' };
    this.xg = [-0.2024, -0.2092, -0.0219]; // logit(xG) = b0 + b1·distance + b2·angle
    this.depth = new Map();
    this.dir = {}; // per period: 1 if home attacks +x in the incoming data, -1 if it attacks -x
  }
  team(c) { return c === 'H' ? this.meta.home : this.meta.away; }
  label(id) { const p = this.players.get(id); return p ? `#${p.no} ${p.short}` : ''; }
  short(id) { return this.players.get(id)?.short || ''; }

  /** Compact replay feed (tools/prepare_data.py) -> events */
  decode(json) {
    Object.assign(this.meta, json.meta);
    if (json.meta.xg) this.xg = json.meta.xg;
    const ids = json.players.map((p) => (this.players.set(p.id, p), p.id));
    const { types, strengthTypes, t0 = 0 } = json.meta;
    const P = (v) => (v ? [v[0] / 10, v[1] / 10] : null);
    const id = (i) => (i == null ? null : ids[i]);
    return json.events.map(([t, period, clock, type, team, p1, p2, s, e, st, strength, g, x, pos, vel]) => {
      const ev = {
        t: t0 + t, period, clock, type: types[type], team: team || null, p1: id(p1), p2: id(p2),
        start: P(s), end: P(e), strengthType: strengthTypes[st], strength, homeGoalie: !!(g & 1), awayGoalie: !!(g & 2), pos: null,
      };
      if (x) Object.assign(ev, x, x.a && { a: x.a.map(id) }, x.c && { c: x.c.map(id) });
      if (pos) {
        ev.pos = [];
        for (let i = 0, j = 0; i < pos.length; i += 3, j += 2) {
          ev.pos.push([ids[pos[i]], pos[i + 1] / 10, pos[i + 2] / 10, vel ? vel[j] / 10 : null, vel ? vel[j + 1] / 10 : null]);
        }
      }
      return this.orient(ev);
    });
  }

  /** One raw Wisehockey row (the CSV export's column names) -> event. Used by live feeds. */
  fromRow(r) {
    const ev = {
      t: num(r.Timestamp) ?? Date.now(), period: num(r.Period) || 1, clock: num(r.MatchClock) || 0, type: r.EventType,
      team: side(r.EventPrimaryTeam), p1: num(r.EventPrimaryPlayerId), p2: num(r.EventSecondaryPlayerId),
      start: xy(r.EventStartCoordinate), end: xy(r.EventEndCoordinate), strengthType: r.TeamStrengthType || 'FullStrength',
      strength: r.TeamStrength || '', homeGoalie: bool(r.HomeGoalieOnIce), awayGoalie: bool(r.AwayGoalieOnIce), pos: null,
    };
    switch (ev.type) {
      case 'Shot': ev.res = r.ShotResult; ev.xg = num(r.ShotXG) ?? undefined; break;
      case 'Pass': ev.res = r.PassResult; break;
      case 'BluelineCrossing': ev.res = r.BluelineCrossingResult; ev.dir = r.BluelineCrossingDirection; break;
      case 'Goal': ev.a = [num(r.GoalAssist1Id), num(r.GoalAssist2Id)].filter((v) => v != null); break;
      case 'Penalty': ev.why = r.PenaltyReason; break;
      case 'StoppageOfPlay': ev.why = r.StoppageOfPlayReason; break;
      case 'PuckControl':
        ev.st = r.PuckControlState;
        if (r.PuckControlContestingPlayerIds) ev.c = String(r.PuckControlContestingPlayerIds).split(',').map(Number);
        break;
      default:
    }
    const pos = [];
    for (let i = 1; i <= 12; i++) {
      const pid = num(r[`StartPlayerId${i}`]), c = xy(r[`StartPlayerCoordinates${i}`]);
      if (pid == null || !c) continue;
      this.register(pid, r[`StartPlayerName${i}`], side(r[`StartPlayerTeam${i}`]), c);
      const sp = num(r[`StartPlayerVelocity${i}`]), d = xy(r[`StartPlayerDirection${i}`]);
      pos.push([pid, c[0], c[1], sp != null && d ? sp * d[0] : null, sp != null && d ? sp * d[1] : null]);
    }
    if (pos.length) ev.pos = pos;
    return this.orient(ev);
  }

  /** Everything downstream assumes home attacks +x. Feeds where teams change ends are turned 180° per period,
   *  using where the home goalie stands (he defends -x once oriented). */
  orient(ev) {
    let d = this.dir[ev.period];
    if (d == null && ev.pos) {
      const home = ev.pos.filter(([id]) => this.players.get(id)?.team === 'H');
      const g = home.find(([id]) => this.players.get(id).goalie) || home.reduce((a, b) => (Math.abs(b[1]) > Math.abs(a?.[1] ?? 0) ? b : a), null);
      if (g && Math.abs(g[1]) > 20) d = this.dir[ev.period] = g[1] < 0 ? 1 : -1;
    }
    if (d === -1) {
      const r = (p) => p && [-p[0], -p[1]];
      ev.start = r(ev.start); ev.end = r(ev.end);
      if (ev.pos) ev.pos = ev.pos.map(([id, x, y, vx, vy]) => [id, -x, -y, vx == null ? null : -vx, vy == null ? null : -vy]);
    }
    return ev;
  }

  register(id, name, team, c) {
    let p = this.players.get(id);
    if (!p) {
      const m = /^#(\d+)\s+(.*)$/.exec(name || '') || [0, '', name || String(id)];
      p = { id, team: team || 'H', no: Number(m[1]) || '', name: m[2], short: m[2].split(' ').pop(), goalie: false };
      this.players.set(id, p);
    }
    // Live feeds don't flag goalies: a goalie lives near a goal line (|x| ~ 26 m), skaters don't.
    const d = this.depth.get(id) || [0, 0];
    d[0] += Math.abs(c[0]);
    d[1]++;
    this.depth.set(id, d);
    if (d[1] >= 5) p.goalie = d[0] / d[1] > 22;
  }
}
