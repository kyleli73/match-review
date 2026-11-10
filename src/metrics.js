export const PHASE_KEYS = ['auto', 'transition', 'teleop', 'flower'];
export const ELEMENT_LIMIT = 4; // a robot may CONTROL at most 4 scoring elements (G408)
export const TIP_POINTS = 20;
export const RP_TIPS = { pollinator1: 4, pollinator2: 7 };
// The flower phase is the last 60 s of the match (flower scoring allowed); phases do not overlap.
export const DEFAULT_PHASES = {
  auto: { start: 0, end: 30 },
  transition: { start: 30, end: 38 },
  teleop: { start: 38, end: 98 },
  flower: { start: 98, end: 158 },
};
export const MATCH_LEN = 158;

export function phaseAt(t, phases = DEFAULT_PHASES) {
  for (const k of PHASE_KEYS) if (t < phases[k].end) return k;
  return 'flower';
}

/** Normalize stored events: old purple/green colors become 'other'; missing kind becomes 'launch'. */
export function migrateEvent(e) {
  const color = ['pollen', 'red', 'blue', 'other'].includes(e.color) ? e.color : 'other';
  return { ...e, color, kind: e.kind === 'tip' ? 'tip' : 'launch' };
}
export const migrateMatch = (m) => ({ ...m, events: (m.events || []).map(migrateEvent) });
export const isTip = (e) => e.kind === 'tip';

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
export function metrics(allEvents, phases = DEFAULT_PHASES, opts = {}) {
  const tipEvents = allEvents.filter(isTip);
  const events = allEvents.filter((e) => !isTip(e)); // tips never count as launches
  const gapSec = opts.gapSec ?? 3;
  const burstSec = opts.burstSec ?? 5;
  const lo = Math.min(...PHASE_KEYS.map((k) => phases[k].start));
  const hi = Math.max(...PHASE_KEYS.map((k) => phases[k].end));
  const duration = opts.duration ?? hi - lo;

  const byColor = { pollen: 0, red: 0, blue: 0, other: 0 };
  const byPhase = {};
  for (const k of PHASE_KEYS) {
    const d = phases[k].end - phases[k].start;
    byPhase[k] = { count: 0, pollen: 0, red: 0, blue: 0, other: 0, tips: 0, duration: d, rate: 0 };
  }
  for (const e of events) {
    const c = e.color in byColor ? e.color : 'other';
    byColor[c]++;
    const p = byPhase[e.phase] ? e.phase : phaseAt(e.t, phases);
    byPhase[p].count++;
    byPhase[p][c]++;
  }
  for (const e of tipEvents) byPhase[byPhase[e.phase] ? e.phase : phaseAt(e.t, phases)].tips++;
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
  const tipCount = tipEvents.length;
  const tips = { total: tipCount, auto: byPhase.auto.tips, teleop: tipCount - byPhase.auto.tips };
  return {
    tips,
    launchesPerTip: tipCount ? events.length / tipCount : null,
    hivePoints: tipCount * TIP_POINTS,
    rp: {
      pollinator1: { need: RP_TIPS.pollinator1, got: tipCount, met: tipCount >= RP_TIPS.pollinator1 },
      pollinator2: { need: RP_TIPS.pollinator2, got: tipCount, met: tipCount >= RP_TIPS.pollinator2 },
    },
    overLimitCycles: cycles.filter((c) => c.count > ELEMENT_LIMIT).length,
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
      avgTips: mean(ms.map((m) => m.tips.total)),
      avgCycleTime: mean(ms.filter((m) => m.avgCycleTime !== null).map((m) => m.avgCycleTime)),
    }))
    .sort((a, b) => b.avgRate - a.avgRate || a.team.localeCompare(b.team, undefined, { numeric: true }));
}
