import test from 'node:test';
import assert from 'node:assert/strict';
import { metrics, findCycles, rollingRate, phaseAt, teamAggregates, DEFAULT_PHASES } from '../src/metrics.js';

const ev = (id, t, color, phase) => ({ id, t, color, source: 'auto', phase });
const events = [
  ev('a', 1, 'purple', 'auto'), ev('b', 2, 'green', 'auto'), ev('c', 3, 'purple', 'auto'),
  ev('d', 4, 'purple', 'auto'), ev('e', 5, 'green', 'auto'),
  ev('f', 40, 'purple', 'teleop'), ev('g', 41, 'green', 'teleop'), ev('h', 42, 'other', 'teleop'),
];

test('metrics on a literal event list', () => {
  const m = metrics(events, DEFAULT_PHASES, { duration: 80, gapSec: 3 });
  assert.equal(m.total, 8);
  assert.equal(m.rate, 0.1);
  assert.deepEqual(m.byColor, { purple: 4, green: 3, other: 1 });
  assert.equal(m.byPhase.auto.count, 5);
  assert.equal(m.byPhase.teleop.count, 3);
  assert.equal(m.byPhase.teleop.rate, 3 / 90);
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
  assert.deepEqual([0, 29.9, 30, 37.9, 38, 127.9, 128, 157.9, 200].map((t) => phaseAt(t)),
    ['auto', 'auto', 'transition', 'transition', 'teleop', 'teleop', 'endgame', 'endgame', 'endgame']);
});

test('rollingRate', () => {
  const r = rollingRate([{ t: 1 }, { t: 2 }, { t: 3 }], 6, 5, 3);
  assert.deepEqual(r, [{ t: 0, rate: 0 }, { t: 3, rate: 0.6 }, { t: 6, rate: 0.4 }]);
});

test('teamAggregates averages per team across matches', () => {
  const mk = (teams, ts) => ({ teams, events: ts.map((t) => ({ t, color: 'purple', phase: 'auto' })) });
  const agg = teamAggregates([mk([111, 222], [1, 2, 3, 4]), mk([111], [1])]);
  assert.deepEqual(agg.map((a) => [a.team, a.matches, a.totalShots]), [['222', 1, 4], ['111', 2, 5]]);
  assert.equal(agg[1].avgRate, (4 / 158 + 1 / 158) / 2);
  assert.equal(agg[1].avgCycleTime, null);
});
