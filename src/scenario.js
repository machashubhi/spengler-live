// What-If set-up for one goal: the moment three passes before it, rotated so the scorers attack right.
import { Motion } from './motion.js';
import { GOAL_X, dist } from './util.js';

export function buildScenario(state, model, m) {
  const evs = state.events, g = evs[m.idx], team = g.team;
  let si = m.idx; // the shot that went in
  for (let i = m.idx - 1; i >= Math.max(0, m.idx - 15); i--) if (evs[i].type === 'Shot' && evs[i].res === 'Goal') { si = i; break; }
  const shot = evs[si];
  let fo = 0; // last faceoff (or period start) before the shot
  for (let i = si - 1; i >= 0; i--) {
    if (evs[i].period !== shot.period) { fo = i + 1; break; }
    if (evs[i].type === 'Faceoff') { fo = i; break; }
  }
  const passes = [];
  for (let i = fo; i < si; i++) {
    const e = evs[i];
    if (e.type === 'Pass' && e.team === team && e.res === 'Successful' && shot.clock - e.clock <= 25) passes.push(i);
  }
  const start = passes.length ? passes[Math.max(0, passes.length - 3)] : fo;
  let carrier = passes.length ? evs[start].p1 : null;
  for (let i = fo; carrier == null && i < si; i++) if (evs[i].team === team && evs[i].p1 != null) carrier = evs[i].p1;

  // Mirrored copy of the play (+3 s lead-in so the motion curves start smoothly)
  let from = start;
  while (from > fo && evs[start].t - evs[from - 1].t < 3000) from--;
  const k = team === 'H' ? 1 : -1, M = (p) => p && [p[0] * k, p[1] * k];
  const events = evs.slice(from, m.idx + 1).map((e) => ({
    ...e, start: M(e.start), end: M(e.end),
    pos: e.pos && e.pos.map(([id, x, y, vx, vy]) => [id, x * k, y * k, vx == null ? null : vx * k, vy == null ? null : vy * k]),
  }));

  const chain = [];
  for (const i of passes.filter((i) => i >= start)) {
    const e = evs[i];
    if (chain[chain.length - 1] !== model.short(e.p1)) chain.push(model.short(e.p1));
    chain.push(model.short(e.p2));
  }
  if (!passes.length && evs[start].type === 'Faceoff') chain.push(`${model.short(carrier)} wins the draw`);
  if (chain[chain.length - 1] !== model.short(shot.p1 ?? g.p1)) chain.push(model.short(shot.p1 ?? g.p1));

  return {
    key: `${m.period}-${m.clock}-${team}`, team, moment: m, scorer: g.p1, realXg: m.xg, realShot: M(shot.start),
    chain, carrier, t0: evs[start].t, tEnd: g.t, events, puck0: M(evs[start].start),
  };
}

/** Positions at the start of a scenario, from the same motion engine as the live rink. */
export function scenarioStart(scn, model) {
  const mo = scn.motion || (scn.motion = (() => { const m = new Motion(model); scn.events.forEach((e) => m.ingest(e)); return m; })());
  const { players } = mo.sample(scn.t0);
  const list = players.map(([id, x, y]) => ({ id, x, y, team: model.players.get(id)?.team, goalie: !!model.players.get(id)?.goalie }));
  let c = list.find((p) => p.id === scn.carrier);
  const ref = scn.puck0 || [0, 0];
  if (!c) c = list.filter((p) => p.team === scn.team && !p.goalie).sort((a, b) => dist([a.x, a.y], ref) - dist([b.x, b.y], ref))[0];
  const toward = scn.puck0 && dist([c.x, c.y], ref) > 0.3 ? ref : [GOAL_X, 0];
  const d = dist([c.x, c.y], toward) || 1;
  return { players: list, carrier: c.id, puck: [c.x + ((toward[0] - c.x) / d) * 0.8, c.y + ((toward[1] - c.y) / d) * 0.8] };
}
