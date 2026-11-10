import test from 'node:test';
import assert from 'node:assert/strict';
import { Tracker } from '../src/track.js';

const line = { x1: 0, y1: 10, x2: 20, y2: 10 };

test('one event for a blob crossing the line over several frames', () => {
  const tr = new Tracker({ mode: 'line', line, maxDist: 8 });
  const all = [];
  [2, 5, 8, 11, 14, 17].forEach((y, i) => {
    all.push(...tr.update([{ x: 10, y, area: 20, color: 'pollen' }], i / 15));
  });
  assert.equal(all.length, 1);
  assert.equal(all[0].color, 'pollen');
  assert.equal(all[0].t, 3 / 15);
});

test('two balls crossing at different times give two events, colors kept', () => {
  const tr = new Tracker({ mode: 'line', line, maxDist: 8 });
  const all = [];
  const frames = [
    [{ x: 5, y: 6, color: 'pollen' }],
    [{ x: 5, y: 12, color: 'pollen' }],
    [],
    [],
    [{ x: 15, y: 6, color: 'blue' }],
    [{ x: 15, y: 12, color: 'blue' }],
  ];
  frames.forEach((blobs, i) => all.push(...tr.update(blobs, i)));
  assert.deepEqual(all.map((e) => [e.t, e.color]), [[1, 'pollen'], [5, 'blue']]);
});

test('a blob moving parallel to the line never fires', () => {
  const tr = new Tracker({ mode: 'line', line, maxDist: 8 });
  const all = [];
  for (let i = 0; i < 5; i++) all.push(...tr.update([{ x: 2 + i * 3, y: 4, color: 'blue' }], i));
  assert.equal(all.length, 0);
});

test('region mode: one event on first entry, none while it stays inside', () => {
  const region = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 }];
  const tr = new Tracker({ mode: 'region', region, maxDist: 8 });
  const all = [];
  [[30, 10], [30, 10], [14, 10], [12, 10], [10, 10], [8, 10]].forEach(([x, y], i) => {
    all.push(...tr.update([{ x, y, color: 'pollen' }], i * 0.1));
  });
  assert.equal(all.length, 1);
  assert.equal(all[0].t, 0.2);
});
