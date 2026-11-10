export const PHASE_KEYS = ['auto', 'transition', 'teleop', 'endgame'];
// Endgame is carved out of the 2:00 teleop period, so phases do not overlap.
export const DEFAULT_PHASES = {
  auto: { start: 0, end: 30 },
  transition: { start: 30, end: 38 },
  teleop: { start: 38, end: 128 },
  endgame: { start: 128, end: 158 },
};
export const MATCH_LEN = 158;

export function phaseAt(t, phases = DEFAULT_PHASES) {
  for (const k of PHASE_KEYS) if (t < phases[k].end) return k;
  return 'endgame';
}

/** Cluster events; a gap strictly greater than gapSec starts a new cycle. */
export function findCycles(events, gapSec = 3) {
  const ts = events.map((e) => e.t).sort((a, b) => a - b);
  const out = [];
  for (const t of ts) {
    const c = out[out.length - 1];
    if (c && t - c.end <= gapSec) { c.end = t; c.count++; }
    else out.push({ start: t, end: t, count: 1 });
  }
  return out;
}

/** Events per second over trailing `window` seconds, sampled every `step`. */
export function rollingRate(events, duration, window = 5, step = 1) {
  const out = [];
  for (let t = 0; t <= duration + 1e-9; t += step) {
    let n = 0;
    for (const e of events) if (e.t > t - window && e.t <= t) n++;
    out.push({ t, rate: n / window });
  }
  return out;
}

/**
 * avgCycleTime = mean start-to-start interval between consecutive cycles (null with < 2 cycles).
 * avgCycleSpan = mean first-to-last-shot time inside a cycle.
 */
export function metrics(events, phases = DEFAULT_PHASES, opts = {}) {
  const gapSec = opts.gapSec ?? 3;
  const burstSec = opts.burstSec ?? 5;
  const lo = Math.min(...PHASE_KEYS.map((k) => phases[k].start));
  const hi = Math.max(...PHASE_KEYS.map((k) => phases[k].end));
  const duration = opts.duration ?? hi - lo;

  const byColor = { purple: 0, green: 0, other: 0 };
  const byPhase = {};
  for (const k of PHASE_KEYS) {
    const d = phases[k].end - phases[k].start;
    byPhase[k] = { count: 0, purple: 0, green: 0, other: 0, duration: d, rate: 0 };
  }
  for (const e of events) {
    const c = e.color in byColor ? e.color : 'other';
    byColor[c]++;
    const p = byPhase[e.phase] ? e.phase : phaseAt(e.t, phases);
    byPhase[p].count++;
    byPhase[p][c]++;
  }
  for (const k of PHASE_KEYS) byPhase[k].rate = byPhase[k].count / byPhase[k].duration;

  const ts = events.map((e) => e.t).sort((a, b) => a - b);
  let best = 0, bestStart = null, j = 0;
  for (let i = 0; i < ts.length; i++) {
    if (j < i) j = i;
    while (j < ts.length && ts[j] < ts[i] + burstSec) j++;
    if (j - i > best) { best = j - i; bestStart = ts[i]; }
  }

  const cycles = findCycles(events, gapSec);
  const n = cycles.length;
  return {
    total: events.length,
    duration,
    byColor,
    byPhase,
    rate: duration > 0 ? events.length / duration : 0,
    burst: { count: best, rate: best / burstSec, start: bestStart },
    cycles,
    cycleCount: n,
    avgCycleTime: n > 1 ? (cycles[n - 1].start - cycles[0].start) / (n - 1) : null,
    avgCycleSpan: n ? cycles.reduce((a, c) => a + (c.end - c.start), 0) / n : null,
    avgBallsPerCycle: n ? events.length / n : null,
  };
}

/** Per-team averages across every match the team appears in. */
export function teamAggregates(matches, opts = {}) {
  const teams = new Map();
  for (const m of matches) {
    const mm = metrics(m.events, DEFAULT_PHASES, opts);
    for (const t of m.teams || []) {
      const key = String(t);
      if (!teams.has(key)) teams.set(key, []);
      teams.get(key).push(mm);
    }
  }
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  return [...teams.entries()]
    .map(([team, ms]) => ({
      team,
      matches: ms.length,
      totalShots: ms.reduce((a, m) => a + m.total, 0),
      avgRate: mean(ms.map((m) => m.rate)),
      avgPeak: mean(ms.map((m) => m.burst.rate)),
      avgCycleTime: mean(ms.filter((m) => m.avgCycleTime !== null).map((m) => m.avgCycleTime)),
    }))
    .sort((a, b) => b.avgRate - a.avgRate || a.team.localeCompare(b.team, undefined, { numeric: true }));
}
