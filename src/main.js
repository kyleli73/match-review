import * as db from './db.js';
import { DEFAULT_COLORS, BALL_COLORS, rangeFromPixel, maskFrame, roiMask, findBlobs } from './detect.js';
import { metrics, rollingRate, phaseAt, migrateMatch, teamAggregates, DEFAULT_PHASES, MATCH_LEN } from './metrics.js';
import { matchesCsv, eventsCsv, exportJson, mergeImport } from './exporters.js';
import { createMachine } from './machine.js';
import { loadVideo, unloadVideo, grabFrame, analyze, startCamera, createRecorder } from './video.js';
import { createFilePlayer, createYouTubePlayer, createOfflinePlayer } from './player.js';
import { captureAnalyze, captureSupported } from './capture.js';
import { parseYouTubeUrl } from './youtube.js';
import {
  el, fmt, fmtTime, toast, renderMatchTable, renderTeamTable, renderMetrics, renderEventList,
  drawTimeline, timelineHit, drawChart, Calibrator,
} from './ui.js';

const $ = (id) => document.getElementById(id);
const video = $('video');
const FRAME = 1 / 30;
const uid = (p) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const clone = (o) => JSON.parse(JSON.stringify(o));
const store = {
  get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

let player = null;
const isYt = () => app.match?.source?.kind === 'youtube';
const app = { matches: [], profiles: [], match: null, profile: null, selectedId: null, pendingBlob: null, abort: null, detect: { blobs: [] } };
const machine = createMachine('idle', () => render());

const newProfile = () => ({
  id: uid('p'), name: 'Camera profile', roi: [], launchRoi: [], scoreLine: null, mode: 'region',
  colors: clone(DEFAULT_COLORS), minArea: 12, maxArea: 2500,
});

// ---------- persistence ----------
let saveTimer;
// Old profiles only have purple/green ranges: keep valid keys, fill missing ones from the BIOBUZZ presets.
const migrateProfile = (p) => ({ ...p, colors: { ...clone(DEFAULT_COLORS), ...Object.fromEntries(Object.entries(p.colors || {}).filter(([k]) => k in DEFAULT_COLORS)) } });

function saveMatch() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    app.match.updatedAt = Date.now();
    db.put('matches', app.match).catch((e) => toast(`Save failed: ${e.message}`));
  }, 250);
}
async function saveProfile() {
  const p = app.profile;
  p.updatedAt = Date.now();
  await db.put('profiles', clone(p));
  const i = app.profiles.findIndex((x) => x.id === p.id);
  if (i >= 0) app.profiles[i] = clone(p); else app.profiles.push(clone(p));
  app.match.cameraProfileId = p.id;
  store.set('lastProfile', p.id);
  saveMatch();
  fillProfileSelect();
}

// ---------- rendering ----------
function render() {
  const s = machine.state;
  document.body.dataset.state = s;
  $('stateBadge').textContent = s;
  document.querySelectorAll('[data-show]').forEach((n) => { n.hidden = !n.dataset.show.split(' ').includes(s); });
  $('btnLibrary').disabled = s === 'analyzing' || s === 'loading';
  if (s === 'idle') return refreshLibrary();
  syncCalibUi();
  refreshOverlay();
  refreshMetrics();
}

function refreshLibrary() {
  const rows = app.matches.slice().sort((a, b) => b.updatedAt - a.updatedAt).map((match) => ({ match, m: metrics(match.events, DEFAULT_PHASES, { gapSec: gap() }) }));
  renderMatchTable($('matchTable'), rows, { onOpen: openMatch, onDelete: deleteMatch });
  renderTeamTable($('teamTable'), teamAggregates(app.matches, { gapSec: gap() }));
}

const gap = () => Math.max(0.5, Number($('gapInput').value) || 3);

function refreshMetrics() {
  if (!app.match || (machine.state !== 'reviewing' && machine.state !== 'calibrating')) return;
  const m = metrics(app.match.events, DEFAULT_PHASES, { gapSec: gap() });
  renderMetrics($('metricCards'), $('phaseTable'), m);
  drawChart($('chart'), rollingRate(app.match.events, MATCH_LEN, 5, 1), m.burst);
  renderEventList($('eventList'), sortedEvents(), app.selectedId, {
    onSelect: selectEvent, onDelete: deleteEvent,
    onColor: (id, c) => { app.match.events.find((e) => e.id === id).color = c; saveMatch(); refreshMetrics(); },
  });
  drawPlayhead();
}

const sortedEvents = () => app.match.events.slice().sort((a, b) => a.t - b.t);
const relTime = () => (player?.currentTime() ?? 0) - (app.match?.startOffset ?? 0);

function drawPlayhead() {
  if (!app.match || !player) return;
  drawTimeline($('timeline'), { events: app.match.events, playhead: relTime(), selectedId: app.selectedId });
  $('timeLabel').textContent = `${fmtTime(relTime())} match | ${player.currentTime().toFixed(2)}s video`;
  $('btnPlay').textContent = player.isPaused() ? 'Play' : 'Pause';
}

// ---------- overlay / detection preview ----------
const scratch = document.createElement('canvas');
const tint = document.createElement('canvas');
const TINT = { pollen: [250, 204, 21], red: [239, 68, 68], blue: [59, 130, 246] };
const RING = { pollen: '#fde68a', red: '#fca5a5', blue: '#93c5fd' };

function refreshOverlay() {
  const c = $('overlay');
  const [w0, h0] = isYt() ? [1280, 720] : [video.videoWidth, video.videoHeight];
  if (!w0) return;
  if (c.width !== w0) { c.width = w0; c.height = h0; }
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  const s = machine.state;
  if (s !== 'calibrating' && s !== 'reviewing') return;
  const on = $('overlayToggle').checked && !isYt(); // no pixel access to an iframe
  if (on) drawDetection(ctx, c);
  if (s === 'calibrating' || on) cal.draw(ctx);
}

function drawDetection(ctx, c) {
  const img = grabFrame(video, scratch);
  const { width: w, height: h } = img;
  const roi = roiMask(w, h, app.profile.roi);
  const out = new ImageData(w, h);
  const blobs = [];
  for (const key of BALL_COLORS) {
    const range = app.profile.colors[key];
    if (!range) continue;
    const mask = maskFrame(img, range, roi);
    const [r, g, b] = TINT[key];
    for (let i = 0; i < mask.length; i++) if (mask[i]) { out.data.set([r, g, b, 150], i * 4); }
    for (const bl of findBlobs(mask, w, h, app.profile.minArea, app.profile.maxArea)) blobs.push({ ...bl, color: key });
  }
  tint.width = w; tint.height = h;
  tint.getContext('2d').putImageData(out, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tint, 0, 0, c.width, c.height);
  const k = c.width / w;
  ctx.lineWidth = Math.max(2, c.width / 400);
  for (const b of blobs) {
    ctx.strokeStyle = RING[b.color];
    ctx.beginPath(); ctx.arc(b.x * k, b.y * k, Math.sqrt(b.area / Math.PI) * k + 4, 0, 7); ctx.stroke();
  }
}

// ---------- calibration ----------
const cal = new Calibrator($('overlay'), {
  getProfile: () => app.profile,
  onChange: () => { syncCalibUi(); refreshOverlay(); },
  onPick: (key, p) => {
    if (isYt()) return toast('Color picking needs pixels the iframe does not expose; default colors are used');
    const img = grabFrame(video, scratch);
    const cx = Math.round(p.x * (img.width - 1)), cy = Math.round(p.y * (img.height - 1));
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = Math.max(0, cy - 2); y <= Math.min(img.height - 1, cy + 2); y++) {
      for (let x = Math.max(0, cx - 2); x <= Math.min(img.width - 1, cx + 2); x++) {
        const i = (y * img.width + x) * 4;
        r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2]; n++;
      }
    }
    app.profile.colors[key] = rangeFromPixel(r / n, g / n, b / n);
    toast(`${key} range set from clicked pixel`);
    syncCalibUi(); refreshOverlay();
  },
  onTool: (tool) => {
    document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === tool));
    $('vidwrap').classList.toggle('drawing', !!tool);
    const hints = {
      roi: 'Click the corners of the alliance HIVE cell opening. Click the first point or press Enter to close.',
      launch: 'Click the launch zone corners. Click the first point or press Enter to close.',
      line: 'Click two points to place the score line (balls crossing it count).',
      pickPollen: 'Click a yellow POLLEN ball in the frame.',
      pickRed: 'Click a red NECTAR ball in the frame.',
      pickBlue: 'Click a blue NECTAR ball in the frame.',
    };
    $('toolHint').textContent = hints[tool] || 'Choose a tool, then click on the video.';
    refreshOverlay();
  },
});

function syncCalibUi() {
  const p = app.profile;
  if (!p) return;
  $('profileName').value = p.name;
  $('modeSel').value = p.mode;
  $('minArea').value = p.minArea;
  $('maxArea').value = p.maxArea;
  $('startInfo').textContent = app.match ? `start = ${app.match.startOffset.toFixed(2)} s` : '';
  const yt = isYt();
  const btn = yt ? $('btnAutoCount') : $('btnAnalyze');
  $('btnAnalyze').hidden = yt;
  $('btnAutoCount').hidden = !yt;
  $('captureNote').hidden = !yt;
  document.querySelectorAll('[data-tool^="pick"]').forEach((b) => { b.hidden = yt; });
  $('overlayToggle').closest('label').hidden = yt;
  const offline = player?.offline;
  btn.disabled = p.roi.length < 3 || (p.mode === 'line' && !p.scoreLine) || !!offline;
  btn.title = btn.disabled ? 'Draw the HIVE cell (and a score line in line mode) first' : '';
  if (yt) {
    $('captureNote').textContent = offline ? 'YouTube needs internet. Events, metrics and edits still work; reconnect to play or auto-count.'
      : captureSupported() ? 'Auto-count records this tab while the video plays at 1x from the match start. Keep this tab visible, the player unobscured, and do not scroll or resize until it finishes. Pick "This tab" in the share dialog. Needs desktop Chrome or Edge.'
        : 'Auto-count is not available in this browser (no screen capture, e.g. iPad Safari). Manual review still works: step through the video and add events.';
  }
}

function fillProfileSelect() {
  const sel = $('profileSelect');
  sel.replaceChildren(...app.profiles.map((p) => el('option', { value: p.id, selected: p.id === app.profile?.id }, p.name)));
  if (!app.profiles.some((p) => p.id === app.profile?.id)) sel.append(el('option', { value: app.profile.id, selected: true }, `${app.profile.name} (unsaved)`));
  sel.append(el('option', { value: '__new' }, '+ New profile'));
}

// ---------- match lifecycle ----------
async function openMatch(id) {
  if (!machine.send('load')) return;
  try {
    const match = app.matches.find((m) => m.id === id);
    const src = match.source;
    let blob = null;
    if (src.kind === 'file') {
      blob = await db.getVideo(src.videoKey);
      if (!blob) blob = await reattachVideo(match);
    }
    app.match = match;
    const stored = app.profiles.find((p) => p.id === match.cameraProfileId) || app.profiles.find((p) => p.id === store.get('lastProfile'));
    app.profile = stored ? clone(stored) : newProfile();
    app.selectedId = null;
    const wrap = $('vidwrap');
    wrap.classList.toggle('yt', src.kind === 'youtube');
    video.hidden = src.kind === 'youtube';
    let startAt = match.startOffset;
    if (src.kind === 'file') {
      const meta = await loadVideo(video, blob);
      wrap.style.aspectRatio = `${meta.width} / ${meta.height}`;
      wrap.style.maxWidth = `calc(62vh * ${meta.width / meta.height})`;
      player = createFilePlayer(video);
    } else {
      wrap.style.aspectRatio = '16 / 9';
      wrap.style.maxWidth = `calc(62vh * ${16 / 9})`;
      startAt = match.startOffset || src.startHint || 0;
      const mount = el('div', { class: 'ytmount' });
      wrap.prepend(mount);
      try {
        player = await createYouTubePlayer(mount, { videoId: src.videoId, start: startAt });
      } catch (err) {
        mount.replaceChildren(el('div', { class: 'ytoffline' }, 'YouTube needs internet'));
        player = createOfflinePlayer(startAt);
        toast(err.message);
      }
      const inner = player.destroy;
      player.destroy = () => { inner(); mount.remove(); };
    }
    player.onTick(onTick);
    $('rateSel').replaceChildren(...player.rates().map((r) => el('option', { value: r, selected: r === 1 }, String(r))));
    $('overlayToggle').checked = false;
    fillProfileSelect();
    machine.send(match.events.length ? 'loadedReview' : 'loaded');
    await player.seek(startAt);
    refreshOverlay(); drawPlayhead();
  } catch (e) {
    toast(`Could not load video: ${e.message}`);
    machine.send('fail');
  }
}

function reattachVideo(match) {
  toast('This match came from an import, so its video is missing. Choose the video file.');
  return new Promise((resolve, reject) => {
    const inp = el('input', { type: 'file', accept: 'video/*' });
    inp.onchange = async () => {
      if (!inp.files[0]) return reject(new Error('no video chosen'));
      await db.putVideo(match.source.videoKey, inp.files[0]);
      resolve(inp.files[0]);
    };
    inp.oncancel = () => reject(new Error('no video chosen'));
    inp.click();
  });
}

async function deleteMatch(id) {
  const m = app.matches.find((x) => x.id === id);
  if (!confirm(`Delete match ${m.matchNo}${m.source.kind === 'file' ? ' and its video' : ''} from this device?`)) return;
  await db.del('matches', id);
  if (m.source.kind === 'file') await db.delVideo(m.source.videoKey);
  app.matches = app.matches.filter((x) => x.id !== id);
  refreshLibrary();
}

function closeMatch() {
  if (app.match) { clearTimeout(saveTimer); app.match.updatedAt = Date.now(); db.put('matches', app.match); }
  const wasYt = isYt();
  player?.destroy();
  player = null;
  if (!wasYt) unloadVideo(video);
  machine.send('close');
}

async function runAnalysis() {
  const yt = isYt();
  if (yt && !captureSupported()) return toast('Screen capture is not available in this browser. Use manual review.');
  if (!machine.send('analyze')) return;
  const saved = saveProfile().catch((e) => toast(`Save failed: ${e.message}`));
  if (!yt) await saved;
  app.abort = new AbortController();
  const fps = Number($('fpsSel').value);
  const offset = app.match.startOffset;
  $('progress').value = 0;
  $('progressLabel').textContent = '';
  $('analyzeHint').hidden = !yt;
  $('analyzeHint').textContent = 'Capturing this tab. Keep it visible and the player unobscured; the match plays at 1x (about 2.6 min).';
  if (yt) window.scrollTo(0, 0);
  const onProgress = (f, t) => { $('progress').value = f; $('progressLabel').textContent = `${Math.round(f * 100)}%  video ${t.toFixed(1)}s`; };
  try {
    let raw, completed = true;
    if (yt) ({ events: raw, completed } = await captureAnalyze({ player, region: $('vidwrap'), profile: clone(app.profile), startOffset: offset, fps, signal: app.abort.signal, onProgress }));
    else raw = await analyze({ video, profile: clone(app.profile), startOffset: offset, fps, signal: app.abort.signal, onProgress });
    await saved;
    const auto = raw.map((e) => {
      const t = Math.round((e.t - offset) * 1000) / 1000;
      return { id: uid('e'), t, kind: 'launch', color: e.color, source: 'auto', phase: phaseAt(t) };
    });
    app.match.events = [...app.match.events.filter((e) => e.source === 'manual'), ...auto].sort((a, b) => a.t - b.t);
    saveMatch();
    machine.send('done');
    toast(completed ? `Found ${auto.length} launches` : `Sharing stopped early: kept ${auto.length} launches so far`);
  } catch (e) {
    if (e.name === 'AbortError') toast('Analysis cancelled');
    else if (e.name === 'NotAllowedError') toast('Screen sharing was not granted');
    else toast(`Analysis failed: ${e.message}`);
    machine.send(e.name === 'AbortError' ? 'cancel' : 'error');
  }
  await player.seek(offset).catch(() => {});
  refreshOverlay(); drawPlayhead();
}

// ---------- events ----------
function selectEvent(id) {
  app.selectedId = id;
  const e = app.match.events.find((x) => x.id === id);
  if (e) player.seek(app.match.startOffset + e.t).then(() => { refreshOverlay(); drawPlayhead(); });
  refreshMetrics();
}
function addEvent() {
  const t = Math.round(relTime() * 1000) / 1000;
  const e = { id: uid('e'), t, kind: 'launch', color: $('manualColor').value, source: 'manual', phase: phaseAt(t) };
  app.match.events.push(e);
  app.selectedId = e.id;
  saveMatch(); refreshMetrics();
}
function addTip() {
  const t = Math.round(relTime() * 1000) / 1000;
  const e = { id: uid('e'), t, kind: 'tip', color: 'other', source: 'manual', phase: phaseAt(t) };
  app.match.events.push(e);
  app.selectedId = e.id;
  saveMatch(); refreshMetrics();
}
function deleteEvent(id = app.selectedId) {
  if (!id) return;
  app.match.events = app.match.events.filter((e) => e.id !== id);
  if (app.selectedId === id) app.selectedId = null;
  saveMatch(); refreshMetrics();
}
function jumpEvent(dir) {
  const evs = sortedEvents();
  const t = relTime();
  const next = dir > 0 ? evs.find((e) => e.t > t + 0.01) : evs.reverse().find((e) => e.t < t - 0.01);
  if (next) selectEvent(next.id);
}

// ---------- transport ----------
async function step(dt) {
  player.pause();
  await player.seek(player.currentTime() + dt);
  refreshOverlay(); drawPlayhead();
}
const togglePlay = () => (player.isPaused() ? player.play() : player.pause());

function onTick(ev) {
  const s = machine.state;
  if (ev === 'timeupdate' || ev === 'seeked' || ev === 'play' || ev === 'pause') {
    if (s === 'calibrating' || s === 'reviewing') { drawPlayhead(); if (ev !== 'timeupdate') refreshOverlay(); }
  } else { refreshOverlay(); drawPlayhead(); }
}

// ---------- exports / library ----------
function download(name, text, type) {
  const a = el('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const stamp = () => new Date().toISOString().slice(0, 10);

// ---------- wiring ----------
$('btnLibrary').onclick = () => { if (machine.state !== 'idle') closeMatch(); };
$('btnHelp').onclick = () => $('helpDialog').showModal();
$('helpClose').onclick = () => $('helpDialog').close();
$('btnStepBack').onclick = () => step(-FRAME);
$('btnStepFwd').onclick = () => step(FRAME);
$('btnPlay').onclick = togglePlay;
$('rateSel').onchange = (e) => player?.setRate(Number(e.target.value));
$('overlayToggle').onchange = refreshOverlay;
$('btnAdd').onclick = addEvent;
$('btnTip').onclick = addTip;
$('btnDelete').onclick = () => deleteEvent();
$('btnRecal').onclick = () => machine.send('recalibrate');
$('btnSkip').onclick = () => machine.send('review');
$('btnAnalyze').onclick = runAnalysis;
$('btnAutoCount').onclick = runAnalysis;
$('btnCancel').onclick = () => app.abort?.abort();
$('manualColor').onchange = (e) => store.set('manualColor', e.target.value);
$('manualColor').value = store.get('manualColor', 'pollen');
if (!$('manualColor').value) $('manualColor').value = 'pollen'; // stale stored purple/green
$('gapInput').value = store.get('gap', '3');
$('gapInput').onchange = () => { store.set('gap', $('gapInput').value); refreshMetrics(); };
$('fpsSel').value = store.get('fps', '15');
$('fpsSel').onchange = (e) => store.set('fps', e.target.value);

document.querySelectorAll('[data-tool]').forEach((b) => { b.onclick = () => cal.setTool(b.dataset.tool); });
$('btnClearShapes').onclick = () => { Object.assign(app.profile, { roi: [], launchRoi: [], scoreLine: null }); syncCalibUi(); refreshOverlay(); };
$('btnResetColors').onclick = () => { app.profile.colors = clone(DEFAULT_COLORS); refreshOverlay(); toast('Colors reset to pollen/red/blue presets'); };
$('profileName').oninput = (e) => { app.profile.name = e.target.value; };
$('btnSaveProfile').onclick = async () => { await saveProfile(); toast('Profile saved'); };
$('profileSelect').onchange = (e) => {
  const v = e.target.value;
  app.profile = v === '__new' ? newProfile() : clone(app.profiles.find((p) => p.id === v));
  if (v !== '__new') app.match.cameraProfileId = v;
  fillProfileSelect(); syncCalibUi(); refreshOverlay();
};
$('modeSel').onchange = (e) => { app.profile.mode = e.target.value; syncCalibUi(); refreshOverlay(); };
$('minArea').onchange = (e) => { app.profile.minArea = Math.max(1, Number(e.target.value) || 1); refreshOverlay(); };
$('maxArea').onchange = (e) => { app.profile.maxArea = Math.max(1, Number(e.target.value) || 2500); refreshOverlay(); };
$('btnStart').onclick = () => {
  const old = app.match.startOffset;
  const next = player.currentTime();
  // events are match-relative, so keep their video position fixed when the start moves
  for (const e of app.match.events) { e.t = Math.round((e.t + old - next) * 1000) / 1000; e.phase = phaseAt(e.t); }
  app.match.startOffset = next;
  saveMatch(); syncCalibUi(); refreshMetrics();
};

$('timeline').addEventListener('click', (e) => {
  const hit = timelineHit($('timeline'), e.clientX, app.match.events);
  if (hit.eventId) selectEvent(hit.eventId);
  else player.seek(app.match.startOffset + hit.t).then(() => { refreshOverlay(); drawPlayhead(); });
});
window.addEventListener('resize', () => { if (app.match && machine.state !== 'idle') refreshMetrics(); });

// new match form
$('fileInput').onchange = (e) => {
  app.pendingBlob = e.target.files[0] || null;
  $('pickedName').textContent = app.pendingBlob ? `Selected: ${app.pendingBlob.name}` : 'No video selected.';
};
$('ytUrl').oninput = () => {
  const v = $('ytUrl').value.trim();
  const y = v && parseYouTubeUrl(v);
  $('ytNote').textContent = !v ? '' : y ? `YouTube video ${y.videoId}${y.start ? `, starts at ${fmtTime(y.start)}` : ''}` : 'Not a recognised YouTube link';
};
$('newMatch').onsubmit = async (e) => {
  e.preventDefault();
  const ytText = $('ytUrl').value.trim();
  const y = ytText ? parseYouTubeUrl(ytText) : null;
  if (ytText && !y) return toast('Not a recognised YouTube link');
  if (y && app.pendingBlob) return toast('Use either a video file or a YouTube link, not both');
  if (!y && !app.pendingBlob) return toast('Pick or record a video, or paste a YouTube link');
  const id = uid('m');
  const match = {
    id, matchNo: $('matchNo').value.trim(), alliance: $('alliance').value,
    teams: $('teams').value.split(/[,\s]+/).filter(Boolean),
    source: y ? { kind: 'youtube', videoId: y.videoId, url: ytText, startHint: y.start } : { kind: 'file', videoKey: `v_${id}` },
    cameraProfileId: store.get('lastProfile', null), startOffset: 0, events: [], updatedAt: Date.now(),
  };
  if (!y) await db.putVideo(match.source.videoKey, app.pendingBlob);
  await db.put('matches', match);
  app.matches.push(match);
  app.pendingBlob = null;
  e.target.reset();
  $('pickedName').textContent = 'No video selected.';
  $('ytNote').textContent = '';
  openMatch(id);
};

// camera recording
let camStream = null, recorder = null;
const stopCam = () => { camStream?.getTracks().forEach((t) => t.stop()); camStream = null; $('recPreview').srcObject = null; };
$('btnRecord').onclick = async () => {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return toast('Camera recording is not supported in this browser');
  $('recDialog').showModal();
  $('recStatus').textContent = 'Starting camera...';
  try {
    camStream = await startCamera($('recPreview'));
    $('recStatus').textContent = 'Camera ready.';
    $('recStart').disabled = false;
  } catch (err) {
    $('recStatus').textContent = `Camera unavailable: ${err.message}`;
  }
};
$('recStart').onclick = () => {
  recorder = createRecorder(camStream);
  recorder.start();
  $('recStart').disabled = true; $('recStop').disabled = false;
  $('recStatus').textContent = 'Recording...';
};
$('recStop').onclick = async () => {
  app.pendingBlob = await recorder.stop();
  stopCam();
  $('pickedName').textContent = `Recorded clip (${(app.pendingBlob.size / 1e6).toFixed(1)} MB)`;
  $('recStop').disabled = true;
  $('recDialog').close();
};
$('recCancel').onclick = () => { recorder = null; stopCam(); $('recStop').disabled = true; $('recDialog').close(); };
$('recDialog').addEventListener('close', () => { if (camStream) stopCam(); $('recStop').disabled = true; });

$('btnExportMatches').onclick = () => download(`matches-${stamp()}.csv`, matchesCsv(app.matches, { gapSec: gap() }), 'text/csv');
$('btnExportEvents').onclick = () => download(`events-${stamp()}.csv`, eventsCsv(app.matches), 'text/csv');
$('btnExportJson').onclick = () => download(`match-review-${stamp()}.json`, exportJson(app.matches, app.profiles), 'application/json');
$('btnImport').onclick = () => $('importInput').click();
$('importInput').onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const r = mergeImport({ matches: app.matches, profiles: app.profiles }, JSON.parse(await f.text()));
    for (const m of r.matches) await db.put('matches', m);
    for (const p of r.profiles) await db.put('profiles', p);
    app.matches = r.matches; app.profiles = r.profiles;
    refreshLibrary();
    toast(`Imported: ${r.added} new, ${r.updated} updated matches`);
  } catch (err) { toast(`Import failed: ${err.message}`); }
};

// keyboard
document.addEventListener('keydown', (e) => {
  if (e.key === '?' && !/INPUT|TEXTAREA/.test(e.target.tagName)) { $('helpDialog').open ? $('helpDialog').close() : $('helpDialog').showModal(); return; }
  if (e.key === 'Escape') { if (cal.tool) cal.setTool(cal.tool); return; }
  const s = machine.state;
  if ((s !== 'calibrating' && s !== 'reviewing') || e.ctrlKey || e.metaKey || e.altKey) return;
  if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || document.querySelector('dialog[open]')) return;
  const k = e.key.toLowerCase();
  const big = e.shiftKey ? 1 : FRAME;
  const acts = {
    ' ': togglePlay, k: () => player.pause(), j: () => step(-big), l: () => step(big),
    arrowleft: () => step(-big), arrowright: () => step(big), a: addEvent, o: () => { $('overlayToggle').checked = !$('overlayToggle').checked; refreshOverlay(); },
    delete: () => deleteEvent(), backspace: () => deleteEvent(), enter: () => cal.finish(),
    '[': () => jumpEvent(-1), ']': () => jumpEvent(1),
    1: () => setManual('pollen'), 2: () => setManual('red'), 3: () => setManual('blue'), 4: () => setManual('other'), t: addTip,
  };
  if (acts[k]) { e.preventDefault(); acts[k](); }
});
function setManual(c) { $('manualColor').value = c; store.set('manualColor', c); toast(`New events: ${c}`); }

// boot
(async function init() {
  try {
    [app.matches, app.profiles] = await Promise.all([db.getAll('matches'), db.getAll('profiles')]);
    app.matches = app.matches.map(migrateMatch);
    app.profiles = app.profiles.map(migrateProfile);
  } catch (e) { toast(`Storage unavailable: ${e.message}`); }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
  render();
})();
