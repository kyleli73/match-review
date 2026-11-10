import { MATCH_LEN } from './metrics.js';
import { ANALYSIS_WIDTH, createDetector } from './video.js';

export const captureSupported = () => !!navigator.mediaDevices?.getDisplayMedia;

/**
 * Map an element's CSS rect into captured-frame pixels. The viewport defaults to the frame size
 * divided by devicePixelRatio (capture at native resolution); pass it when the browser scaled the capture.
 */
export function cropRect({ rect, frame, viewport, dpr = 1 }) {
  const kx = frame.width / (viewport?.width ?? frame.width / dpr);
  const ky = frame.height / (viewport?.height ?? frame.height / dpr);
  const sx = Math.max(0, Math.round(rect.left * kx));
  const sy = Math.max(0, Math.round(rect.top * ky));
  return {
    sx, sy,
    sw: Math.max(1, Math.min(frame.width - sx, Math.round(rect.width * kx))),
    sh: Math.max(1, Math.min(frame.height - sy, Math.round(rect.height * ky))),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const abortErr = () => new DOMException('cancelled', 'AbortError');

/**
 * Plays the YouTube player at 1x from startOffset and feeds screen-captured frames of `region`
 * (the player element) to the detector. Event times are the player's own clock (absolute video seconds).
 * Resolves { events, completed }; completed is false when the user stopped sharing early.
 */
export async function captureAnalyze({ player, region, profile, startOffset, fps, onProgress, signal }) {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { displaySurface: 'browser', frameRate: 30 }, preferCurrentTab: true, selfBrowserSurface: 'include',
  });
  const [track] = stream.getVideoTracks();
  let ended = false;
  track.addEventListener('ended', () => { ended = true; });
  let det;
  try {
    let cropped = false;
    if (window.CropTarget?.fromElement && track.cropTo) {
      try { await track.cropTo(await CropTarget.fromElement(region)); cropped = true; } catch { /* fall back to per-frame crop */ }
    }
    const vid = document.createElement('video');
    vid.muted = true; vid.playsInline = true; vid.srcObject = stream;
    await vid.play();
    for (let i = 0; i < 100 && !vid.videoWidth; i++) await sleep(50);
    if (!vid.videoWidth) throw new Error('no frames from screen capture');

    const r0 = region.getBoundingClientRect();
    const width = ANALYSIS_WIDTH;
    const height = Math.round((width * r0.height) / r0.width);
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    det = await createDetector(profile, width, height);

    player.setRate(1);
    await player.seek(startOffset);
    player.play();
    for (let i = 0; i < 200 && player.currentTime() <= startOffset + 0.05; i++) {
      if (signal.aborted) throw abortErr();
      await sleep(50);
    }

    const events = [];
    let last = -1;
    while (!ended) {
      if (signal.aborted) throw abortErr();
      const t = player.currentTime();
      const rel = t - startOffset;
      if (rel >= MATCH_LEN) return { events, completed: true };
      if (t > last && !player.isPaused() && !document.hidden) {
        const rect = region.getBoundingClientRect();
        const fw = vid.videoWidth, fh = vid.videoHeight;
        // right after cropTo the first frames can still be full-tab; skip anything with the wrong shape
        const shapeOk = !cropped || Math.abs(fw / fh - rect.width / rect.height) < 0.05 * (rect.width / rect.height);
        if (shapeOk) {
          const c = cropped ? { sx: 0, sy: 0, sw: fw, sh: fh }
            : cropRect({ rect, frame: { width: fw, height: fh }, viewport: { width: innerWidth, height: innerHeight }, dpr: devicePixelRatio });
          ctx.drawImage(vid, c.sx, c.sy, c.sw, c.sh, 0, 0, width, height);
          events.push(...await det.frame(t, ctx.getImageData(0, 0, width, height)));
          last = t;
          onProgress?.(Math.max(0, rel) / MATCH_LEN, t);
        }
      }
      await sleep(1000 / fps);
    }
    return { events, completed: false };
  } finally {
    det?.close();
    stream.getTracks().forEach((t) => t.stop());
    player.pause();
  }
}
