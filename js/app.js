import { FilesetResolver, PoseLandmarker, HandLandmarker } from '../vendor/tasks-vision/vision_bundle.mjs';
import { JOINTS, computeAngles, smoothAngles, sideOf } from './geometry.js';
import { Recorder, download } from './recorder.js';
import { JumpTracker, formatHeight, formatDistance } from './jump.js';

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
  btnAngles: $('btn-angles'), btnSettings: $('btn-settings'), btnJump: $('btn-jump'),
  jump: $('jump'), jumpChart: $('jump-chart'), jumpMode: $('jump-mode'), jumpStatus: $('jump-status'), jumpValue: $('jump-value'), jumpDetail: $('jump-detail'),
  jumpDlg: $('jump-dlg'), optJump: $('opt-jump'), optUnits: $('opt-units'), optSpeak: $('opt-speak'),
  optHeightCm: $('opt-height-cm'), optHeightFt: $('opt-height-ft'), optHeightIn: $('opt-height-in'),
  jumpHowto: $('jump-howto'), jumpHistory: $('jump-history'), jumpList: $('jump-list'), jumpClear: $('jump-clear'),
  settings: $('settings'), optModel: $('opt-model'), optHands: $('opt-hands'), optLabels: $('opt-labels'),
  btnFile: $('btn-file'), file: $('file'),
  exportDlg: $('export'), exportSummary: $('export-summary'), exportCsv: $('export-csv'), exportJson: $('export-json'),
};
const ctx = el.view.getContext('2d');

const settings = Object.assign(
  {
    model: 'lite', hands: false, labels: true, angles: true, facing: 'user',
    jumpMode: 'off', heightCm: null, speak: true,
    units: /^en-(US|LR|MM)$/.test(navigator.language) ? 'imperial' : 'metric',
  },
  JSON.parse(localStorage.getItem('body-tracker-settings') || '{}'),
);
const saveSettings = () => localStorage.setItem('body-tracker-settings', JSON.stringify(settings));

const recorder = new Recorder();
const jumpTracker = new JumpTracker({ heightM: settings.heightCm ? settings.heightCm / 100 : null });
let jumpHistory = JSON.parse(localStorage.getItem('body-tracker-jumps') || '[]');
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
  jumpPhase: 'searching',
  lastJump: null, // most recent jump result, drawn over the video until the next take-off
  jumpTracker,
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
  state.lastJump = null;
  jumpTracker.reset();
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

  if (settings.jumpMode !== 'off') {
    // For a video file use the video's own clock, so slow processing does not stretch time.
    const jumpTime = src.kind === 'video' ? frame.currentTime * 1000 : now;
    const pixels = landmarks?.map((p) => ({ x: p.x * width, y: p.y * height, visibility: p.visibility })) ?? null;
    onJumpUpdate(jumpTracker.update(jumpTime, pixels, world, rawAngles));
  }

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
  if (settings.jumpMode !== 'off') drawJump(width, mirror, unit);
}

/** Floor line while armed, plus the last jump's measurement drawn where it happened. */
function drawJump(width, mirror, unit) {
  const cal = jumpTracker.cal;
  if (!cal) return;
  const mx = (x) => (mirror ? width - x : x);
  ctx.lineWidth = unit * 0.7;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
  ctx.setLineDash([unit * 3, unit * 3]);
  ctx.beginPath();
  ctx.moveTo(0, cal.ground);
  ctx.lineTo(width, cal.ground);
  ctx.stroke();
  ctx.setLineDash([]);

  const marks = state.lastJump?.marks;
  if (!marks) return;

  // The path the hips took through the air.
  const path = state.lastJump.pathPx;
  ctx.strokeStyle = '#4f8cff';
  ctx.lineWidth = unit * 1.2;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  path.forEach((p, i) => (i ? ctx.lineTo(mx(p.x), p.y) : ctx.moveTo(mx(p.x), p.y)));
  ctx.stroke();

  ctx.strokeStyle = '#facc15';
  ctx.lineWidth = unit * 1.4;
  ctx.beginPath();
  if (settings.jumpMode === 'long') {
    const tick = unit * 5;
    for (const x of [marks.takeoffX, marks.landingX]) {
      ctx.moveTo(mx(x), marks.groundY - tick);
      ctx.lineTo(mx(x), marks.groundY + tick);
    }
    ctx.moveTo(mx(marks.takeoffX), marks.groundY);
    ctx.lineTo(mx(marks.landingX), marks.groundY);
  } else {
    const x = mx(marks.peakX);
    const tick = unit * 8;
    for (const y of [marks.standingHipY, marks.peakY]) {
      ctx.moveTo(x - tick, y);
      ctx.lineTo(x + tick, y);
    }
    ctx.moveTo(x, marks.standingHipY);
    ctx.lineTo(x, marks.peakY);
  }
  ctx.stroke();
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

// ---------------------------------------------------------------- jump measurement

const JUMP_TEXT = {
  high: {
    title: 'High jump',
    howto: 'Prop the phone up so your whole body is in view with room above your head. Stand up straight and still for a second, then jump as high as you can.',
  },
  long: {
    title: 'Long jump',
    howto: 'Prop the phone up side-on, so you jump across the screen and both take-off and landing are in view. Stand up straight and still at the take-off spot for a second, then jump — or walk back first for a run-up.',
  },
};
const JUMP_STATUS = {
  searching: 'Step back until your whole body is in view',
  steady: 'Stand up straight and hold still',
  ready: 'Ready — jump!',
  air: 'In the air…',
};

const jumpValue = (jump, mode = jump.mode) => (mode === 'long' ? jump.distanceM : jump.riseM);
const formatJump = (jump, spoken = false, mode = jump.mode) =>
  (mode === 'long' ? formatDistance : formatHeight)(jumpValue(jump, mode), settings.units, spoken);

function say(text) {
  if (!settings.speak || !window.speechSynthesis) return;
  speechSynthesis.cancel();
  speechSynthesis.speak(new SpeechSynthesisUtterance(text));
}

function onJumpUpdate({ phase, event, result }) {
  state.jumpPhase = phase;
  if (event === 'calibrated') say('Ready');
  if (event === 'takeoff') state.lastJump = null;
  if (event === 'result') {
    const jump = {
      at: new Date().toISOString(),
      mode: settings.jumpMode,
      riseM: result.riseM,
      distanceM: result.distanceM,
      flightMs: Math.round(result.flightMs),
      flightHeightM: result.flightHeightM,
      approximate: result.approximate,
    };
    state.lastJump = { ...jump, marks: result.marks, peakMs: result.peakMs, path: result.path, pathPx: result.pathPx };
    jumpHistory = [jump, ...jumpHistory].slice(0, 100);
    localStorage.setItem('body-tracker-jumps', JSON.stringify(jumpHistory));
    say(formatJump(jump, true));
  }
  renderJumpPanel();
}

function renderJumpPanel() {
  const mode = settings.jumpMode;
  const show = mode !== 'off' && Boolean(state.source);
  el.jump.hidden = !show;
  if (!show) return;
  const phase = state.jumpPhase;
  el.jump.className = phase;
  el.jumpMode.textContent = JUMP_TEXT[mode].title;
  el.jumpStatus.textContent = JUMP_STATUS[phase];

  const last = state.lastJump;
  el.jumpValue.textContent = last ? formatJump(last, false, mode) : '';
  if (el.jumpChart.jump !== last) {
    el.jumpChart.jump = last;
    el.jumpChart.toggleAttribute('hidden', !last); // SVG elements have no .hidden property
    if (last) renderJumpChart(last, mode);
  }
  const past = jumpHistory.filter((j) => j.mode === mode);
  const details = [];
  if (last) details.push(`${(last.flightMs / 1000).toFixed(2)} s in the air`);
  if (past.length) {
    const best = past.reduce((a, b) => (jumpValue(b) > jumpValue(a) ? b : a));
    details.push(`best ${formatJump(best)}`);
  }
  if (!settings.heightCm) details.push('estimate — enter your height for accuracy');
  el.jumpDetail.textContent = details.join(' · ');
}

/**
 * The jump's arc: height of the hips above standing, against time (high jump) or against
 * distance travelled (long jump). One series, so no legend; the peak is labelled directly.
 */
function renderJumpChart(jump, mode) {
  const W = 320, H = 104, left = 10, right = 10, top = 22, bottom = 18;
  const xOf = (p) => (mode === 'long' ? p.xM : p.tMs);
  const xs = jump.path.map(xOf);
  const x0 = Math.min(...xs);
  const xSpan = Math.max(...xs) - x0 || 1;
  const peak = jump.path.reduce((a, b) => (b.riseM > a.riseM ? b : a));
  const yMax = Math.max(peak.riseM, 0.01);
  const sx = (p) => left + ((xOf(p) - x0) / xSpan) * (W - left - right);
  const sy = (p) => H - bottom - (Math.max(0, p.riseM) / yMax) * (H - top - bottom);
  const points = jump.path.map((p) => `${sx(p).toFixed(1)},${sy(p).toFixed(1)}`).join(' ');
  const px = sx(peak);
  const anchor = px < 70 ? 'start' : px > W - 70 ? 'end' : 'middle';
  const peakLabel = `peak ${formatHeight(peak.riseM, settings.units)} at ${(jump.peakMs / 1000).toFixed(2)} s`;
  const base = H - bottom;
  el.jumpChart.setAttribute('aria-label', `Arc of the jump: ${peakLabel}, ${(jump.flightMs / 1000).toFixed(2)} seconds in the air`);
  el.jumpChart.innerHTML = `
    <line class="axis" x1="${left}" y1="${base}" x2="${W - right}" y2="${base}"/>
    <line class="drop" x1="${px}" y1="${sy(peak)}" x2="${px}" y2="${base}"/>
    <polyline class="arc" points="${points}"/>
    <circle class="peak" cx="${px}" cy="${sy(peak)}" r="4"/>
    <text class="value" x="${px}" y="${sy(peak) - 9}" text-anchor="${anchor}">${peakLabel}</text>
    <text x="${left}" y="${H - 4}">take-off</text>
    <text x="${W - right}" y="${H - 4}" text-anchor="end">landing</text>`;
}

function renderJumpDialog() {
  const mode = el.optJump.value;
  const imperial = el.optUnits.value === 'imperial';
  el.optHeightCm.hidden = imperial;
  el.optHeightFt.hidden = el.optHeightIn.hidden = !imperial;
  $('height-label').textContent = imperial ? 'Your height (ft, in)' : 'Your height (cm)';
  el.jumpHowto.textContent = JUMP_TEXT[mode]?.howto ?? '';
  el.jumpHowto.hidden = mode === 'off';

  el.jumpHistory.hidden = !jumpHistory.length;
  el.jumpList.replaceChildren(
    ...jumpHistory.slice(0, 20).map((jump) => {
      const li = document.createElement('li');
      const value = document.createElement('span');
      value.textContent = `${JUMP_TEXT[jump.mode].title} · ${formatJump(jump)}${jump.approximate ? ' (est.)' : ''}`;
      const when = document.createElement('span');
      when.textContent = new Date(jump.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      li.append(value, when);
      return li;
    }),
  );
}

function showHeight() {
  const cm = settings.heightCm;
  el.optHeightCm.value = cm ? Math.round(cm) : '';
  const inches = cm ? Math.round(cm / 2.54) : null;
  el.optHeightFt.value = inches ? Math.floor(inches / 12) : '';
  el.optHeightIn.value = inches ? inches % 12 : '';
}

function readHeight() {
  const cm =
    el.optUnits.value === 'imperial'
      ? (Number(el.optHeightFt.value) * 12 + Number(el.optHeightIn.value)) * 2.54
      : Number(el.optHeightCm.value);
  const valid = cm >= 80 && cm <= 250 ? cm : null;
  if (valid === settings.heightCm) return;
  settings.heightCm = valid;
  jumpTracker.setHeight(valid ? valid / 100 : null);
  state.lastJump = null;
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
  el.btnJump.classList.toggle('on', settings.jumpMode !== 'off');
  renderJumpPanel();
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

el.btnJump.onclick = () => {
  el.optJump.value = settings.jumpMode;
  el.optUnits.value = settings.units;
  el.optSpeak.checked = settings.speak;
  showHeight();
  renderJumpDialog();
  el.jumpDlg.showModal();
};
el.optJump.onchange = renderJumpDialog;
el.optUnits.onchange = () => {
  readHeight(); // keep what was typed, in the units it was typed in
  settings.units = el.optUnits.value;
  showHeight();
  renderJumpDialog();
};
el.jumpClear.onclick = () => {
  jumpHistory = [];
  localStorage.removeItem('body-tracker-jumps');
  renderJumpDialog();
};
el.jumpDlg.onclose = () => {
  readHeight();
  if (settings.jumpMode !== el.optJump.value) {
    settings.jumpMode = el.optJump.value;
    state.lastJump = null;
    jumpTracker.reset();
    state.jumpPhase = 'searching';
  }
  settings.units = el.optUnits.value;
  settings.speak = el.optSpeak.checked;
  saveSettings();
  // Phones only allow speech after a tap; this tap unlocks it for the results to come.
  if (settings.speak && settings.jumpMode !== 'off') say(JUMP_TEXT[settings.jumpMode].title);
  syncUi();
};
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
