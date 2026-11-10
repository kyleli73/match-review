import test from 'node:test';
import assert from 'node:assert/strict';
import { parseYouTubeUrl, parseTimestamp } from '../src/youtube.js';
import { migrateMatch } from '../src/metrics.js';
import { cropRect } from '../src/capture.js';

test('parseTimestamp', () => {
  assert.equal(parseTimestamp('1h2m3s'), 3723);
  assert.equal(parseTimestamp('3723'), 3723);
  assert.equal(parseTimestamp('90s'), 90);
  assert.equal(parseTimestamp('2m'), 120);
  assert.equal(parseTimestamp('1:02:03'), 3723);
  assert.equal(parseTimestamp('abc'), null);
  assert.equal(parseTimestamp(''), null);
});

test('watch URL with h/m/s timestamp', () => {
  assert.deepEqual(parseYouTubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1h2m3s'), { videoId: 'dQw4w9WgXcQ', start: 3723 });
});
test('youtu.be with seconds', () => {
  assert.deepEqual(parseYouTubeUrl('https://youtu.be/dQw4w9WgXcQ?t=90'), { videoId: 'dQw4w9WgXcQ', start: 90 });
});
test('live and shorts paths, start= param', () => {
  assert.deepEqual(parseYouTubeUrl('https://www.youtube.com/live/abcDEF12345?start=45'), { videoId: 'abcDEF12345', start: 45 });
  assert.deepEqual(parseYouTubeUrl('youtube.com/shorts/abcDEF12345'), { videoId: 'abcDEF12345', start: 0 });
});
test('bare id and invalid input', () => {
  assert.deepEqual(parseYouTubeUrl('dQw4w9WgXcQ'), { videoId: 'dQw4w9WgXcQ', start: 0 });
  assert.equal(parseYouTubeUrl('not a link'), null);
  assert.equal(parseYouTubeUrl('https://example.com/watch?v=dQw4w9WgXcQ'), null);
  assert.equal(parseYouTubeUrl('https://www.youtube.com/watch?v=short'), null);
});

test('migrateMatch moves videoKey into source and is idempotent', () => {
  const old = { id: 'm1', videoKey: 'v_m1', events: [] };
  const once = migrateMatch(old);
  assert.deepEqual(once.source, { kind: 'file', videoKey: 'v_m1' });
  assert.equal('videoKey' in once, false);
  assert.deepEqual(migrateMatch(once), once);
  const yt = { id: 'm2', events: [], source: { kind: 'youtube', videoId: 'dQw4w9WgXcQ', url: 'u', startHint: 90 } };
  assert.deepEqual(migrateMatch(yt).source, yt.source);
});

test('cropRect scales the player rect into the captured frame', () => {
  const rect = { left: 100, top: 50, width: 640, height: 360 };
  // 2x display, frame is physical pixels, viewport inferred from dpr
  assert.deepEqual(cropRect({ rect, frame: { width: 3840, height: 2160 }, dpr: 2 }), { sx: 200, sy: 100, sw: 1280, sh: 720 });
  // browser downscaled the capture to 1280x720 of a 1920x1080 viewport
  assert.deepEqual(cropRect({ rect, frame: { width: 1280, height: 720 }, viewport: { width: 1920, height: 1080 } }), { sx: 67, sy: 33, sw: 427, sh: 240 });
});
