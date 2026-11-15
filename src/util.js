// Small shared helpers. Units: metres, seconds; Wisehockey axes (home attacks +x).
export const GOAL_X = 26.03; // goal line, from hockey_rink's IIHF geometry
export const PERIOD_S = 1200;

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const sigmoid = (z) => 1 / (1 + Math.exp(-z));
export const unit = (a, b) => {
  const d = dist(a, b) || 1;
  return [(b[0] - a[0]) / d, (b[1] - a[1]) / d];
};
export const add = (a, v, k = 1) => [a[0] + v[0] * k, a[1] + v[1] * k];
export const stepTo = (p, t, max) => (dist(p, t) <= max ? t.slice() : add(p, unit(p, t), max));
export const angDiff = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
export const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
export const mmss = (s) => {
  s = Math.max(0, Math.round(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
export const ordinal = (n) => ['', '1st', '2nd', '3rd'][n] || 'OT';
export const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
export const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// Keep a point inside the boards (60 x 30 m, 8.53 m corner radius), m metres from the edge.
export function inIce(x, y, m) {
  const hx = 30 - m, hy = 15 - m, r = 8.53 - m, cx = hx - r, cy = hy - r;
  x = clamp(x, -hx, hx);
  y = clamp(y, -hy, hy);
  const dx = Math.abs(x) - cx, dy = Math.abs(y) - cy;
  if (dx > 0 && dy > 0) {
    const d = Math.hypot(dx, dy);
    if (d > r) { x = Math.sign(x) * (cx + (dx * r) / d); y = Math.sign(y) * (cy + (dy * r) / d); }
  }
  return [x, y];
}

export function svg(tag, attrs, parent) {
  const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}

export const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};
