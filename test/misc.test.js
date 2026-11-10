import test from 'node:test';
import assert from 'node:assert/strict';
import { createMachine } from '../src/machine.js';
import { eventsCsv, matchesCsv, mergeImport, exportJson } from '../src/exporters.js';

test('state machine follows idle -> loading -> calibrating -> analyzing -> reviewing', () => {
  const seen = [];
  const m = createMachine('idle', (s) => seen.push(s));
  assert.equal(m.send('analyze'), false);
  for (const e of ['load', 'loaded', 'analyze', 'cancel', 'analyze', 'done', 'recalibrate', 'close']) assert.equal(m.send(e), true);
  assert.deepEqual(seen, ['loading', 'calibrating', 'analyzing', 'calibrating', 'analyzing', 'reviewing', 'calibrating', 'idle']);
  assert.equal(m.state, 'idle');
});

const match = {
  id: 'm1', matchNo: 12, teams: [111, 222], alliance: 'red', updatedAt: 5,
  events: [
    { id: 'e2', t: 41, color: 'green', source: 'manual', phase: 'teleop' },
    { id: 'e1', t: 1.5, color: 'purple', source: 'auto', phase: 'auto' },
  ],
};

test('eventsCsv sorts by time and quotes nothing unnecessary', () => {
  assert.equal(eventsCsv([match]),
    'match_id,match_no,teams,alliance,event_id,t,color,phase,source\n' +
    'm1,12,111 222,red,e1,1.500,purple,auto,auto\n' +
    'm1,12,111 222,red,e2,41.000,green,teleop,manual\n');
});

test('matchesCsv row', () => {
  const lines = matchesCsv([match]).split('\n');
  assert.equal(lines[1], 'm1,12,111 222,red,2,1,1,1,0,1,0,0.013,0.200,2,39.500,1.000');
});

test('mergeImport keeps newest by updatedAt and rejects foreign JSON', () => {
  const incoming = JSON.parse(exportJson([{ ...match, updatedAt: 9, matchNo: 13 }, { ...match, id: 'm2' }], [], 1));
  const r = mergeImport({ matches: [match], profiles: [] }, incoming);
  assert.equal(r.added, 1);
  assert.equal(r.updated, 1);
  assert.equal(r.matches.find((m) => m.id === 'm1').matchNo, 13);
  assert.throws(() => mergeImport({ matches: [], profiles: [] }, { foo: 1 }));
});
