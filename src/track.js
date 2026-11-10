import { pointInPolygon } from './detect.js';

const side = (a, b, p) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);

function crossesLine(p, q, line) {
  const a = { x: line.x1, y: line.y1 };
  const b = { x: line.x2, y: line.y2 };
  const s1 = side(a, b, p);
  const s2 = side(a, b, q);
  if (!((s1 < 0 && s2 >= 0) || (s1 > 0 && s2 <= 0))) return false;
  // also require the line segment itself (not its infinite extension) to straddle p->q
  return side(p, q, a) * side(p, q, b) <= 0;
}

/**
 * Nearest-neighbour centroid tracker. Blobs are { x, y, color }. Coordinates of
 * `region` / `line` must be in the same space as the blobs.
 * mode 'region': one event when a track first appears inside `region` (or anywhere if null).
 * mode 'line':   one event when a track's path crosses `line` {x1,y1,x2,y2}.
 */
export class Tracker {
  constructor(o = {}) {
    this.mode = o.mode || 'region';
    this.region = o.region || null;
    this.line = o.line || null;
    this.maxDist = o.maxDist ?? 40;
    this.maxMiss = o.maxMiss ?? 0.4;
    this.confirm = o.confirmFrames ?? 1;
    this.debounce = o.debounceSec ?? 0.25;
    this.tracks = [];
    this.recent = [];
    this.nextId = 1;
  }

  update(blobs, t) {
    const events = [];
    const pairs = [];
    this.tracks.forEach((tr, ti) => {
      blobs.forEach((b, bi) => {
        if (tr.color !== b.color) return;
        const d = Math.hypot(tr.x - b.x, tr.y - b.y);
        if (d <= this.maxDist) pairs.push({ ti, bi, d });
      });
    });
    pairs.sort((a, b) => a.d - b.d);
    const usedT = new Set();
    const usedB = new Set();
    for (const p of pairs) {
      if (usedT.has(p.ti) || usedB.has(p.bi)) continue;
      usedT.add(p.ti);
      usedB.add(p.bi);
      const tr = this.tracks[p.ti];
      const b = blobs[p.bi];
      tr.px = tr.x; tr.py = tr.y;
      tr.x = b.x; tr.y = b.y;
      tr.lastT = t;
      tr.hits++;
      this.#check(tr, t, events);
    }
    blobs.forEach((b, bi) => {
      if (usedB.has(bi)) return;
      const tr = { id: this.nextId++, color: b.color, x: b.x, y: b.y, px: null, py: null, lastT: t, hits: 1, counted: false, crossed: false };
      this.tracks.push(tr);
      this.#check(tr, t, events);
    });
    this.tracks = this.tracks.filter((tr) => t - tr.lastT <= this.maxMiss);
    this.recent = this.recent.filter((r) => t - r.t <= this.debounce);
    return events;
  }

  #check(tr, t, events) {
    if (tr.counted) return;
    if (this.mode === 'line' && tr.px !== null && this.line && crossesLine({ x: tr.px, y: tr.py }, tr, this.line)) tr.crossed = true;
    if (tr.hits < this.confirm) return;
    const hit = this.mode === 'line' ? tr.crossed : !this.region || pointInPolygon(tr.x, tr.y, this.region);
    if (!hit) return;
    tr.counted = true;
    // a track lost and re-found right next to a fresh event is the same ball
    const dup = this.recent.some((r) => r.color === tr.color && Math.hypot(r.x - tr.x, r.y - tr.y) <= this.maxDist);
    if (dup) return;
    const ev = { t, color: tr.color, x: tr.x, y: tr.y };
    this.recent.push(ev);
    events.push(ev);
  }
}
