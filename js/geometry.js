// Pure math + landmark metadata. No DOM access, so it can be unit-tested in Node.

export const LANDMARK_NAMES = [
  'nose',
  'left_eye_inner', 'left_eye', 'left_eye_outer',
  'right_eye_inner', 'right_eye', 'right_eye_outer',
  'left_ear', 'right_ear',
  'mouth_left', 'mouth_right',
  'left_shoulder', 'right_shoulder',
  'left_elbow', 'right_elbow',
  'left_wrist', 'right_wrist',
  'left_pinky', 'right_pinky',
  'left_index', 'right_index',
  'left_thumb', 'right_thumb',
  'left_hip', 'right_hip',
  'left_knee', 'right_knee',
  'left_ankle', 'right_ankle',
  'left_heel', 'right_heel',
  'left_foot_index', 'right_foot_index',
];

// Each joint angle is measured at the middle landmark of [a, b, c].
// Indices are for the left side; the right side is always index + 1.
export const JOINTS = [
  { key: 'shoulder', label: 'Shoulder', left: [13, 11, 23] },
  { key: 'elbow', label: 'Elbow', left: [11, 13, 15] },
  { key: 'wrist', label: 'Wrist', left: [13, 15, 19] },
  { key: 'hip', label: 'Hip', left: [11, 23, 25] },
  { key: 'knee', label: 'Knee', left: [23, 25, 27] },
  { key: 'ankle', label: 'Ankle', left: [25, 27, 31] },
];

export const ANGLE_KEYS = JOINTS.flatMap((j) => [`left_${j.key}`, `right_${j.key}`]);

/** Which side of the body a pose landmark belongs to: 'left', 'right' or 'center'. */
export function sideOf(index) {
  if (index === 0) return 'center';
  if (index <= 10) return index <= 3 || index === 7 || index === 9 ? 'left' : 'right';
  return index % 2 === 1 ? 'left' : 'right';
}

/** Angle ABC in degrees (0–180), measured at B, for 3D points. NaN if degenerate. */
export function angleDeg(a, b, c) {
  const ux = a.x - b.x, uy = a.y - b.y, uz = (a.z ?? 0) - (b.z ?? 0);
  const vx = c.x - b.x, vy = c.y - b.y, vz = (c.z ?? 0) - (b.z ?? 0);
  const nu = Math.hypot(ux, uy, uz);
  const nv = Math.hypot(vx, vy, vz);
  if (nu === 0 || nv === 0) return NaN;
  const cos = (ux * vx + uy * vy + uz * vz) / (nu * nv);
  return (Math.acos(Math.min(1, Math.max(-1, cos))) * 180) / Math.PI;
}

/**
 * Compute all joint angles from one pose's world landmarks.
 * A joint is null when any of its three landmarks is below `minVisibility`.
 */
export function computeAngles(world, minVisibility = 0.5) {
  const out = {};
  for (const joint of JOINTS) {
    for (const [side, offset] of [['left', 0], ['right', 1]]) {
      const pts = joint.left.map((i) => world?.[i + offset]);
      const visible = pts.every((p) => p && (p.visibility ?? 1) >= minVisibility);
      const angle = visible ? angleDeg(pts[0], pts[1], pts[2]) : NaN;
      out[`${side}_${joint.key}`] = Number.isFinite(angle) ? angle : null;
    }
  }
  return out;
}

/** Exponential smoothing for angle readouts; passes nulls through and resets on them. */
export function smoothAngles(prev, next, alpha = 0.4) {
  const out = {};
  for (const key of Object.keys(next)) {
    const n = next[key];
    const p = prev?.[key];
    out[key] = n == null ? null : p == null ? n : p + alpha * (n - p);
  }
  return out;
}
