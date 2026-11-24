import test from 'node:test';
import assert from 'node:assert/strict';
import { JumpTracker, formatHeight, formatDistance, G } from '../js/jump.js';

// A 1.80 m person drawn at 400 px per metre, standing on a floor at y = 900.
const SCALE = 400;
const HEIGHT_M = 1.8;
const FLOOR = 900;
const FPS = 30;

/** Stick figure with feet at (x, FLOOR - lift) — lift and x in pixels. */
function pose(x, lift = 0, { tuck = 0, squat = 0 } = {}) {
  const pts = Array.from({ length: 33 }, () => ({ x, y: 0, visibility: 0.95 }));
  const at = (i, dx, heightM) => Object.assign(pts[i], { x: x + dx, y: FLOOR - lift - heightM * SCALE });
  at(2, 0, HEIGHT_M * 0.936 - squat); at(5, 0, HEIGHT_M * 0.936 - squat);
  at(23, 0, 0.95 - squat); at(24, 0, 0.95 - squat);
  at(25, 0, 0.5 + tuck); at(26, 0, 0.5 + tuck);
  at(27, 0, 0.08 + tuck); at(28, 0, 0.08 + tuck);
  at(29, -20, tuck); at(30, -20, tuck); // heels
  at(31, 60, tuck); at(32, 60, tuck); // toes point toward +x
  return pts;
}

const STRAIGHT = { left_knee: 175, right_knee: 175, left_hip: 172, right_hip: 172 };

/** Stand still, then follow a ballistic arc. Returns the tracker's result event (or undefined). */
function simulate(tracker, { riseM, distanceM = 0, fps = FPS, standMs = 1500 }) {
  const flightS = Math.sqrt((8 * riseM) / G);
  const dt = 1000 / fps;
  const events = [];
  let t = 0;
  for (; t < standMs; t += dt) events.push(tracker.update(t, pose(500), null, STRAIGHT));
  const t0 = t - dt / 2; // feet leave the floor between two frames
  for (; ; t += dt) {
    const s = (t - t0) / 1000;
    const done = s >= flightS;
    const lift = done ? 0 : (0.5 * G * s * (flightS - s)) * SCALE;
    const x = 500 + Math.min(1, s / flightS) * distanceM * SCALE;
    events.push(tracker.update(t, pose(x, lift), null, done ? STRAIGHT : null));
    if (done && t - t0 > flightS * 1000 + 300) break;
  }
  return { events, result: events.find((e) => e.event === 'result')?.result, flightS };
}

test('goes searching -> steady -> ready and calibrates scale from height', () => {
  const tracker = new JumpTracker({ heightM: HEIGHT_M });
  assert.equal(tracker.update(0, null).phase, 'searching');
  assert.equal(tracker.update(33, pose(500), null, STRAIGHT).phase, 'steady');
  let event;
  for (let t = 66; t < 1500; t += 33) event = tracker.update(t, pose(500), null, STRAIGHT).event ?? event;
  assert.equal(event, 'calibrated');
  assert.equal(tracker.phase, 'ready');
  assert.ok(Math.abs(tracker.cal.scale - SCALE) < 1, `scale ${tracker.cal.scale}`);
  assert.equal(tracker.cal.approximate, false);
});

test('does not calibrate while crouched or moving', () => {
  const crouched = new JumpTracker({ heightM: HEIGHT_M });
  for (let t = 0; t < 2000; t += 33) crouched.update(t, pose(500), null, { ...STRAIGHT, left_knee: 100, right_knee: 100 });
  assert.equal(crouched.phase, 'steady');
  const walking = new JumpTracker({ heightM: HEIGHT_M });
  for (let t = 0; t < 2000; t += 33) walking.update(t, pose(300 + t / 5), null, STRAIGHT);
  assert.equal(walking.phase, 'steady');
});

test('measures a vertical jump', () => {
  for (const riseM of [0.25, 0.45, 0.7]) {
    const { result, flightS, events } = simulate(new JumpTracker({ heightM: HEIGHT_M }), { riseM });
    assert.ok(result, 'a result is reported');
    assert.equal(events.filter((e) => e.event === 'takeoff').length, 1);
    assert.ok(Math.abs(result.riseM - riseM) < 0.02, `rise ${result.riseM} vs ${riseM}`);
    assert.ok(Math.abs(result.flightMs - flightS * 1000) < 40, `flight ${result.flightMs} vs ${flightS * 1000}`);
    assert.ok(Math.abs(result.flightHeightM - riseM) < 0.08, `flight-time height ${result.flightHeightM}`);
    assert.ok(result.distanceM < 0.05);
    // The recorded arc rises to a single peak near the middle of the flight.
    assert.ok(result.path.length >= 6, `path has ${result.path.length} points`);
    const top = Math.max(...result.path.map((p) => p.riseM));
    assert.ok(Math.abs(top - riseM) < 0.02, `arc peak ${top}`);
    assert.ok(Math.abs(result.peakMs - result.flightMs / 2) < 60, `peak at ${result.peakMs} of ${result.flightMs}`);
    assert.ok(result.path.at(-1).riseM < top / 2 && result.path[0].riseM < top / 2);
    assert.equal(result.pathPx.length, result.path.length);
  }
});

test('reads the dip and push before a countermovement jump', () => {
  const tracker = new JumpTracker({ heightM: HEIGHT_M });
  const dt = 1000 / FPS;
  let t = 0;
  for (; t < 1500; t += dt) tracker.update(t, pose(500), null, STRAIGHT);
  // Dip 30 cm over 0.4 s, push back up over 0.25 s, then leave the floor.
  const t1 = t;
  for (; t < t1 + 400; t += dt) tracker.update(t, pose(500, 0, { squat: 0.3 * ((t - t1) / 400) }));
  const t2 = t;
  for (; t < t2 + 250; t += dt) tracker.update(t, pose(500, 0, { squat: 0.3 * (1 - (t - t2) / 250) }));
  const flightS = 0.5;
  const t3 = t - dt / 2;
  let result;
  for (; !result && t < t3 + 2000; t += dt) {
    const s = Math.min((t - t3) / 1000, flightS);
    result = tracker.update(t, pose(500, 0.5 * G * s * (flightS - s) * SCALE)).result;
  }
  assert.ok(result, 'jump measured');
  assert.ok(Math.abs(result.dipM - 0.3) < 0.03, `dip ${result.dipM}`);
  assert.ok(Math.abs(result.concentricMs - 250) < 60, `push ${result.concentricMs}`);
  assert.ok(Math.abs(result.timeToTakeoffMs - 650) < 80, `time to take-off ${result.timeToTakeoffMs}`);
  assert.ok(Math.abs(result.takeoffMps - (G * flightS) / 2) < 0.25, `take-off speed ${result.takeoffMps}`);
});

test('reports no dip for a jump straight from standing', () => {
  const { result } = simulate(new JumpTracker({ heightM: HEIGHT_M }), { riseM: 0.4 });
  assert.equal(result.dipM, null);
  assert.equal(result.concentricMs, null);
  assert.ok(result.takeoffMps > 2.5 && result.takeoffMps < 3.1, `take-off speed ${result.takeoffMps}`);
});

test('measures a long jump from take-off toe to landing heel', () => {
  const distanceM = 2.4; // how far the body travels
  const { result } = simulate(new JumpTracker({ heightM: HEIGHT_M }), { riseM: 0.4, distanceM });
  // Toes start 60 px ahead of the body and heels land 20 px behind it.
  const expected = distanceM - 80 / SCALE;
  assert.ok(Math.abs(result.distanceM - expected) < 0.03, `distance ${result.distanceM} vs ${expected}`);
  assert.ok(result.marks.landingX > result.marks.takeoffX);
});

test('works in either direction and at 60 fps', () => {
  const tracker = new JumpTracker({ heightM: HEIGHT_M });
  const { result } = simulate(tracker, { riseM: 0.5, distanceM: -2, fps: 60 });
  // Jumping toward -x: heels (at -20) lead at take-off, toes (at +60) trail at landing.
  assert.ok(Math.abs(result.distanceM - (2 - 80 / SCALE)) < 0.03, `distance ${result.distanceM}`);
  assert.ok(Math.abs(result.riseM - 0.5) < 0.02);
});

test('ignores steps and tiny hops, and keeps measuring afterwards', () => {
  const tracker = new JumpTracker({ heightM: HEIGHT_M });
  const hop = simulate(tracker, { riseM: 0.03 }); // ~0.16 s in the air
  assert.equal(hop.result, undefined);
  let t = tracker.lastT;
  for (let i = 0; i < 40; i++) tracker.update((t += 33), pose(500), null, STRAIGHT);
  assert.equal(tracker.phase, 'ready');
});

test('detects landing on ground that sits higher in the picture', () => {
  const tracker = new JumpTracker({ heightM: HEIGHT_M });
  let t = 0;
  for (; t < 1500; t += 33) tracker.update(t, pose(500), null, STRAIGHT);
  const flightS = 0.6;
  const t0 = t;
  let result;
  for (; t < t0 + 1500 && !result; t += 33) {
    const s = Math.min((t - t0) / 1000, flightS);
    // Lands 40 px above the take-off floor line and stays there.
    const lift = Math.max(40, 0.5 * G * s * (flightS - s) * SCALE + (40 * s) / flightS);
    result = tracker.update(t, pose(500 + s * 800, lift)).result;
  }
  assert.ok(result, 'landing detected');
  assert.ok(result.flightMs > 400 && result.flightMs < 800, `flight ${result.flightMs}`);
});

test('falls back to an approximate scale without a height', () => {
  const tracker = new JumpTracker();
  const world = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0 }));
  world[2].y = world[5].y = -0.8;
  for (const i of [29, 30, 31, 32]) world[i].y = 0.9;
  for (let t = 0; t < 1500; t += 33) tracker.update(t, pose(500), world, STRAIGHT);
  assert.equal(tracker.cal.approximate, true);
  assert.ok(Math.abs(tracker.cal.scale - (HEIGHT_M * 0.936 * SCALE) / 1.7) < 1);
});

test('restarts cleanly when time jumps backwards', () => {
  const tracker = new JumpTracker({ heightM: HEIGHT_M });
  for (let t = 0; t < 1500; t += 33) tracker.update(t, pose(500), null, STRAIGHT);
  assert.equal(tracker.phase, 'ready');
  assert.equal(tracker.update(0, pose(500), null, STRAIGHT).phase, 'steady');
});

test('formats heights and distances', () => {
  assert.equal(formatHeight(0.523), '52 cm');
  assert.equal(formatHeight(0.523, 'imperial'), '20.6 in');
  assert.equal(formatHeight(0.5, 'metric', true), '50 centimetres');
  assert.equal(formatDistance(2.314), '2.31 m');
  assert.equal(formatDistance(2.314, 'imperial'), '7 ft 7 in');
  assert.equal(formatDistance(1.8288, 'imperial', true), '6 feet 0 inches');
});
