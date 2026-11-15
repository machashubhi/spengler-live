// Match state: score, clock, phase, xG, moments, and the per-player numbers behind the archetype cards.
import { GOAL_X, PERIOD_S } from './util.js';

const PRESSURE_M = 3; // an opponent within 3 m of a passer/shooter counts as pressure

export class MatchState {
  constructor(model, otSeconds = 300) { this.model = model; this.otS = otSeconds; this.reset(); }
  length(period = this.period) { return period > 3 ? this.otS : PERIOD_S; }
  reset() {
    Object.assign(this, {
      phase: 'pregame', period: 1, clock: 0, clockT: 0, running: false, stop: null, periodEndT: null,
      score: { H: 0, A: 0 }, periods: [{ H: 0, A: 0 }], xg: { H: 0, A: 0 }, sog: { H: 0, A: 0 },
      strengthType: 'FullStrength', strength: '5v5', homeGoalie: true, awayGoalie: true,
      moments: [], goals: [], events: [], stats: new Map(), rev: 0, battle: null,
    });
  }
  player(id) {
    let s = this.stats.get(id);
    if (!s) this.stats.set(id, (s = { ent: 0, pcw: 0, pcn: 0, wall: 0 }));
    return s;
  }
  strengthLabel(team) {
    const opp = team === 'H' ? 'A' : 'H';
    if (!(opp === 'H' ? this.homeGoalie : this.awayGoalie)) return 'EN';
    if (this.strengthType === 'HomePowerplay') return team === 'H' ? 'PP' : 'SH';
    if (this.strengthType === 'AwayPowerplay') return team === 'A' ? 'PP' : 'SH';
    return '';
  }

  /** Apply one event; returns the visual effects it should trigger. */
  apply(ev) {
    const fx = [];
    const idx = this.events.push(ev) - 1;
    const isEnd = ev.type === 'StoppageOfPlay' && ev.why === 'PeriodEnd';
    if (!isEnd && (this.phase !== 'live' || ev.period !== this.period)) {
      if (this.phase !== 'live') fx.push({ kind: 'phase' });
      this.phase = 'live'; this.period = ev.period; this.periodEndT = null;
    }
    while (this.periods.length < ev.period) this.periods.push({ H: 0, A: 0 });
    Object.assign(this, { clock: ev.clock, clockT: ev.t, homeGoalie: ev.homeGoalie, awayGoalie: ev.awayGoalie });
    if (ev.strengthType) { this.strengthType = ev.strengthType; this.strength = ev.strength || this.strength; }
    const t = ev.team;
    switch (ev.type) {
      case 'StoppageOfPlay':
        this.running = false; this.stop = isEnd ? null : ev.why || 'Other'; // why play is stopped, until the next faceoff
        if (isEnd) {
          this.phase = ev.period >= 3 && this.score.H !== this.score.A ? 'final' : 'intermission';
          this.periodEndT = ev.t;
          this.moments.push({ kind: 'end', period: ev.period });
          fx.push({ kind: 'phase' });
        }
        break;
      case 'Faceoff': case 'PuckControl': this.running = true; this.stop = null; break;
      case 'Shot':
        if (!t) break;
        if (ev.res === 'Saved' || ev.res === 'Goal') this.sog[t]++;
        this.xg[t] += ev.xg || 0;
        fx.push({ kind: 'shot', ev });
        break;
      case 'Goal': {
        if (!t) break;
        this.score[t]++; this.periods[ev.period - 1][t]++; this.running = false;
        let xg = null;
        for (let i = idx - 1; i >= Math.max(0, idx - 15); i--) {
          const e = this.events[i];
          if (e.type === 'Shot' && e.res === 'Goal' && e.team === t) { xg = e.xg ?? null; break; }
        }
        const m = { kind: 'goal', idx, period: ev.period, clock: ev.clock, team: t, scorer: ev.p1, assists: ev.a || [],
          strength: this.strengthLabel(t), score: { ...this.score }, xg };
        this.moments.push(m); this.goals.push(m);
        fx.push({ kind: 'goal', moment: m });
        if (ev.period >= 4) { this.phase = 'final'; fx.push({ kind: 'phase' }); }
        break;
      }
      case 'Penalty': { // the export sometimes repeats a penalty row
        const p = this.moments[this.moments.length - 1];
        if (p?.kind === 'pen' && p.clock === ev.clock && p.player === ev.p1) break;
        const m = { kind: 'pen', period: ev.period, clock: ev.clock, team: t, player: ev.p1, why: ev.why };
        this.moments.push(m);
        fx.push({ kind: 'pen', moment: m });
        break;
      }
      case 'Pass': case 'Dump': case 'Clear': fx.push({ kind: 'pass', ev }); break;
      default:
    }
    this.tally(ev);
    return fx;
  }

  // ---- archetype numbers, all from the event stream so they update live
  tally(ev) {
    const t = ev.team;
    switch (ev.type) {
      case 'Shot':
        if (ev.res === 'Blocked') { const b = this.blocker(ev); if (b != null) this.player(b).wall++; }
        this.pressure(ev);
        break;
      case 'Pass': this.pressure(ev); break;
      case 'PuckControl':
        if (ev.st === 'Contested' && ev.c) { this.battle = ev.c; break; }
        if (/Control$/.test(ev.st || '') && this.battle) {
          for (const id of this.battle) this.player(id).pcn++;
          if (this.battle.includes(ev.p1)) this.player(ev.p1).pcw++;
          this.battle = null;
        }
        break;
      case 'BluelineCrossing': // carried over the opponent's blue line with possession kept
        if (t && ev.p1 != null && ev.dir === 'TowardsOpponent' && ev.res === 'PossessionMaintained' && ev.start && ev.start[0] > 0 === (t === 'H')) this.player(ev.p1).ent++;
        break;
      case 'Faceoff': case 'StoppageOfPlay': this.battle = null; break;
      default: return;
    }
    this.rev++;
  }
  skaters(ev, team) { // opposing skaters in this event's snapshot
    return (ev.pos || []).filter(([id]) => { const p = this.model.players.get(id); return p && p.team !== team && !p.goalie; });
  }
  pressure(ev) {
    const me = ev.pos?.find((p) => p[0] === ev.p1);
    if (!me || !ev.team) return;
    for (const [id, x, y] of this.skaters(ev, ev.team)) if (Math.hypot(x - me[1], y - me[2]) < PRESSURE_M) this.player(id).wall++;
  }
  blocker(ev) { // nearest opposing skater to the shooting lane
    const me = ev.pos?.find((p) => p[0] === ev.p1);
    if (!me) return null;
    const gx = ev.team === 'H' ? GOAL_X : -GOAL_X, dx = gx - me[1], dy = -me[2], L2 = dx * dx + dy * dy;
    let best = null, bo = 2;
    for (const [id, x, y] of this.skaters(ev, ev.team)) {
      const u = ((x - me[1]) * dx + (y - me[2]) * dy) / L2;
      const off = Math.abs(dx * (me[2] - y) - (me[1] - x) * dy) / Math.sqrt(L2);
      if (u > 0 && u < 1 && off < bo) { bo = off; best = id; }
    }
    return best;
  }
  clockAt(P) { // elapsed seconds in the period at presentation time P
    if (this.phase !== 'live') return this.phase === 'pregame' ? 0 : this.length();
    return Math.min(this.length(), this.clock + (this.running ? Math.min(Math.max(0, (P - this.clockT) / 1000), 2.5) : 0));
  }
}