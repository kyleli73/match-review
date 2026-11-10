import * as db from './db.js';
import { DEFAULT_COLORS, BALL_COLORS, rangeFromPixel, maskFrame, roiMask, findBlobs } from './detect.js';
import { metrics, rollingRate, phaseAt, migrateMatch, teamAggregates, DEFAULT_PHASES, MATCH_LEN } from './metrics.js';
import { matchesCsv, eventsCsv, exportJson, mergeImport } from './exporters.js';
import { createMachine } from './machine.js';
import { loadVideo, unloadVideo, seek, grabFrame, analyze, startCamera, createRecorder } from './video.js';
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
const relTime = () => video.currentTime - (app.match?.startOffset ?? 0);

function drawPlayhead() {
  if (!app.match) return;
  drawTimeline($('timeline'), { events: app.match.events, playhead: relTime(), selectedId: app.selectedId });
  $('timeLabel').textContent = `${fmtTime(relTime())} match | ${video.currentTime.toFixed(2)}s video`;
  $('btnPlay').textContent = video.paused ? 'Play' : 'Pause';
}

// ---------- overlay / detection preview ----------
const scratch = document.createElement('canvas');
const tint = document.createElement('canvas');
const TINT = { pollen: [250, 204, 21], red: [239, 68, 68], blue: [59, 130, 246] };
const RING = { pollen: '#fde68a', red: '#fca5a5', blue: '#93c5fd' };

function refreshOverlay() {
  const c = $('overlay');
  if (!video.videoWidth) return;
  if (c.width !== video.videoWidth) { c.width = video.videoWidth; c.height = video.videoHeight; }
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  const s = machine.state;
  if (s !== 'calibrating' && s !== 'reviewing') return;
  const on = $('overlayToggle').checked;
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
  $('btnAnalyze').disabled = p.roi.length < 3 || (p.mode === 'line' && !p.scoreLine);
  $('btnAnalyze').title = $('btnAnalyze').disabled ? 'Draw the HIVE cell (and a score line in line mode) first' : '';
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
    let blob = await db.getVideo(match.videoKey);
    if (!blob) blob = await reattachVideo(match);
    app.match = match;
    const stored = app.profiles.find((p) => p.id === match.cameraProfileId) || app.profiles.find((p) => p.id === store.get('lastProfile'));
    app.profile = stored ? clone(stored) : newProfile();
    app.selectedId = null;
    const meta = await loadVideo(video, blob);
    $('vidwrap').style.aspectRatio = `${meta.width} / ${meta.height}`;
    $('vidwrap').style.maxWidth = `calc(62vh * ${meta.width / meta.height})`;
    $('overlayToggle').checked = false;
    fillProfileSelect();
    machine.send(match.events.length ? 'loadedReview' : 'loaded');
    await seek(video, match.startOffset);
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
      await db.putVideo(match.videoKey, inp.files[0]);
      resolve(inp.files[0]);
    };
    inp.oncancel = () => reject(new Error('no video chosen'));
    inp.click();
  });
}

async function deleteMatch(id) {
  const m = app.matches.find((x) => x.id === id);
  if (!confirm(`Delete match ${m.matchNo} and its video from this device?`)) return;
  await db.del('matches', id);
  await db.delVideo(m.videoKey);
  app.matches = app.matches.filter((x) => x.id !== id);
  refreshLibrary();
}

function closeMatch() {
  if (app.match) { clearTimeout(saveTimer); app.match.updatedAt = Date.now(); db.put('matches', app.match); }
  unloadVideo(video);
  machine.send('close');
}

async function runAnalysis() {
  if (!machine.send('analyze')) return;
  await saveProfile();
  app.abort = new AbortController();
  const fps = Number($('fpsSel').value);
  const offset = app.match.startOffset;
  $('progress').value = 0;
  try {
    const raw = await analyze({
      video, profile: clone(app.profile), startOffset: offset, fps, signal: app.abort.signal,
      onProgress: (f, t) => { $('progress').value = f; $('progressLabel').textContent = `${Math.round(f * 100)}%  video ${t.toFixed(1)}s`; },
    });
    const auto = raw.map((e) => {
      const t = Math.round((e.t - offset) * 1000) / 1000;
      return { id: uid('e'), t, kind: 'launch', color: e.color, source: 'auto', phase: phaseAt(t) };
    });
    app.match.events = [...app.match.events.filter((e) => e.source === 'manual'), ...auto].sort((a, b) => a.t - b.t);
    saveMatch();
    machine.send('done');
    toast(`Found ${auto.length} launches`);
  } catch (e) {
    if (e.name === 'AbortError') toast('Analysis cancelled');
    else toast(`Analysis failed: ${e.message}`);
    machine.send(e.name === 'AbortError' ? 'cancel' : 'error');
  }
  await seek(video, offset).catch(() => {});
  refreshOverlay(); drawPlayhead();
}

// ---------- events ----------
function selectEvent(id) {
  app.selectedId = id;
  const e = app.match.events.find((x) => x.id === id);
  if (e) seek(video, app.match.startOffset + e.t).then(() => { refreshOverlay(); drawPlayhead(); });
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
  video.pause();
  await seek(video, video.currentTime + dt);
  refreshOverlay(); drawPlayhead();
}
const togglePlay = () => (video.paused ? video.play() : video.pause());

function frameLoop() {
  refreshOverlay(); drawPlayhead();
  if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(frameLoop);
}
if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(frameLoop);
for (const ev of ['timeupdate', 'seeked', 'play', 'pause']) video.addEventListener(ev, () => { if (machine.state === 'calibrating' || machine.state === 'reviewing') { drawPlayhead(); if (ev !== 'timeupdate') refreshOverlay(); } });

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
$('rateSel').onchange = (e) => { video.playbackRate = Number(e.target.value); };
$('overlayToggle').onchange = refreshOverlay;
$('btnAdd').onclick = addEvent;
$('btnTip').onclick = addTip;
$('btnDelete').onclick = () => deleteEvent();
$('btnRecal').onclick = () => machine.send('recalibrate');
$('btnSkip').onclick = () => machine.send('review');
$('btnAnalyze').onclick = runAnalysis;
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
  const next = video.currentTime;
  // events are match-relative, so keep their video position fixed when the start moves
  for (const e of app.match.events) { e.t = Math.round((e.t + old - next) * 1000) / 1000; e.phase = phaseAt(e.t); }
  app.match.startOffset = next;
  saveMatch(); syncCalibUi(); refreshMetrics();
};

$('timeline').addEventListener('click', (e) => {
  const hit = timelineHit($('timeline'), e.clientX, app.match.events);
  if (hit.eventId) selectEvent(hit.eventId);
  else seek(video, app.match.startOffset + hit.t).then(() => { refreshOverlay(); drawPlayhead(); });
});
window.addEventListener('resize', () => { if (app.match && machine.state !== 'idle') refreshMetrics(); });

// new match form
$('fileInput').onchange = (e) => {
  app.pendingBlob = e.target.files[0] || null;
  $('pickedName').textContent = app.pendingBlob ? `Selected: ${app.pendingBlob.name}` : 'No video selected.';
};
$('newMatch').onsubmit = async (e) => {
  e.preventDefault();
  if (!app.pendingBlob) return toast('Pick or record a video first');
  const id = uid('m');
  const match = {
    id, matchNo: $('matchNo').value.trim(), alliance: $('alliance').value,
    teams: $('teams').value.split(/[,\s]+/).filter(Boolean), videoKey: `v_${id}`,
    cameraProfileId: store.get('lastProfile', null), startOffset: 0, events: [], updatedAt: Date.now(),
  };
  await db.putVideo(match.videoKey, app.pendingBlob);
  await db.put('matches', match);
  app.matches.push(match);
  app.pendingBlob = null;
  e.target.reset();
  $('pickedName').textContent = 'No video selected.';
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
    ' ': togglePlay, k: () => video.pause(), j: () => step(-big), l: () => step(big),
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
