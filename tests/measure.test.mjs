import test from 'node:test';
import assert from 'node:assert/strict';
import { DistanceTracker, SprintTracker, formatSpeed } from '../js/measure.js';

// A 1.80 m person drawn at 100 px per metre in a 1600 px wide picture (16 m across).
const SCALE = 100;
const HEIGHT_M = 1.8;
const FLOOR = 800;
const WIDTH = 1600;
const DT = 1000 / 30;
const STRAIGHT = { left_knee: 175, right_knee: 175, left_hip: 172, right_hip: 172 };
const RUNNING = { left_knee: 110, right_knee: 150, left_hip: 140, right_hip: 160 };

function pose(x) {
  const pts = Array.from({ length: 33 }, () => ({ x, y: 0, visibility: 0.95 }));
  const at = (i, dx, heightM) => Object.assign(pts[i], { x: x + dx, y: FLOOR - heightM * SCALE });
  at(2, 0, HEIGHT_M * 0.936); at(5, 0, HEIGHT_M * 0.936);
  at(23, 0, 0.95); at(24, 0, 0.95);
  at(27, 0, 0.08); at(28, 0, 0.08);
  at(29, -5, 0); at(30, -5, 0); at(31, 5, 0); at(32, 5, 0);
  return pts;
}

/** Drive a tracker along x(t) for durationMs; returns every event it reported. */
function drive(tracker, clock, durationMs, xAt, angles = STRAIGHT) {
  const events = [];
  const t0 = clock.t;
  for (; clock.t < t0 + durationMs; clock.t += DT) {
    const out = tracker.update(clock.t, pose(xAt(clock.t - t0)), null, angles, WIDTH);
    if (out.event) events.push(out);
  }
  return events;
}

test('distance: measures between two spots stood on in turn', () => {
  const tracker = new DistanceTracker({ heightM: HEIGHT_M });
  const clock = { t: 0 };
  assert.equal(tracker.update(0, null).phase, 'searching');
  const first = drive(tracker, clock, 1500, () => 400);
  assert.deepEqual(first.map((e) => e.event), ['marked']);
  assert.equal(drive(tracker, clock, 1000, () => 402).length, 0, 'shifting weight is not a move');
  // Walk to a spot 1.48 m from where they last stood (402), then stand.
  const walk = drive(tracker, clock, 1000, (ms) => 402 + 148 * (ms / 1000), RUNNING);
  assert.equal(walk.length, 0);
  const second = drive(tracker, clock, 1500, () => 550);
  assert.equal(second.length, 1);
  assert.equal(second[0].event, 'result');
  assert.ok(Math.abs(second[0].result.distanceM - 1.48) < 0.01, `distance ${second[0].result.distanceM}`);
  // And on to a third spot, measured from the second.
  drive(tracker, clock, 500, (ms) => 550 - 300 * (ms / 500), RUNNING);
  const third = drive(tracker, clock, 1500, () => 250);
  assert.ok(Math.abs(third[0].result.distanceM - 3) < 0.03, `distance ${third[0].result.distanceM}`);
});

test('sprint: places the finish line toward the side with more room', () => {
  const left = new SprintTracker({ heightM: HEIGHT_M, distanceM: 5 });
  const events = drive(left, { t: 0 }, 1500, () => 300);
  assert.deepEqual(events.map((e) => e.event), ['set']);
  assert.equal(left.lines.dir, 1);
  assert.ok(Math.abs(left.lines.finishX - 800) < 2, `finish at ${left.lines.finishX}`);

  const right = new SprintTracker({ heightM: HEIGHT_M, distanceM: 5 });
  drive(right, { t: 0 }, 1500, () => 1300);
  assert.equal(right.lines.dir, -1);
  assert.ok(Math.abs(right.lines.finishX - 800) < 2);
});

test('sprint: reports when the finish line would be out of view', () => {
  const tracker = new SprintTracker({ heightM: HEIGHT_M, distanceM: 14 });
  const events = drive(tracker, { t: 0 }, 1500, () => 300);
  assert.deepEqual(events.map((e) => e.event), ['nofit']);
  // Running anyway must not start the clock.
  const run = drive(tracker, { t: 1500 }, 2000, (ms) => 300 + 600 * (ms / 1000), RUNNING);
  assert.equal(run.length, 0);
});

test('sprint: times a standing start, ignoring a lean-and-wait before setting off', () => {
  const tracker = new SprintTracker({ heightM: HEIGHT_M, distanceM: 5 });
  const clock = { t: 0 };
  drive(tracker, clock, 1500, () => 300);
  // Lean 20 cm forward over half a second and hold it for a second...
  drive(tracker, clock, 500, (ms) => 300 + 20 * (ms / 500), RUNNING);
  drive(tracker, clock, 1000, () => 320, RUNNING);
  // ...then accelerate at 4 m/s² to the finish 4.8 m away: t = sqrt(2 * 4.8 / 4).
  const expectedS = Math.sqrt((2 * 4.8) / 4);
  const events = drive(tracker, clock, 3000, (ms) => 320 + 0.5 * 4 * (ms / 1000) ** 2 * SCALE, RUNNING);
  assert.deepEqual(events.map((e) => e.event), ['start', 'result']);
  const { result } = events[1];
  assert.ok(Math.abs(result.timeMs / 1000 - expectedS) < 0.2, `time ${result.timeMs} vs ${expectedS * 1000}`);
  assert.ok(Math.abs(result.distanceM - 4.8) < 0.15, `distance ${result.distanceM}`);
  assert.ok(result.topMps > result.avgMps);
  assert.ok(Math.abs(result.topMps - 4 * expectedS) < 0.6, `top ${result.topMps} vs ${4 * expectedS}`);
});

test('sprint: times a flying start from line to line', () => {
  const tracker = new SprintTracker({ heightM: HEIGHT_M, distanceM: 5 });
  const clock = { t: 0 };
  drive(tracker, clock, 1500, () => 300);
  // Walk 2 m back behind the line, pause briefly, then run through at a steady 6 m/s.
  drive(tracker, clock, 2000, (ms) => 300 - 200 * (ms / 2000), RUNNING);
  drive(tracker, clock, 1000, () => 100, RUNNING);
  assert.equal(tracker.lines.startX > 295 && tracker.lines.startX < 305, true, 'a short pause does not move the start line');
  const events = drive(tracker, clock, 2000, (ms) => 100 + 600 * (ms / 1000), RUNNING);
  assert.deepEqual(events.map((e) => e.event), ['start', 'result']);
  const { result } = events[1];
  assert.ok(Math.abs(result.timeMs - 5000 / 6) < 25, `time ${result.timeMs}`);
  assert.ok(Math.abs(result.avgMps - 6) < 0.2, `avg ${result.avgMps}`);
  assert.ok(Math.abs(result.topMps - 6) < 0.3, `top ${result.topMps}`);
});

test('sprint: needs a return to the start before timing again, and can be re-marked', () => {
  const tracker = new SprintTracker({ heightM: HEIGHT_M, distanceM: 5 });
  const clock = { t: 0 };
  drive(tracker, clock, 1500, () => 300);
  const first = drive(tracker, clock, 2000, (ms) => 300 + 500 * Math.min(1.2, ms / 1000), RUNNING);
  assert.deepEqual(first.map((e) => e.event), ['start', 'result']);
  // Slowing down beyond the finish must not count as another run.
  assert.equal(drive(tracker, clock, 1500, (ms) => 900 + 20 * (ms / 1500), RUNNING).length, 0);
  // Standing still there for 3 s moves the start line; the finish flips to the other side.
  const remark = drive(tracker, clock, 3500, () => 920);
  assert.deepEqual(remark.map((e) => e.event), ['set']);
  assert.equal(tracker.lines.dir, -1);
  const back = drive(tracker, clock, 2000, (ms) => 920 - 500 * Math.min(1.2, ms / 1000), RUNNING);
  assert.deepEqual(back.map((e) => e.event), ['start', 'result']);
  assert.ok(Math.abs(back[1].result.avgMps - 5) < 0.6, `avg ${back[1].result.avgMps}`);
});

test('formats speed', () => {
  assert.equal(formatSpeed(5), '18.0 km/h');
  assert.equal(formatSpeed(5, 'imperial'), '11.2 mph');
  assert.equal(formatSpeed(10, 'metric', true), '36.0 kilometres per hour');
});
