import { maskFrame, findBlobs, roiMask, BALL_COLORS } from './detect.js';
import { Tracker } from './track.js';

let cfg = null;
let roi = null;
let tracker = null;

self.onmessage = ({ data: m }) => {
  if (m.type === 'init') {
    cfg = m;
    const { profile, width: w, height: h } = m;
    const px = (p) => ({ x: p.x * w, y: p.y * h });
    roi = roiMask(w, h, profile.roi);
    const L = profile.scoreLine;
    tracker = new Tracker({
      mode: profile.mode,
      region: profile.roi?.length >= 3 ? profile.roi.map(px) : null,
      line: L ? { x1: L.x1 * w, y1: L.y1 * h, x2: L.x2 * w, y2: L.y2 * h } : null,
      maxDist: 0.12 * w,
      confirmFrames: profile.confirmFrames ?? 1,
      maxMiss: 0.4,
      debounceSec: 0.25,
    });
    self.postMessage({ type: 'ready' });
  } else if (m.type === 'frame') {
    const img = { width: m.width, height: m.height, data: new Uint8ClampedArray(m.buffer) };
    const blobs = [];
    for (const key of BALL_COLORS) {
      const range = cfg.profile.colors[key];
      if (!range) continue;
      for (const b of findBlobs(maskFrame(img, range, roi), m.width, m.height, cfg.profile.minArea, cfg.profile.maxArea)) {
        blobs.push({ ...b, color: key });
      }
    }
    self.postMessage({ type: 'result', t: m.t, events: tracker.update(blobs, m.t), blobCount: blobs.length });
  }
};
