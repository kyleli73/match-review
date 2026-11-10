// Pure detection pipeline: no DOM access, runs in Node, the worker and the main thread.

export const DEFAULT_COLORS = {
  purple: { hMin: 255, hMax: 300, sMin: 0.25, sMax: 1, vMin: 0.2, vMax: 1 },
  green: { hMin: 80, hMax: 160, sMin: 0.35, sMax: 1, vMin: 0.25, vMax: 1 },
};

/** r,g,b 0..255 -> { h: 0..360, s: 0..1, v: 0..1 } */
export function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

// hMin > hMax means the hue interval wraps through 0 (reds/magentas).
export function inRange(h, s, v, r) {
  if (s < r.sMin || s > r.sMax || v < r.vMin || v > r.vMax) return false;
  return r.hMin <= r.hMax ? h >= r.hMin && h <= r.hMax : h >= r.hMin || h <= r.hMax;
}

export function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Rasterize a normalized polygon to a w*h 0/1 mask (pixel centers). No polygon = everything. */
export function roiMask(w, h, poly) {
  const m = new Uint8Array(w * h);
  if (!poly || poly.length < 3) {
    m.fill(1);
    return m;
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (pointInPolygon((x + 0.5) / w, (y + 0.5) / h, poly)) m[y * w + x] = 1;
    }
  }
  return m;
}

/** roi: null | normalized polygon | precomputed Uint8Array from roiMask. */
export function maskFrame(img, range, roi) {
  const { width: w, height: h, data } = img;
  const rm = roi instanceof Uint8Array ? roi : roiMask(w, h, roi);
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (!rm[i]) continue;
    const p = i * 4;
    const c = rgbToHsv(data[p], data[p + 1], data[p + 2]);
    if (inRange(c.h, c.s, c.v, range)) out[i] = 1;
  }
  return out;
}

/** 4-connected components. Centroids are in pixel-index coordinates (mean of x,y indices). */
export function findBlobs(mask, w, h, minArea = 1, maxArea = Infinity) {
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  const blobs = [];
  for (let s = 0; s < w * h; s++) {
    if (!mask[s] || seen[s]) continue;
    let sp = 0;
    stack[sp++] = s;
    seen[s] = 1;
    let area = 0, sx = 0, sy = 0;
    while (sp) {
      const i = stack[--sp];
      const x = i % w;
      const y = (i - x) / w;
      area++; sx += x; sy += y;
      if (x > 0 && mask[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack[sp++] = i - 1; }
      if (x < w - 1 && mask[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack[sp++] = i + 1; }
      if (y > 0 && mask[i - w] && !seen[i - w]) { seen[i - w] = 1; stack[sp++] = i - w; }
      if (y < h - 1 && mask[i + w] && !seen[i + w]) { seen[i + w] = 1; stack[sp++] = i + w; }
    }
    if (area >= minArea && area <= maxArea) blobs.push({ x: sx / area, y: sy / area, area });
  }
  return blobs;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const r3 = (v) => Math.round(v * 1000) / 1000;

/** Build a forgiving HSV range around a clicked ball pixel. */
export function rangeFromPixel(r, g, b) {
  const { h, s, v } = rgbToHsv(r, g, b);
  const dh = 18;
  return {
    hMin: Math.round((h - dh + 360) % 360),
    hMax: Math.round((h + dh) % 360),
    sMin: r3(clamp(s - 0.3, 0.12, 1)),
    sMax: 1,
    vMin: r3(clamp(v - 0.4, 0.08, 1)),
    vMax: 1,
  };
}
