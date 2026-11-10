import { PHASE_KEYS, DEFAULT_PHASES, MATCH_LEN } from './metrics.js';

export const COLORS = { purple: '#a855f7', green: '#22c55e', other: '#9ca3af' };
const ACCENT = '#14b8a6';
const BANDS = { auto: 'rgba(20,184,166,.20)', transition: 'rgba(148,163,184,.14)', teleop: 'rgba(59,130,246,.12)', endgame: 'rgba(245,158,11,.20)' };

export function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v === true) n.setAttribute(k, '');
    else if (v !== false && v != null) n.setAttribute(k, v);
  }
  for (const c of kids.flat()) n.append(c instanceof Node ? c : String(c));
  return n;
}

export const fmt = (n, d = 2) => (n == null || Number.isNaN(n) ? '-' : n.toFixed(d));
export function fmtTime(t) {
  const sign = t < 0 ? '-' : '';
  const a = Math.abs(t);
  return `${sign}${Math.floor(a / 60)}:${(a % 60).toFixed(1).padStart(4, '0')}`;
}

let toastTimer;
export function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3200);
}

function table(headers, rows) {
  return el('div', { class: 'tablewrap' }, el('table', {},
    el('thead', {}, el('tr', {}, headers.map(([h, num]) => el('th', { class: num ? 'num' : '' }, h)))),
    el('tbody', {}, rows)));
}

export function renderMatchTable(box, rows, { onOpen, onDelete }) {
  box.replaceChildren();
  if (!rows.length) return box.append(el('p', { class: 'muted' }, 'No matches yet. Load a video above to get started.'));
  box.append(table(
    [['Match'], ['Teams'], ['Alliance'], ['Shots', 1], ['Purple', 1], ['Green', 1], ['Balls/s', 1], ['Peak 5s', 1], ['Cycle s', 1], ['']],
    rows.map(({ match: m, m: x }) => el('tr', {},
      el('td', {}, m.matchNo), el('td', {}, (m.teams || []).join(', ')), el('td', {}, m.alliance),
      el('td', { class: 'num' }, x.total), el('td', { class: 'num' }, x.byColor.purple), el('td', { class: 'num' }, x.byColor.green),
      el('td', { class: 'num' }, fmt(x.rate, 3)), el('td', { class: 'num' }, fmt(x.burst.rate, 1)), el('td', { class: 'num' }, fmt(x.avgCycleTime, 1)),
      el('td', {}, el('button', { class: 'primary', onclick: () => onOpen(m.id) }, 'Open'), ' ',
        el('button', { class: 'danger', onclick: () => onDelete(m.id) }, 'Delete'))))));
}

export function renderTeamTable(box, aggs) {
  box.replaceChildren();
  if (!aggs.length) return box.append(el('p', { class: 'muted' }, 'Team averages appear once matches have teams.'));
  box.append(table(
    [['Team'], ['Matches', 1], ['Shots', 1], ['Avg balls/s', 1], ['Avg peak 5s', 1], ['Avg cycle s', 1]],
    aggs.map((a) => el('tr', {}, el('td', {}, a.team), el('td', { class: 'num' }, a.matches), el('td', { class: 'num' }, a.totalShots),
      el('td', { class: 'num' }, fmt(a.avgRate, 3)), el('td', { class: 'num' }, fmt(a.avgPeak, 2)), el('td', { class: 'num' }, fmt(a.avgCycleTime, 1))))));
}

export function renderMetrics(cardsBox, phaseBox, m) {
  const stat = (v, label) => el('div', { class: 'stat' }, el('b', {}, v), el('span', {}, label));
  cardsBox.replaceChildren(
    stat(m.total, `shots (${m.byColor.purple} purple, ${m.byColor.green} green)`),
    stat(fmt(m.rate, 3), 'balls/sec, whole match'),
    stat(fmt(m.burst.rate, 1), `peak 5 s burst (${m.burst.count} balls)`),
    stat(m.cycleCount, 'cycles'),
    stat(m.avgCycleTime == null ? '-' : `${fmt(m.avgCycleTime, 1)} s`, 'avg cycle time (start to start)'),
    stat(fmt(m.avgBallsPerCycle, 1), 'balls per cycle'),
  );
  phaseBox.replaceChildren(table(
    [['Phase'], ['Purple', 1], ['Green', 1], ['Total', 1], ['Balls/s', 1]],
    PHASE_KEYS.map((k) => {
      const p = m.byPhase[k];
      return el('tr', {}, el('td', {}, k), el('td', { class: 'num' }, p.purple), el('td', { class: 'num' }, p.green),
        el('td', { class: 'num' }, p.count), el('td', { class: 'num' }, fmt(p.rate, 3)));
    })));
}

export function renderEventList(box, events, selectedId, h) {
  box.replaceChildren();
  if (!events.length) return box.append(el('p', { class: 'muted' }, 'No events. Press A while the video is paused on a shot to add one.'));
  for (const e of events) {
    const sel = el('select', { 'aria-label': 'color', onchange: (ev) => h.onColor(e.id, ev.target.value), onclick: (ev) => ev.stopPropagation() },
      ['purple', 'green', 'other'].map((c) => el('option', { value: c, selected: c === e.color }, c)));
    box.append(el('div', { class: `ev${e.id === selectedId ? ' sel' : ''}`, 'data-id': e.id, onclick: () => h.onSelect(e.id) },
      el('span', { class: 'mono' }, fmtTime(e.t)),
      el('span', {}, el('i', { class: 'dot', style: `background:${COLORS[e.color]}` }), sel),
      el('span', { class: 'phase muted' }, e.phase), el('span', { class: 'src muted' }, e.source),
      el('button', { class: 'danger', title: 'Delete', 'aria-label': 'Delete event', onclick: (ev) => { ev.stopPropagation(); h.onDelete(e.id); } }, 'x')));
  }
  box.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
}

function prep(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const r = canvas.getBoundingClientRect();
  const w = Math.max(1, r.width);
  const h = Math.max(1, r.height);
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

export function drawTimeline(canvas, { events, playhead, selectedId, duration = MATCH_LEN }) {
  const { ctx, w, h } = prep(canvas);
  const X = (t) => (Math.min(Math.max(t, 0), duration) / duration) * w;
  ctx.font = '11px system-ui, sans-serif';
  for (const k of PHASE_KEYS) {
    const p = DEFAULT_PHASES[k];
    ctx.fillStyle = BANDS[k];
    ctx.fillRect(X(p.start), 0, X(p.end) - X(p.start), h);
    ctx.fillStyle = 'rgba(230,237,243,.55)';
    ctx.fillText(k, X(p.start) + 4, 12);
  }
  ctx.fillStyle = 'rgba(230,237,243,.4)';
  for (let t = 0; t <= duration; t += 10) {
    ctx.fillRect(X(t), h - 8, 1, 8);
    if (t % 30 === 0) ctx.fillText(`${t}s`, Math.min(X(t) + 2, w - 24), h - 10);
  }
  for (const e of events) {
    const x = X(e.t);
    ctx.fillStyle = COLORS[e.color] || COLORS.other;
    ctx.fillRect(x - 1.5, 20, 3, h - 34);
    if (e.source === 'manual') { ctx.beginPath(); ctx.arc(x, 18, 3, 0, 7); ctx.fill(); }
    if (e.id === selectedId) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.strokeRect(x - 4, 18, 8, h - 30); }
  }
  if (playhead != null) {
    ctx.fillStyle = ACCENT;
    ctx.fillRect(X(playhead) - 1, 0, 2, h);
  }
}

/** Map a click on the timeline to { eventId } (within 8px of a tick) or { t }. */
export function timelineHit(canvas, clientX, events, duration = MATCH_LEN) {
  const r = canvas.getBoundingClientRect();
  const x = clientX - r.left;
  const t = (x / r.width) * duration;
  let best = null, bd = 8;
  for (const e of events) {
    const d = Math.abs((e.t / duration) * r.width - x);
    if (d <= bd) { bd = d; best = e; }
  }
  return best ? { eventId: best.id, t: best.t } : { t };
}

export function drawChart(canvas, series, peak, duration = MATCH_LEN) {
  const { ctx, w, h } = prep(canvas);
  const padL = 26, padB = 16, padT = 6;
  const max = Math.max(1, ...series.map((s) => s.rate)) * 1.1;
  const X = (t) => padL + (t / duration) * (w - padL - 4);
  const Y = (r) => padT + (1 - r / max) * (h - padT - padB);
  ctx.font = '10px system-ui, sans-serif';
  ctx.strokeStyle = 'rgba(139,154,176,.25)';
  ctx.fillStyle = 'rgba(139,154,176,.8)';
  for (let i = 0; i <= 2; i++) {
    const v = (max * i) / 2;
    ctx.beginPath(); ctx.moveTo(padL, Y(v)); ctx.lineTo(w - 4, Y(v)); ctx.stroke();
    ctx.fillText(v.toFixed(1), 0, Y(v) + 3);
  }
  for (let t = 0; t <= duration; t += 30) ctx.fillText(`${t}`, X(t), h - 3);
  if (!series.length) return;
  ctx.beginPath();
  series.forEach((s, i) => (i ? ctx.lineTo(X(s.t), Y(s.rate)) : ctx.moveTo(X(s.t), Y(s.rate))));
  ctx.strokeStyle = ACCENT; ctx.lineWidth = 2; ctx.stroke();
  ctx.lineTo(X(series[series.length - 1].t), Y(0)); ctx.lineTo(X(series[0].t), Y(0)); ctx.closePath();
  ctx.fillStyle = 'rgba(20,184,166,.18)'; ctx.fill();
  if (peak?.start != null) {
    ctx.fillStyle = '#f59e0b';
    ctx.beginPath(); ctx.arc(X(peak.start + 5), Y(peak.rate), 3.5, 0, 7); ctx.fill();
  }
}

const poly = (ctx, pts, W, H) => { ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p.x * W, p.y * H) : ctx.moveTo(p.x * W, p.y * H))); };

/** Click-to-draw geometry editor over the video overlay canvas (normalized coordinates). */
export class Calibrator {
  constructor(canvas, { getProfile, onChange, onPick, onTool }) {
    Object.assign(this, { canvas, getProfile, onChange, onPick, onTool, tool: null, draft: [] });
    canvas.addEventListener('click', (e) => this.click(e));
  }

  setTool(tool) {
    this.tool = this.tool === tool ? null : tool;
    this.draft = [];
    this.onTool(this.tool);
  }

  click(e) {
    if (!this.tool) return;
    const r = this.canvas.getBoundingClientRect();
    const p = { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
    if (this.tool.startsWith('pick')) {
      this.onPick(this.tool === 'pickPurple' ? 'purple' : 'green', p);
      this.tool = null; this.onTool(null);
    } else if (this.tool === 'line') {
      this.draft.push(p);
      if (this.draft.length === 2) {
        const [a, b] = this.draft;
        this.getProfile().scoreLine = { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
        this.done();
      }
    } else {
      const f = this.draft[0];
      if (f && this.draft.length >= 3 && Math.hypot((p.x - f.x) * r.width, (p.y - f.y) * r.height) < 14) this.finish();
      else this.draft.push(p);
    }
    this.onChange();
  }

  finish() {
    if (!this.tool || this.tool.startsWith('pick') || this.tool === 'line' || this.draft.length < 3) return;
    this.getProfile()[this.tool === 'roi' ? 'roi' : 'launchRoi'] = this.draft;
    this.done();
    this.onChange();
  }

  done() { this.draft = []; this.tool = null; this.onTool(null); }

  draw(ctx) {
    const W = this.canvas.width, H = this.canvas.height;
    const p = this.getProfile();
    ctx.lineWidth = Math.max(2, W / 400);
    if (p.roi?.length >= 3) {
      poly(ctx, p.roi, W, H); ctx.closePath();
      ctx.fillStyle = 'rgba(20,184,166,.14)'; ctx.fill(); ctx.strokeStyle = ACCENT; ctx.stroke();
    }
    if (p.launchRoi?.length >= 3) {
      poly(ctx, p.launchRoi, W, H); ctx.closePath();
      ctx.setLineDash([10, 6]); ctx.strokeStyle = '#f59e0b'; ctx.stroke(); ctx.setLineDash([]);
    }
    if (p.scoreLine) {
      const l = p.scoreLine;
      ctx.beginPath(); ctx.moveTo(l.x1 * W, l.y1 * H); ctx.lineTo(l.x2 * W, l.y2 * H);
      ctx.strokeStyle = p.mode === 'line' ? '#f43f5e' : 'rgba(244,63,94,.45)'; ctx.stroke();
    }
    if (this.draft.length) {
      poly(ctx, this.draft, W, H);
      ctx.strokeStyle = '#fff'; ctx.stroke();
      ctx.fillStyle = '#fff';
      for (const d of this.draft) { ctx.beginPath(); ctx.arc(d.x * W, d.y * H, Math.max(3, W / 200), 0, 7); ctx.fill(); }
    }
  }
}
