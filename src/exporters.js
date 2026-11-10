import { metrics, DEFAULT_PHASES } from './metrics.js';

const q = (v) => {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const toCsv = (rows) => rows.map((r) => r.map(q).join(',')).join('\n') + '\n';
const f3 = (n) => (n == null ? '' : n.toFixed(3));

export function matchesCsv(matches, opts = {}) {
  const rows = [[
    'match_id', 'match_no', 'teams', 'alliance', 'total', 'purple', 'green', 'auto', 'transition', 'teleop', 'endgame',
    'balls_per_sec', 'peak_burst_bps', 'cycles', 'avg_cycle_time_s', 'avg_balls_per_cycle',
  ]];
  for (const m of matches) {
    const x = metrics(m.events, DEFAULT_PHASES, opts);
    rows.push([
      m.id, m.matchNo, (m.teams || []).join(' '), m.alliance, x.total, x.byColor.purple, x.byColor.green,
      x.byPhase.auto.count, x.byPhase.transition.count, x.byPhase.teleop.count, x.byPhase.endgame.count,
      f3(x.rate), f3(x.burst.rate), x.cycleCount, f3(x.avgCycleTime), f3(x.avgBallsPerCycle),
    ]);
  }
  return toCsv(rows);
}

export function eventsCsv(matches) {
  const rows = [['match_id', 'match_no', 'teams', 'alliance', 'event_id', 't', 'color', 'phase', 'source']];
  for (const m of matches) {
    for (const e of [...m.events].sort((a, b) => a.t - b.t)) {
      rows.push([m.id, m.matchNo, (m.teams || []).join(' '), m.alliance, e.id, e.t.toFixed(3), e.color, e.phase, e.source]);
    }
  }
  return toCsv(rows);
}

export function exportJson(matches, profiles, now = Date.now()) {
  return JSON.stringify({ app: 'bubblotics-match-review', version: 1, exportedAt: now, matches, profiles }, null, 2);
}

/** Merge another scout's export by id; newest updatedAt wins. Videos are never part of an export. */
export function mergeImport(local, incoming) {
  if (!incoming || incoming.app !== 'bubblotics-match-review' || !Array.isArray(incoming.matches)) {
    throw new Error('Not a Bubblotics Match Review export');
  }
  const merge = (mine, theirs) => {
    const map = new Map(mine.map((x) => [x.id, x]));
    let added = 0, updated = 0;
    for (const x of theirs || []) {
      const cur = map.get(x.id);
      if (!cur) { map.set(x.id, x); added++; }
      else if ((x.updatedAt ?? 0) > (cur.updatedAt ?? 0)) { map.set(x.id, x); updated++; }
    }
    return { list: [...map.values()], added, updated };
  };
  const m = merge(local.matches, incoming.matches);
  const p = merge(local.profiles, incoming.profiles);
  return { matches: m.list, profiles: p.list, added: m.added, updated: m.updated, profilesAdded: p.added };
}
