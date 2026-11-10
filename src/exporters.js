import { metrics, migrateMatch, DEFAULT_PHASES } from './metrics.js';

const q = (v) => {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const toCsv = (rows) => rows.map((r) => r.map(q).join(',')).join('\n') + '\n';
const f3 = (n) => (n == null ? '' : n.toFixed(3));

export function matchesCsv(matches, opts = {}) {
  const rows = [[
    'match_id', 'match_no', 'teams', 'alliance', 'total', 'pollen', 'red', 'blue', 'auto', 'transition', 'teleop', 'flower',
    'balls_per_sec', 'peak_burst_bps', 'cycles', 'avg_cycle_time_s', 'avg_balls_per_cycle',
    'tips', 'tips_auto', 'tips_teleop', 'launches_per_tip', 'hive_points', 'pollinator1', 'pollinator2',
  ]];
  for (const m of matches) {
    const x = metrics(m.events, DEFAULT_PHASES, opts);
    rows.push([
      m.id, m.matchNo, (m.teams || []).join(' '), m.alliance, x.total, x.byColor.pollen, x.byColor.red, x.byColor.blue,
      x.byPhase.auto.count, x.byPhase.transition.count, x.byPhase.teleop.count, x.byPhase.flower.count,
      f3(x.rate), f3(x.burst.rate), x.cycleCount, f3(x.avgCycleTime), f3(x.avgBallsPerCycle),
      x.tips.total, x.tips.auto, x.tips.teleop, f3(x.launchesPerTip), x.hivePoints, x.rp.pollinator1.met ? 1 : 0, x.rp.pollinator2.met ? 1 : 0,
    ]);
  }
  return toCsv(rows);
}

export function eventsCsv(matches) {
  const rows = [['match_id', 'match_no', 'teams', 'alliance', 'event_id', 't', 'kind', 'color', 'phase', 'source']];
  for (const m of matches) {
    for (const e of [...m.events].sort((a, b) => a.t - b.t)) {
      rows.push([m.id, m.matchNo, (m.teams || []).join(' '), m.alliance, e.id, e.t.toFixed(3), e.kind || 'launch', e.color, e.phase, e.source]);
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
  const m = merge(local.matches, (incoming.matches || []).map(migrateMatch));
  const p = merge(local.profiles, incoming.profiles);
  return { matches: m.list, profiles: p.list, added: m.added, updated: m.updated, profilesAdded: p.added };
}
