// Player adapter: the review UI talks to this, never to <video> or the YT player directly.
// Player = { kind, currentTime, duration, seek(t)->Promise, play, pause, isPaused, setRate, rates, onTick(cb)->off, destroy }
import { seek as seekVideo } from './video.js';

export function createFilePlayer(video) {
  const cbs = new Set();
  const fire = (ev) => cbs.forEach((cb) => cb(ev));
  const evs = ['timeupdate', 'seeked', 'play', 'pause'];
  const hs = evs.map((ev) => [ev, () => fire(ev)]);
  hs.forEach(([ev, h]) => video.addEventListener(ev, h));
  let dead = false;
  const loop = () => { if (dead) return; fire('frame'); video.requestVideoFrameCallback(loop); };
  if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(loop);
  return {
    kind: 'file',
    currentTime: () => video.currentTime,
    duration: () => video.duration,
    seek: (t) => seekVideo(video, t),
    play: () => video.play(),
    pause: () => video.pause(),
    isPaused: () => video.paused,
    setRate: (r) => { video.playbackRate = r; },
    rates: () => [0.25, 0.5, 1, 2],
    onTick: (cb) => { cbs.add(cb); return () => cbs.delete(cb); },
    destroy: () => { dead = true; hs.forEach(([ev, h]) => video.removeEventListener(ev, h)); cbs.clear(); },
  };
}

let apiPromise = null;
function loadYouTubeApi(timeoutMs = 12000) {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  apiPromise ??= new Promise((resolve, reject) => {
    const fail = () => { apiPromise = null; reject(new Error('YouTube needs internet')); };
    const timer = setTimeout(fail, timeoutMs);
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { clearTimeout(timer); prev?.(); resolve(window.YT); };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => { clearTimeout(timer); fail(); };
    document.head.append(s);
  });
  return apiPromise;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** `mount` is an empty container element; the iframe is created inside it. Rejects when YouTube is unreachable. */
export async function createYouTubePlayer(mount, { videoId, start = 0 }) {
  if (navigator.onLine === false) throw new Error('YouTube needs internet');
  const YT = await loadYouTubeApi();
  const host = document.createElement('div');
  mount.append(host);
  let paused = true;
  const cbs = new Set();
  const fire = (ev) => cbs.forEach((cb) => cb(ev));
  const yt = await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('YouTube player did not start')), 15000);
    const p = new YT.Player(host, {
      videoId,
      playerVars: { start: Math.floor(start), playsinline: 1, rel: 0, enablejsapi: 1, origin: location.origin },
      events: {
        onReady: () => { clearTimeout(to); resolve(p); },
        onError: (e) => { clearTimeout(to); reject(new Error(`YouTube error ${e.data}`)); },
        onStateChange: (e) => { paused = e.data !== YT.PlayerState.PLAYING && e.data !== YT.PlayerState.BUFFERING; fire('state'); },
      },
    });
  });
  // getCurrentTime only changes at player-clock granularity, so poll for a UI tick
  const timer = setInterval(() => fire('tick'), 100);
  return {
    kind: 'youtube',
    currentTime: () => yt.getCurrentTime() || 0,
    duration: () => yt.getDuration() || 0,
    async seek(t) {
      const target = Math.max(0, t);
      yt.seekTo(target, true);
      for (let i = 0; i < 30; i++) {
        await sleep(30);
        if (Math.abs(yt.getCurrentTime() - target) < 0.25) break;
      }
      fire('seeked');
    },
    play: () => yt.playVideo(),
    pause: () => yt.pauseVideo(),
    isPaused: () => paused,
    setRate: (r) => yt.setPlaybackRate(r),
    rates: () => yt.getAvailablePlaybackRates?.() ?? [0.25, 0.5, 1, 1.5, 2],
    onTick: (cb) => { cbs.add(cb); return () => cbs.delete(cb); },
    destroy: () => { clearInterval(timer); cbs.clear(); try { yt.destroy(); } catch { /* already gone */ } host.remove(); },
  };
}

/** Stand-in when YouTube is unreachable: keeps a virtual clock so events, timeline and edits still work. */
export function createOfflinePlayer(t0 = 0) {
  let t = t0;
  return {
    kind: 'youtube', offline: true,
    currentTime: () => t, duration: () => 0,
    seek: async (x) => { t = Math.max(0, x); },
    play() {}, pause() {}, isPaused: () => true, setRate() {}, rates: () => [1],
    onTick: () => () => {}, destroy() {},
  };
}
