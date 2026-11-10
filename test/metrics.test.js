import test from 'node:test';
import assert from 'node:assert/strict';
import { metrics, migrateMatch, findCycles, rollingRate, phaseAt, teamAggregates, DEFAULT_PHASES } from '../src/metrics.js';

const ev = (id, t, color, phase) => ({ id, t, kind: 'launch', color, source: 'auto', phase });
const events = [
  ev('a', 1, 'pollen', 'auto'), ev('b', 2, 'red', 'auto'), ev('c', 3, 'pollen', 'auto'),
  ev('d', 4, 'pollen', 'auto'), ev('e', 5, 'red', 'auto'),
  ev('f', 40, 'pollen', 'teleop'), ev('g', 41, 'red', 'teleop'), ev('h', 42, 'other', 'teleop'),
];

test('metrics on a literal event list', () => {
  const m = metrics(events, DEFAULT_PHASES, { duration: 80, gapSec: 3 });
  assert.equal(m.total, 8);
  assert.equal(m.rate, 0.1);
  assert.deepEqual(m.byColor, { pollen: 4, red: 3, blue: 0, other: 1 });
  assert.equal(m.byPhase.auto.count, 5);
  assert.equal(m.byPhase.teleop.count, 3);
  assert.equal(m.byPhase.teleop.rate, 3 / 60);
  assert.equal(m.burst.count, 5);
  assert.equal(m.burst.rate, 1);
  assert.equal(m.burst.start, 1);
  assert.equal(m.cycleCount, 2);
  assert.deepEqual(m.cycles, [{ start: 1, end: 5, count: 5 }, { start: 40, end: 42, count: 3 }]);
  assert.equal(m.avgBallsPerCycle, 4);
  assert.equal(m.avgCycleTime, 39);
  assert.equal(m.avgCycleSpan, 3);
});

test('cycle gap boundary: exactly N seconds stays in one cycle', () => {
  const es = [{ t: 0 }, { t: 3 }, { t: 6.5 }];
  assert.equal(findCycles(es, 3).length, 2);
  assert.equal(findCycles(es, 3.5).length, 1);
});

test('empty list is all zeros / nulls', () => {
  const m = metrics([], DEFAULT_PHASES, { duration: 100 });
  assert.equal(m.total, 0);
  assert.equal(m.rate, 0);
  assert.equal(m.burst.rate, 0);
  assert.equal(m.avgCycleTime, null);
});

test('phaseAt boundaries', () => {
  assert.deepEqual([0, 29.9, 30, 37.9, 38, 97.9, 98, 157.9, 200].map((t) => phaseAt(t)),
    ['auto', 'auto', 'transition', 'transition', 'teleop', 'teleop', 'flower', 'flower', 'flower']);
});

test('rollingRate', () => {
  const r = rollingRate([{ t: 1 }, { t: 2 }, { t: 3 }], 6, 5, 3);
  assert.deepEqual(r, [{ t: 0, rate: 0 }, { t: 3, rate: 0.6 }, { t: 6, rate: 0.4 }]);
});

test('teamAggregates averages per team across matches', () => {
  const mk = (teams, ts) => ({ teams, events: ts.map((t) => ({ t, color: 'pollen', phase: 'auto' })) });
  const agg = teamAggregates([mk([111, 222], [1, 2, 3, 4]), mk([111], [1])]);
  assert.deepEqual(agg.map((a) => [a.team, a.matches, a.totalShots]), [['222', 1, 4], ['111', 2, 5]]);
  assert.equal(agg[1].avgRate, (4 / 158 + 1 / 158) / 2);
  assert.equal(agg[1].avgCycleTime, null);
});

test('tip events: exact tips, launches per tip, RP flags, excluded from rate and cycles', () => {
  const tip = (id, t, phase) => ({ id, t, kind: 'tip', color: 'other', source: 'manual', phase });
  const es = [...events, tip('t1', 10, 'auto'), tip('t2', 20, 'auto'), tip('t3', 50, 'teleop'), tip('t4', 120, 'flower')];
  const m = metrics(es, DEFAULT_PHASES, { duration: 80 });
  assert.equal(m.total, 8);
  assert.equal(m.rate, 0.1);
  assert.equal(m.cycleCount, 2);
  assert.deepEqual(m.tips, { total: 4, auto: 2, teleop: 2 });
  assert.equal(m.byPhase.flower.tips, 1);
  assert.equal(m.byPhase.flower.count, 0);
  assert.equal(m.launchesPerTip, 2);
  assert.equal(m.hivePoints, 80);
  assert.equal(m.rp.pollinator1.met, true);
  assert.equal(m.rp.pollinator2.met, false);
  assert.equal(metrics(events, DEFAULT_PHASES).launchesPerTip, null);
  const seven = Array.from({ length: 7 }, (_, i) => tip(`x${i}`, i, 'auto'));
  assert.equal(metrics(seven).rp.pollinator2.met, true);
  assert.equal(metrics(seven.slice(0, 3)).rp.pollinator1.met, false);
});

test('cycles over the 4-element limit are flagged', () => {
  const m = metrics(events, DEFAULT_PHASES); // first cycle has 5 launches
  assert.equal(m.overLimitCycles, 1);
});

test('teamAggregates reports avg tips per match', () => {
  const tip = { t: 5, kind: 'tip', color: 'other', phase: 'auto' };
  const agg = teamAggregates([{ teams: [9], events: [tip, tip, tip] }, { teams: [9], events: [tip] }]);
  assert.equal(agg[0].avgTips, 2);
  assert.equal(agg[0].totalShots, 0);
});

test('migrateMatch maps old purple/green to other and defaults kind to launch', () => {
  const old = { id: 'o', events: [{ id: 'a', t: 1, color: 'purple' }, { id: 'b', t: 2, color: 'green' }, { id: 'c', t: 3, color: 'red', kind: 'launch' }, { id: 'd', t: 4, color: 'other', kind: 'tip' }] };
  assert.deepEqual(migrateMatch(old).events.map((e) => [e.color, e.kind]),
    [['other', 'launch'], ['other', 'launch'], ['red', 'launch'], ['other', 'tip']]);
});
