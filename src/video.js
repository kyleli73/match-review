import { MATCH_LEN } from './metrics.js';

export const ANALYSIS_WIDTH = 320;
let currentUrl = null;

function once(target, ev, ms = 8000) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => { target.removeEventListener(ev, ok); reject(new Error(`timeout waiting for ${ev}`)); }, ms);
    const ok = () => { clearTimeout(to); resolve(); };
    target.addEventListener(ev, ok, { once: true });
  });
}

export function seek(video, t) {
  const target = Math.max(0, Math.min(t, (video.duration || t) - 0.001));
  if (Math.abs(video.currentTime - target) < 1e-4 && video.readyState >= 2) return Promise.resolve();
  const p = once(video, 'seeked');
  video.currentTime = target;
  return p;
}

export async function loadVideo(video, blob) {
  if (currentUrl) URL.revokeObjectURL(currentUrl);
  currentUrl = URL.createObjectURL(blob);
  video.src = currentUrl;
  await once(video, 'loadedmetadata', 15000);
  // MediaRecorder webm reports Infinity until the end has been visited
  if (!Number.isFinite(video.duration)) {
    const p = once(video, 'durationchange', 5000).catch(() => {});
    video.currentTime = 1e101;
    await p;
    video.currentTime = 0;
    await once(video, 'seeked', 5000).catch(() => {});
  }
  if (video.readyState < 2) await once(video, 'loadeddata', 15000);
  return { duration: video.duration, width: video.videoWidth, height: video.videoHeight };
}

export function unloadVideo(video) {
  video.pause();
  video.removeAttribute('src');
  video.load();
  if (currentUrl) URL.revokeObjectURL(currentUrl);
  currentUrl = null;
}

export function grabFrame(video, canvas, width = ANALYSIS_WIDTH) {
  const h = Math.round((width * video.videoHeight) / video.videoWidth);
  canvas.width = width;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, 0, 0, width, h);
  return ctx.getImageData(0, 0, width, h);
}

/**
 * Step through [startOffset, startOffset + match length] with seeks at `fps`, pushing downscaled
 * frames through the detection worker. Resolves with raw events (absolute video seconds).
 */
/** Detection worker wrapper shared by seek-based analysis and live capture. */
export async function createDetector(profile, width, height) {
  const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  const rpc = (msg, transfer) => new Promise((resolve, reject) => {
    worker.onmessage = (e) => resolve(e.data);
    worker.onerror = (e) => reject(new Error(e.message || 'worker error'));
    worker.postMessage(msg, transfer);
  });
  try { await rpc({ type: 'init', profile, width, height }); } catch (e) { worker.terminate(); throw e; }
  return {
    async frame(t, img) {
      const buffer = img.data.buffer;
      return (await rpc({ type: 'frame', t, width, height, buffer }, [buffer])).events;
    },
    close: () => worker.terminate(),
  };
}

/**
 * Step through [startOffset, startOffset + match length] with seeks at `fps`, pushing downscaled
 * frames through the detection worker. Resolves with raw events (absolute video seconds).
 */
export async function analyze({ video, profile, startOffset, fps, onProgress, signal }) {
  const canvas = document.createElement('canvas');
  let det;
  try {
    video.pause();
    const width = ANALYSIS_WIDTH;
    const height = Math.round((width * video.videoHeight) / video.videoWidth);
    det = await createDetector(profile, width, height);
    const t0 = Math.max(0, startOffset);
    const t1 = Math.min(video.duration, startOffset + MATCH_LEN + 2);
    const step = 1 / fps;
    const n = Math.max(1, Math.floor((t1 - t0) / step));
    const events = [];
    for (let i = 0; i <= n; i++) {
      if (signal.aborted) throw new DOMException('cancelled', 'AbortError');
      const t = t0 + i * step;
      await seek(video, t);
      events.push(...await det.frame(t, grabFrame(video, canvas, width)));
      onProgress?.(i / n, t);
    }
    return events;
  } finally {
    det?.close();
  }
}

export async function startCamera(previewEl) {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'environment', width: { ideal: 1280 }, frameRate: { ideal: 30 } },
    audio: false,
  });
  previewEl.srcObject = stream;
  await previewEl.play();
  return stream;
}

export function createRecorder(stream) {
  const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4']
    .find((m) => window.MediaRecorder?.isTypeSupported(m));
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  return {
    start: () => rec.start(1000),
    stop: () => new Promise((resolve) => {
      rec.onstop = () => resolve(new Blob(chunks, { type: rec.mimeType || 'video/webm' }));
      rec.stop();
    }),
  };
}
