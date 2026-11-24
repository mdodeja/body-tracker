import { FilesetResolver, PoseLandmarker, HandLandmarker } from '../vendor/tasks-vision/vision_bundle.mjs';
import { JOINTS, computeAngles, smoothAngles, sideOf } from './geometry.js';
import { Recorder, download } from './recorder.js';

const WASM_PATH = new URL('../vendor/tasks-vision/wasm', import.meta.url).href;
const MODEL_PATHS = {
  lite: new URL('../models/pose_landmarker_lite.task', import.meta.url).href,
  full: new URL('../models/pose_landmarker_full.task', import.meta.url).href,
  hand: new URL('../models/hand_landmarker.task', import.meta.url).href,
};
const COLORS = { left: '#2dd4bf', right: '#fb923c', center: '#eef2f6' };
const MIN_VISIBILITY = 0.5;

const $ = (id) => document.getElementById(id);
const el = {
  view: $('view'), cam: $('cam'), status: $('status'), stats: $('stats'), recTime: $('rec-time'),
  intro: $('intro'), introStart: $('intro-start'), introFile: $('intro-file'), introError: $('intro-error'),
  angles: $('angles'), angleRows: $('angle-rows'),
  btnCamera: $('btn-camera'), btnFlip: $('btn-flip'), btnRecord: $('btn-record'),
  btnAngles: $('btn-angles'), btnSettings: $('btn-settings'),
  settings: $('settings'), optModel: $('opt-model'), optHands: $('opt-hands'), optLabels: $('opt-labels'),
  btnFile: $('btn-file'), file: $('file'),
  exportDlg: $('export'), exportSummary: $('export-summary'), exportCsv: $('export-csv'), exportJson: $('export-json'),
};
const ctx = el.view.getContext('2d');

const settings = Object.assign(
  { model: 'lite', hands: false, labels: true, angles: true, facing: 'user' },
  JSON.parse(localStorage.getItem('body-tracker-settings') || '{}'),
);
const saveSettings = () => localStorage.setItem('body-tracker-settings', JSON.stringify(settings));

const recorder = new Recorder();
const state = {
  fileset: null,
  pose: null,
  hand: null,
  delegate: null,
  source: null, // { kind: 'camera' | 'video' | 'image', element, mirror, stream?, url? }
  running: false,
  lastVideoTime: -1,
  lastTimestamp: 0,
  lastFrameAt: 0,
  fps: 0,
  inferMs: 0,
  angles: null,
  wakeLock: null,
  last: null, // summary of the most recent frame, exposed for debugging and tests
};
window.bodyTracker = state;

// ---------------------------------------------------------------- models

async function createWithFallback(Task, options) {
  const preferred = state.delegate ? [state.delegate] : ['GPU', 'CPU'];
  let lastError;
  for (const delegate of preferred) {
    try {
      const task = await Task.createFromOptions(state.fileset, {
        ...options,
        baseOptions: { ...options.baseOptions, delegate },
      });
      state.delegate = delegate;
      return task;
    } catch (err) {
      lastError = err;
      console.warn(`${Task.name} failed to start on ${delegate}`, err);
    }
  }
  throw lastError;
}

async function loadPose() {
  setStatus('Loading model…');
  state.fileset ??= await FilesetResolver.forVisionTasks(WASM_PATH);
  const next = await createWithFallback(PoseLandmarker, {
    baseOptions: { modelAssetPath: MODEL_PATHS[settings.model] },
    runningMode: 'VIDEO',
    numPoses: 1,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  state.pose?.close();
  state.pose = next;
}

async function loadHands() {
  if (!settings.hands) {
    state.hand?.close();
    state.hand = null;
    return;
  }
  if (state.hand) return;
  setStatus('Loading hand model…');
  state.hand = await createWithFallback(HandLandmarker, {
    baseOptions: { modelAssetPath: MODEL_PATHS.hand },
    runningMode: 'VIDEO',
    numHands: 2,
  });
}

/** GPU inference can fail after start-up on some devices; rebuild everything on CPU once. */
async function fallBackToCpu(err) {
  console.warn('Inference failed, retrying on CPU', err);
  state.delegate = 'CPU';
  state.pose?.close();
  state.hand?.close();
  state.pose = state.hand = null;
  await loadPose();
  await loadHands();
}

// ---------------------------------------------------------------- sources

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('The camera needs a secure (https://) page. Open this app over HTTPS, or analyse a video instead.');
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: settings.facing, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
  });
  stopSource();
  el.cam.srcObject = stream;
  await el.cam.play();
  // Trust what the device actually gave us (a laptop has no rear camera, for instance).
  const actual = stream.getVideoTracks()[0]?.getSettings().facingMode;
  state.source = { kind: 'camera', element: el.cam, stream, mirror: (actual ?? settings.facing) !== 'environment' };
  begin();
}

async function startFile(file) {
  const url = URL.createObjectURL(file);
  let source;
  if (file.type.startsWith('image/')) {
    const img = new Image();
    img.src = url;
    await img.decode();
    source = { kind: 'image', element: img, url, mirror: false };
  } else {
    stopSource();
    el.cam.srcObject = null;
    el.cam.src = url;
    el.cam.loop = true;
    await el.cam.play();
    source = { kind: 'video', element: el.cam, url, mirror: false };
  }
  if (source.kind === 'image') stopSource();
  state.source = source;
  begin();
}

function begin() {
  state.running = true;
  state.lastVideoTime = -1;
  state.angles = null;
  el.intro.hidden = true;
  el.stats.hidden = false;
  requestWakeLock();
  syncUi();
  requestAnimationFrame(tick);
}

function stopSource() {
  if (recorder.active) stopRecording();
  state.running = false;
  const src = state.source;
  if (!src) return;
  src.stream?.getTracks().forEach((t) => t.stop());
  if (src.url) URL.revokeObjectURL(src.url);
  el.cam.pause();
  el.cam.srcObject = null;
  el.cam.removeAttribute('src');
  el.cam.load();
  state.source = null;
  state.last = null;
  state.wakeLock?.release().catch(() => {});
  state.wakeLock = null;
}

function showIntro(errorText) {
  ctx.clearRect(0, 0, el.view.width, el.view.height);
  el.intro.hidden = false;
  el.stats.hidden = true;
  el.introError.hidden = !errorText;
  el.introError.textContent = errorText || '';
  setStatus('Ready');
  syncUi();
}

async function requestWakeLock() {
  try {
    state.wakeLock = (await navigator.wakeLock?.request('screen')) ?? null;
  } catch {
    /* not critical */
  }
}

// ---------------------------------------------------------------- frame loop

function tick(now) {
  if (!state.running) return;
  requestAnimationFrame(tick);

  const src = state.source;
  const frame = src.element;
  const width = frame.videoWidth || frame.naturalWidth;
  const height = frame.videoHeight || frame.naturalHeight;
  if (!width || !state.pose) return;
  if (src.kind !== 'image') {
    if (frame.readyState < 2 || frame.currentTime === state.lastVideoTime) return;
    state.lastVideoTime = frame.currentTime;
  }

  // MediaPipe requires strictly increasing timestamps.
  const timestamp = Math.max(now, state.lastTimestamp + 1);
  state.lastTimestamp = timestamp;

  let poseResult, handResult;
  const t0 = performance.now();
  try {
    poseResult = state.pose.detectForVideo(frame, timestamp);
    handResult = state.hand?.detectForVideo(frame, timestamp);
  } catch (err) {
    state.running = false;
    const recover = state.delegate === 'GPU' ? fallBackToCpu(err) : Promise.reject(err);
    recover.then(
      () => { if (state.source) { state.running = true; requestAnimationFrame(tick); } },
      (e) => { stopSource(); showIntro(`Tracking failed: ${e.message || e}`); },
    );
    return;
  }
  state.inferMs += 0.2 * (performance.now() - t0 - state.inferMs);
  if (state.lastFrameAt) state.fps += 0.1 * (1000 / (now - state.lastFrameAt) - state.fps);
  state.lastFrameAt = now;

  const landmarks = poseResult.landmarks[0] ?? null;
  const world = poseResult.worldLandmarks[0] ?? null;
  const rawAngles = computeAngles(world, MIN_VISIBILITY);
  state.angles = smoothAngles(state.angles, rawAngles);
  const hands = labelHands(handResult, landmarks);

  recorder.add({ landmarks, world, angles: rawAngles, hands });
  state.last = { poseCount: poseResult.landmarks.length, landmarks, angles: rawAngles, hands };

  draw(frame, width, height, src.mirror, landmarks, hands);
  updateReadouts(Boolean(landmarks));
}

/**
 * Decide which hand is which. The model's own left/right label assumes a mirrored
 * image, so prefer matching each hand to the nearest wrist of the tracked body.
 */
function labelHands(result, pose) {
  if (!result?.landmarks?.length) return [];
  return result.landmarks.map((landmarks, i) => {
    let side = result.handedness?.[i]?.[0]?.categoryName === 'Left' ? 'right' : 'left';
    if (pose) {
      const d = (w) => Math.hypot(landmarks[0].x - w.x, landmarks[0].y - w.y);
      side = d(pose[15]) <= d(pose[16]) ? 'left' : 'right';
    }
    return { side, landmarks };
  });
}

// ---------------------------------------------------------------- drawing

function draw(frame, width, height, mirror, pose, hands) {
  if (el.view.width !== width || el.view.height !== height) {
    el.view.width = width;
    el.view.height = height;
  }
  const unit = Math.max(width, height) / 400; // scales strokes and text with resolution
  const px = (p) => (mirror ? 1 - p.x : p.x) * width;
  const py = (p) => p.y * height;

  ctx.save();
  if (mirror) {
    ctx.translate(width, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(frame, 0, 0, width, height);
  ctx.restore();
  ctx.fillStyle = 'rgba(0, 0, 0, 0.18)';
  ctx.fillRect(0, 0, width, height);

  ctx.lineCap = 'round';
  if (pose) {
    const seen = (i) => (pose[i].visibility ?? 1) >= MIN_VISIBILITY;
    for (const { start, end } of PoseLandmarker.POSE_CONNECTIONS) {
      if (!seen(start) || !seen(end)) continue;
      const face = start <= 10 && end <= 10;
      const sa = sideOf(start);
      ctx.strokeStyle = sa === sideOf(end) ? COLORS[sa] : COLORS.center;
      ctx.lineWidth = unit * (face ? 0.7 : 1.8);
      ctx.beginPath();
      ctx.moveTo(px(pose[start]), py(pose[start]));
      ctx.lineTo(px(pose[end]), py(pose[end]));
      ctx.stroke();
    }
    pose.forEach((p, i) => {
      if (!seen(i)) return;
      const face = i <= 10;
      ctx.beginPath();
      ctx.arc(px(p), py(p), unit * (face ? 0.9 : 2.2), 0, Math.PI * 2);
      ctx.fillStyle = face ? COLORS[sideOf(i)] : '#0b0f14';
      ctx.fill();
      if (!face) {
        ctx.lineWidth = unit * 0.9;
        ctx.strokeStyle = COLORS[sideOf(i)];
        ctx.stroke();
      }
    });
  }

  for (const hand of hands) {
    ctx.strokeStyle = COLORS[hand.side];
    ctx.lineWidth = unit * 0.9;
    for (const { start, end } of HandLandmarker.HAND_CONNECTIONS) {
      ctx.beginPath();
      ctx.moveTo(px(hand.landmarks[start]), py(hand.landmarks[start]));
      ctx.lineTo(px(hand.landmarks[end]), py(hand.landmarks[end]));
      ctx.stroke();
    }
    ctx.fillStyle = '#fff';
    for (const p of hand.landmarks) {
      ctx.beginPath();
      ctx.arc(px(p), py(p), unit * 0.9, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  if (pose && settings.labels && state.angles) drawAngleLabels(pose, unit, px, py);
}

function drawAngleLabels(pose, unit, px, py) {
  const size = unit * 6.5;
  ctx.font = `600 ${size}px system-ui, sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  for (const joint of JOINTS) {
    if (joint.key === 'wrist') continue; // too cluttered next to the hand points
    for (const [side, offset] of [['left', 0], ['right', 1]]) {
      const angle = state.angles[`${side}_${joint.key}`];
      if (angle == null) continue;
      const p = pose[joint.left[1] + offset];
      const text = `${Math.round(angle)}°`;
      const w = ctx.measureText(text).width + unit * 4;
      const h = size * 1.35;
      // Push the label outward from the body's centre line so it does not cover the limb.
      const outward = Math.sign(px(p) - (px(pose[23]) + px(pose[24])) / 2) || 1;
      const x = px(p) + outward * (w / 2 + unit * 4);
      const y = py(p);
      ctx.fillStyle = 'rgba(11, 15, 20, 0.8)';
      ctx.beginPath();
      ctx.roundRect(x - w / 2, y - h / 2, w, h, h / 2);
      ctx.fill();
      ctx.fillStyle = COLORS[side];
      ctx.fillText(text, x, y + size * 0.05);
    }
  }
}

// ---------------------------------------------------------------- UI

const angleCells = {};
for (const joint of JOINTS) {
  const row = el.angleRows.insertRow();
  row.insertCell().textContent = joint.label;
  for (const side of ['left', 'right']) {
    const cell = row.insertCell();
    cell.className = side[0];
    cell.textContent = '–';
    angleCells[`${side}_${joint.key}`] = cell;
  }
}

let lastReadout = 0;
function updateReadouts(tracking) {
  const now = performance.now();
  if (now - lastReadout < 120) return; // text does not need to update at 30 fps
  lastReadout = now;
  setStatus(tracking ? 'Tracking' : 'No body in view');
  el.stats.textContent = `${Math.round(state.fps)} fps · ${Math.round(state.inferMs)} ms · ${state.delegate}`;
  for (const [key, cell] of Object.entries(angleCells)) {
    const a = state.angles?.[key];
    cell.textContent = a == null ? '–' : `${Math.round(a)}°`;
  }
  if (recorder.active) el.recTime.textContent = `● ${formatDuration(performance.now() - recorder.startedAt)}`;
}

function setStatus(text) {
  if (el.status.textContent !== text) el.status.textContent = text;
}

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function syncUi() {
  const ready = Boolean(state.pose);
  const active = Boolean(state.source);
  el.introStart.disabled = el.introFile.disabled = el.btnCamera.disabled = !ready;
  el.btnCamera.classList.toggle('on', state.source?.kind === 'camera');
  el.btnFlip.disabled = state.source?.kind !== 'camera';
  el.btnRecord.disabled = !active;
  el.btnRecord.classList.toggle('on', recorder.active);
  el.recTime.hidden = !recorder.active;
  el.btnAngles.classList.toggle('on', settings.angles);
  el.angles.hidden = !(settings.angles && active);
}

function startRecording() {
  recorder.start({
    model: `pose_landmarker_${settings.model}`,
    source: state.source.kind,
    handsTracked: settings.hands,
  });
  el.recTime.textContent = '● 0:00';
  syncUi();
}

function stopRecording() {
  recorder.stop();
  syncUi();
  if (!recorder.frames.length) return;
  el.exportSummary.textContent =
    `${formatDuration(recorder.durationMs)} of movement, ${recorder.frames.length} frames. ` +
    'The data stays on this device until you download it.';
  el.exportDlg.showModal();
}

async function run(action) {
  try {
    await action();
  } catch (err) {
    console.error(err);
    const denied = err?.name === 'NotAllowedError';
    stopSource();
    showIntro(denied ? 'Camera access was blocked. Allow it in your browser settings and try again.' : err.message || String(err));
  }
}

const toggleCamera = () =>
  run(async () => {
    if (state.source?.kind === 'camera') {
      stopSource();
      showIntro();
    } else {
      await startCamera();
    }
  });

el.introStart.onclick = toggleCamera;
el.btnCamera.onclick = toggleCamera;
el.btnFlip.onclick = () => {
  settings.facing = settings.facing === 'user' ? 'environment' : 'user';
  saveSettings();
  run(startCamera);
};
el.btnRecord.onclick = () => (recorder.active ? stopRecording() : startRecording());
el.btnAngles.onclick = () => {
  settings.angles = !settings.angles;
  saveSettings();
  syncUi();
};
el.btnSettings.onclick = () => el.settings.showModal();
el.introFile.onclick = el.btnFile.onclick = () => el.file.click();
el.file.onchange = () => {
  const file = el.file.files[0];
  el.file.value = '';
  if (!file) return;
  el.settings.close();
  run(() => startFile(file));
};

el.optModel.value = settings.model;
el.optHands.checked = settings.hands;
el.optLabels.checked = settings.labels;
el.optModel.onchange = () => {
  settings.model = el.optModel.value;
  saveSettings();
  run(loadPose);
};
el.optHands.onchange = () => {
  settings.hands = el.optHands.checked;
  saveSettings();
  run(loadHands);
};
el.optLabels.onchange = () => {
  settings.labels = el.optLabels.checked;
  saveSettings();
};

const stamp = () => new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
el.exportCsv.onclick = () => download(`body-tracker-${stamp()}.csv`, recorder.toCSV(), 'text/csv');
el.exportJson.onclick = () => download(`body-tracker-${stamp()}.json`, recorder.toJSON(), 'application/json');

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.source) requestWakeLock();
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register(new URL('../sw.js', import.meta.url)).catch((err) => console.warn('Offline mode unavailable', err));
}

syncUi();
run(async () => {
  await loadPose();
  await loadHands();
  setStatus('Ready');
  syncUi();
});
