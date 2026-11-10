// Pure URL parsing; no DOM.
const ID = /^[\w-]{11}$/;

/** '3723', '1h2m3s', '90s', '2m', '1:02:03' -> seconds, or null. */
export function parseTimestamp(str) {
  const s = String(str ?? '').trim();
  if (!s) return null;
  const colon = s.match(/^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/);
  if (colon) return Number(colon[1] ?? 0) * 3600 + Number(colon[2]) * 60 + Number(colon[3]);
  const m = s.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s?)?$/i);
  if (!m || (m[1] === undefined && m[2] === undefined && m[3] === undefined)) return null;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

/** watch?v=, youtu.be/, /live/, /shorts/, /embed/ or a bare 11-char id -> { videoId, start } (start in seconds). */
export function parseYouTubeUrl(str) {
  const s = String(str ?? '').trim();
  if (ID.test(s)) return { videoId: s, start: 0 };
  let u;
  try { u = new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`); } catch { return null; }
  const host = u.hostname.toLowerCase().replace(/^(www|m|music)\./, '');
  const parts = u.pathname.split('/').filter(Boolean);
  let videoId = null;
  if (host === 'youtu.be') videoId = parts[0];
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (parts[0] === 'watch') videoId = u.searchParams.get('v');
    else if (['live', 'shorts', 'embed', 'v'].includes(parts[0])) videoId = parts[1];
  }
  if (!videoId || !ID.test(videoId)) return null;
  const hash = new URLSearchParams(u.hash.replace(/^#/, ''));
  const start = parseTimestamp(u.searchParams.get('t') ?? u.searchParams.get('start') ?? hash.get('t')) ?? 0;
  return { videoId, start };
}
