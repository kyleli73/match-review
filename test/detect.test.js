import test from 'node:test';
import assert from 'node:assert/strict';
import { rgbToHsv, findBlobs, maskFrame, DEFAULT_COLORS, rangeFromPixel } from '../src/detect.js';

test('rgbToHsv known values', () => {
  assert.deepEqual(rgbToHsv(255, 0, 0), { h: 0, s: 1, v: 1 });
  assert.deepEqual(rgbToHsv(0, 255, 0), { h: 120, s: 1, v: 1 });
  assert.deepEqual(rgbToHsv(0, 0, 255), { h: 240, s: 1, v: 1 });
  assert.deepEqual(rgbToHsv(255, 255, 0), { h: 60, s: 1, v: 1 });
  assert.deepEqual(rgbToHsv(255, 255, 255), { h: 0, s: 0, v: 1 });
  assert.deepEqual(rgbToHsv(0, 0, 0), { h: 0, s: 0, v: 0 });
  assert.deepEqual(rgbToHsv(128, 0, 128), { h: 300, s: 1, v: 128 / 255 });
  assert.deepEqual(rgbToHsv(255, 0, 255), { h: 300, s: 1, v: 1 });
});

test('findBlobs returns exactly two blobs with exact centroids', () => {
  const w = 10, h = 10;
  const mask = new Uint8Array(w * h);
  for (let y = 1; y <= 2; y++) for (let x = 1; x <= 2; x++) mask[y * w + x] = 1; // 2x2
  for (let y = 5; y <= 7; y++) for (let x = 6; x <= 8; x++) mask[y * w + x] = 1; // 3x3
  assert.deepEqual(findBlobs(mask, w, h, 1, 100), [
    { x: 1.5, y: 1.5, area: 4 },
    { x: 7, y: 6, area: 9 },
  ]);
});

test('findBlobs filters by area', () => {
  const w = 6, h = 3;
  const mask = new Uint8Array(w * h);
  mask[0] = 1; // area 1
  for (let x = 2; x <= 5; x++) mask[w + x] = 1; // area 4
  assert.deepEqual(findBlobs(mask, w, h, 2, 10), [{ x: 3.5, y: 1, area: 4 }]);
  assert.deepEqual(findBlobs(mask, w, h, 1, 2), [{ x: 0, y: 0, area: 1 }]);
});

test('maskFrame thresholds HSV and respects the ROI polygon', () => {
  const purple = [230, 200, 20, 255]; // yellow
  const red = [255, 0, 0, 255];
  const img = { width: 2, height: 1, data: new Uint8ClampedArray([...purple, ...red]) };
  assert.deepEqual([...maskFrame(img, DEFAULT_COLORS.pollen, null)], [1, 0]);
  const both = { width: 2, height: 1, data: new Uint8ClampedArray([...purple, ...purple]) };
  const left = [{ x: 0, y: 0 }, { x: 0.5, y: 0 }, { x: 0.5, y: 1 }, { x: 0, y: 1 }];
  assert.deepEqual([...maskFrame(both, DEFAULT_COLORS.pollen, left)], [1, 0]);
  assert.deepEqual([...maskFrame(both, DEFAULT_COLORS.blue, null)], [0, 0]);
});

test('red range wraps through hue 0', () => {
  const px = (r, g, b) => [r, g, b, 255];
  // hues: 350 (magenta-red), 0 (pure red), 10 (orange-red), 30 (orange), 330 (pink-magenta)
  const img = { width: 5, height: 1, data: new Uint8ClampedArray([...px(255, 0, 42), ...px(255, 0, 0), ...px(255, 42, 0), ...px(255, 128, 0), ...px(255, 0, 128)]) };
  assert.ok(DEFAULT_COLORS.red.hMin > DEFAULT_COLORS.red.hMax);
  assert.deepEqual([...maskFrame(img, DEFAULT_COLORS.red, null)], [1, 1, 1, 0, 0]);
  assert.deepEqual([...maskFrame(img, DEFAULT_COLORS.pollen, null)], [0, 0, 0, 0, 0]);
});

test('rangeFromPixel brackets the clicked color', () => {
  assert.deepEqual(rangeFromPixel(0, 255, 0), { hMin: 102, hMax: 138, sMin: 0.7, sMax: 1, vMin: 0.6, vMax: 1 });
});
