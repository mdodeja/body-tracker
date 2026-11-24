import test from 'node:test';
import assert from 'node:assert/strict';
import { angleDeg, computeAngles, smoothAngles, sideOf, LANDMARK_NAMES, ANGLE_KEYS } from '../js/geometry.js';
import { Recorder } from '../js/recorder.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);

test('angleDeg handles straight, right and 3D angles', () => {
  near(angleDeg({ x: -1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }), 180);
  near(angleDeg({ x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }), 90);
  near(angleDeg({ x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 5 }), 90);
  near(angleDeg({ x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 0 }), 45);
  assert.ok(Number.isNaN(angleDeg({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 })));
});

test('sideOf follows the landmark names', () => {
  LANDMARK_NAMES.forEach((name, i) => {
    const expected = name.startsWith('left') || name.endsWith('_left') ? 'left'
      : name.startsWith('right') || name.endsWith('_right') ? 'right' : 'center';
    assert.equal(sideOf(i), expected, name);
  });
});

function standingPose() {
  const world = LANDMARK_NAMES.map(() => ({ x: 0, y: 0, z: 0, visibility: 1 }));
  const set = (i, x, y, z = 0) => Object.assign(world[i], { x, y, z });
  // Left arm: upper arm hangs down, forearm points forward (elbow at 90 degrees).
  set(11, 0.2, -0.5); set(13, 0.2, -0.2); set(15, 0.2, -0.2, -0.3);
  // Left leg straight.
  set(23, 0.1, 0); set(25, 0.1, 0.4); set(27, 0.1, 0.8);
  return world;
}

test('computeAngles measures joints and hides low-visibility ones', () => {
  const world = standingPose();
  const angles = computeAngles(world);
  assert.deepEqual(Object.keys(angles).sort(), [...ANGLE_KEYS].sort());
  near(angles.left_elbow, 90);
  near(angles.left_knee, 180);
  world[27].visibility = 0.1;
  const hidden = computeAngles(world);
  assert.equal(hidden.left_knee, null);
  near(hidden.left_elbow, 90);
  assert.equal(computeAngles(undefined).left_elbow, null);
});

test('smoothAngles eases toward new values and resets across gaps', () => {
  assert.deepEqual(smoothAngles(null, { a: 10, b: null }), { a: 10, b: null });
  assert.deepEqual(smoothAngles({ a: 10, b: 5 }, { a: 20, b: null }, 0.5), { a: 15, b: null });
  assert.deepEqual(smoothAngles({ a: null }, { a: 30 }, 0.5), { a: 30 });
});

test('Recorder exports consistent JSON and CSV', () => {
  const rec = new Recorder();
  const world = standingPose();
  rec.add({ landmarks: world, world, angles: computeAngles(world) });
  assert.equal(rec.frames.length, 0, 'ignores frames while stopped');
  rec.start({ model: 'test' });
  rec.add({ landmarks: world, world, angles: computeAngles(world) });
  rec.add({ landmarks: null, world: null, angles: computeAngles(null) });
  rec.stop();

  const json = JSON.parse(rec.toJSON());
  assert.equal(json.frames.length, 2);
  assert.equal(json.model, 'test');
  assert.equal(json.frames[0].world.length, 33);
  assert.equal(json.frames[0].angles.left_elbow, 90);
  assert.equal(json.frames[1].world, null);

  const lines = rec.toCSV().trim().split('\n');
  assert.equal(lines.length, 3);
  const cols = lines[0].split(',').length;
  assert.equal(cols, 1 + 12 + 33 * 4);
  for (const line of lines) assert.equal(line.split(',').length, cols);
});
