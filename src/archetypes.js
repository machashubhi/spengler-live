// Three player archetypes, each built on a stat that explains hockey beyond goals, assists and shots.
// Numbers come from the live event stream (state.js), so the cards update as the game goes on.
import { esc, plural } from './util.js';

const I = { // 24px stroke icons
  breaker: '<path d="M14 3v18"/><path d="M3 12h13M12 8l4 4-4 4"/>',
  hound: '<circle cx="12" cy="12" r="3.5"/><path d="M4 4l4 4M20 4l-4 4M4 20l4-4M20 20l-4-4"/>',
  wall: '<path d="M12 2 4 5v6c0 5 3.5 9 8 11 4.5-2 8-6 8-11V5z"/><path d="M8 11h8M8 15h8"/>',
};

const ARCHETYPES = [
  {
    key: 'breaker', name: 'Zone Breaker', stat: 'Controlled zone entries', line: 'Carries the puck into the zone',
    score: (s) => s.ent, team: (s) => s.ent, teamFmt: (v) => v,
    proof: (s) => plural(s.ent, 'carry-in'), min: (s) => s.ent > 0,
    why: 'Crossing the blue line with the puck, instead of dumping it in and chasing, keeps possession. Studies of zone entries find carry-ins lead to far more shots than dump-ins.',
  },
  {
    key: 'hound', name: 'Puck Hound', stat: 'Puck battles won', line: 'Wins the loose pucks',
    score: (s) => s.pcw + s.pcw / (s.pcn || 1) / 100, team: (s) => s.pcw, teamFmt: (v) => v,
    proof: (s) => `${s.pcw} of ${s.pcn} battles won`, min: (s) => s.pcw > 0,
    why: 'Hockey is a possession game. Every loose puck won along the boards is a chance to attack; every one lost is a shift spent defending.',
  },
  {
    key: 'wall', name: 'The Wall', stat: 'Pressure & blocked shots', line: 'Shuts the door',
    score: (s) => s.wall, team: (s) => s.wall, teamFmt: (v) => v,
    proof: (s) => `${s.wall} pressures & blocks`, min: (s) => s.wall > 0,
    why: 'Good defending rarely reaches the scoresheet. Closing within a stick-length of passers and shooters forces rushed plays and weaker shots.',
  },
];

export class ArchetypeCards {
  constructor(root, model, onPick) {
    this.model = model; this.rev = -1;
    root.innerHTML = ARCHETYPES.map((a) => `<article class="arc" data-k="${a.key}">
      <header><svg viewBox="0 0 24 24" aria-hidden="true">${I[a.key]}</svg><div><h4>${a.name}</h4><small>${a.stat}</small></div></header>
      <p class="arc-line">${a.line}</p>
      <div class="arc-team"><b class="H"></b><span class="bar"><i class="H"></i><i class="A"></i></span><b class="A"></b></div>
      <div class="arc-lead"><button type="button" class="H"></button><button type="button" class="A"></button></div>
      <p class="arc-why">${a.why}</p></article>`).join('');
    this.cards = ARCHETYPES.map((a) => ({ a, el: root.querySelector(`[data-k="${a.key}"]`) }));
    root.onclick = (e) => { const b = e.target.closest('button[data-id]'); if (b) onPick(+b.dataset.id); };
  }
  render(state, force) {
    if (!force && state.rev === this.rev) return;
    this.rev = state.rev;
    const rows = [...state.stats].map(([id, s]) => [id, s, this.model.players.get(id)]).filter((r) => r[2] && !r[2].goalie);
    for (const { a, el } of this.cards) {
      const tot = { H: 0, A: 0 }, top = { H: null, A: null };
      for (const [id, s, p] of rows) {
        tot[p.team] += a.team(s);
        if (a.min(s) && (!top[p.team] || a.score(s) > a.score(top[p.team][1]))) top[p.team] = [id, s];
      }
      const sum = tot.H + tot.A;
      el.querySelector('b.H').textContent = a.teamFmt(tot.H);
      el.querySelector('b.A').textContent = a.teamFmt(tot.A);
      el.querySelector('i.H').style.width = `${sum ? (100 * tot.H) / sum : 50}%`;
      el.querySelector('i.A').style.width = `${sum ? (100 * tot.A) / sum : 50}%`;
      for (const t of ['H', 'A']) {
        const b = el.querySelector(`button.${t}`), lead = top[t];
        b.disabled = !lead;
        if (lead) b.dataset.id = lead[0]; else delete b.dataset.id;
        b.innerHTML = lead
          ? `<i class="dot ${t}"></i><span>${esc(this.model.label(lead[0]))}</span><small>${esc(a.proof(lead[1]))}</small>`
          : `<i class="dot ${t}"></i><span>${esc(this.model.team(t).code)}</span><small>No leader yet</small>`;
      }
    }
  }
}
