// Regression tests on pose streams captured from the app itself (not hand-built poses):
// what the pose model really outputs, jitter and all.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JumpTracker } from '../js/jump.js';

function replay(name) {
  const rec = JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
  const { width, height } = rec.frame;
  const tracker = new JumpTracker({ heightM: rec.heightCm / 100 });
  const events = [];
  for (const f of rec.frames) {
    const px = f.landmarks?.map(([x, y, , visibility]) => ({ x: x * width, y: y * height, visibility })) ?? null;
    const out = tracker.update(f.t, px, null, f.angles);
    if (out.event) events.push(out);
  }
  return events;
}

test('captured footage: three jumps in a row are all measured', () => {
  const results = replay('three-jumps').filter((e) => e.event === 'result').map((e) => e.result);
  assert.equal(results.length, 3);
  for (const r of results) {
    assert.ok(Math.abs(r.riseM - 0.306) < 0.03, `rise ${r.riseM}`);
    assert.ok(Math.abs(r.flightMs - 500) < 40, `air ${r.flightMs}`);
  }
});

test('captured footage: a knocked, wobbled and tilted camera gives no jumps', () => {
  const events = replay('camera-shake');
  assert.equal(events.filter((e) => e.event === 'result').length, 0);
  assert.ok(events.some((e) => e.event === 'rejected'), 'the shake was noticed and thrown out');
});
