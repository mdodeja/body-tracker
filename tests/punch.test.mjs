import test from 'node:test';
import assert from 'node:assert/strict';
import { PunchTracker } from '../js/punch.js';

// A 1.80 m person drawn at 300 px per metre, standing on a floor at y = 900, facing +x.
const SCALE = 300;
const HEIGHT_M = 1.8;
const FLOOR = 900;
const STRAIGHT = { left_knee: 175, right_knee: 175, left_hip: 172, right_hip: 172 };

/** reach: how far each fist is in front of its shoulder, in metres. shift: whole picture, px. */
function pose({ left = 0.15, right = 0.15, shift = 0 } = {}) {
  const pts = Array.from({ length: 33 }, () => ({ x: 400 + shift, y: 0, visibility: 0.95 }));
  const at = (i, forwardM, heightM) => Object.assign(pts[i], { x: 400 + shift + forwardM * SCALE, y: FLOOR - heightM * SCALE });
  at(2, 0, HEIGHT_M * 0.936); at(5, 0, HEIGHT_M * 0.936);
  at(11, 0, 1.45); at(12, 0, 1.45);
  at(15, left, 1.45); at(16, right, 1.45);
  at(23, 0, 0.95); at(24, 0, 0.95);
  at(27, 0, 0.08); at(28, 0, 0.08);
  at(29, -0.05, 0); at(30, -0.05, 0); at(31, 0.15, 0); at(32, 0.15, 0);
  return pts;
}

function ready(tracker, dt) {
  let t = 0;
  for (; t < 1500; t += dt) tracker.update(t, pose(), null, STRAIGHT);
  assert.equal(tracker.phase, 'ready');
  assert.ok(Math.abs(tracker.scale - SCALE) < 1, `scale ${tracker.scale}`);
  return t;
}

/** Fist position through a punch: out from 0.15 m to 0.70 m with a smooth speed profile peaking at peakMps. */
function punchReach(ms, peakMps) {
  const durationMs = ((0.55 * Math.PI) / (2 * peakMps)) * 1000; // distance = peak · T · 2/π
  const u = Math.min(1, Math.max(0, ms / durationMs));
  return 0.15 + 0.55 * (1 - Math.cos(Math.PI * u)) / 2;
}

function run(tracker, t0, dt, durationMs, poseAt) {
  const events = [];
  let t = t0;
  for (; t < t0 + durationMs; t += dt) {
    const out = tracker.update(t, poseAt(t - t0), null, null);
    if (out.event) events.push(out);
  }
  return { events, t };
}

test('goes searching -> steady -> ready on standing still', () => {
  const tracker = new PunchTracker({ heightM: HEIGHT_M });
  assert.equal(tracker.update(0, null).phase, 'searching');
  assert.equal(tracker.update(33, pose(), null, STRAIGHT).phase, 'steady');
  let event;
  for (let t = 66; t < 1500; t += 33) event = tracker.update(t, pose(), null, STRAIGHT).event ?? event;
  assert.equal(event, 'calibrated');
});

test('measures the peak speed of a punch, and which hand threw it', () => {
  for (const [fps, peakMps, tolerance] of [[30, 6, 0.3], [60, 6, 0.12], [60, 10, 0.2], [120, 10, 0.08]]) {
    const dt = 1000 / fps;
    const tracker = new PunchTracker({ heightM: HEIGHT_M });
    const t0 = ready(tracker, dt);
    const { events } = run(tracker, t0, dt, 800, (ms) => pose({ right: punchReach(ms, peakMps) }));
    assert.equal(events.length, 1, `${fps} fps: ${events.map((e) => e.event)}`);
    const { result } = events[0];
    assert.equal(result.hand, 'right');
    // Frames average the speed over their interval, so the reading can only fall short of the true peak.
    assert.ok(result.peakMps <= peakMps * 1.02 && result.peakMps >= peakMps * (1 - tolerance), `${fps} fps, ${peakMps} m/s: read ${result.peakMps}`);
    assert.ok(Math.abs(result.extensionM - 0.55) < 0.05, `extension ${result.extensionM}`);
  }
});

test('pulling the hand back is not a punch', () => {
  const tracker = new PunchTracker({ heightM: HEIGHT_M });
  const dt = 1000 / 60;
  let t = ready(tracker, dt);
  const out = run(tracker, t, dt, 600, (ms) => pose({ left: punchReach(ms, 7) }));
  assert.equal(out.events.length, 1);
  assert.equal(out.events[0].result.hand, 'left');
  // Hold it out, then snap it back just as fast.
  t = run(tracker, out.t, dt, 300, () => pose({ left: 0.7 })).t;
  const back = run(tracker, t, dt, 600, (ms) => pose({ left: 0.85 - punchReach(ms, 7) }));
  assert.equal(back.events.length, 0);
});

test('slow reaching and camera shake are not punches', () => {
  const tracker = new PunchTracker({ heightM: HEIGHT_M });
  const dt = 1000 / 30;
  let t = ready(tracker, dt);
  // Reaching out over a full second: about 0.9 m/s at most.
  const slow = run(tracker, t, dt, 1500, (ms) => pose({ right: punchReach(ms, 0.9) }));
  assert.equal(slow.events.length, 0);
  // The whole picture lurches 150 px and back: fast, but the arm does not extend.
  const shake = run(tracker, slow.t, dt, 1000, (ms) => pose({ right: 0.7, shift: ms < 200 ? 150 * Math.sin((Math.PI * ms) / 200) : 0 }));
  assert.equal(shake.events.length, 0);
});

test('a dropped stretch of frames does not produce a bogus speed', () => {
  const tracker = new PunchTracker({ heightM: HEIGHT_M });
  let t = ready(tracker, 33);
  tracker.update(t, pose({ right: 0.15 }));
  // Nothing for half a second, then the arm is suddenly out.
  const out = tracker.update(t + 500, pose({ right: 0.7 }));
  assert.equal(out.event, undefined);
  assert.equal(run(tracker, t + 533, 33, 500, () => pose({ right: 0.7 })).events.length, 0);
});

test('interrupt() forgets a punch in progress', () => {
  const tracker = new PunchTracker({ heightM: HEIGHT_M });
  const dt = 1000 / 60;
  const t = ready(tracker, dt);
  run(tracker, t, dt, 50, (ms) => pose({ right: punchReach(ms, 8) }));
  assert.equal(tracker.phase, 'punching');
  tracker.interrupt();
  const rest = run(tracker, t + 50, dt, 600, () => pose({ right: 0.7 }));
  assert.equal(rest.events.length, 0);
});
