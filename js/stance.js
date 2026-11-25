// Shared groundwork for the measuring modes: boil a pose down to a few numbers, and
// recognise the moment someone stands upright and still — which is when the floor line,
// their standing position and the image scale (pixels per metre) can be read off.

export const EYE_HEIGHT_RATIO = 0.936; // eye height as a fraction of stature (standard anthropometry)

export const median = (values) => {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const vis = (p) => p?.visibility ?? 1;

/** Reduce one pose (pixel coordinates, y pointing down) to the few numbers the tracker needs. */
export function measure(px, world) {
  if (!px) return null;
  const hipsSeen = (vis(px[23]) + vis(px[24])) / 2 >= 0.5;
  // Side-on (as for a long jump) the far leg is hidden behind the near one, so one clearly
  // visible ankle is enough; the model still estimates where the hidden foot is.
  const feetSeen = Math.max(vis(px[27]), vis(px[28])) >= 0.5;
  const eyes = [px[2], px[5]].filter((p) => vis(p) >= 0.5);
  if (!hipsSeen || !feetSeen || !eyes.length) return null;

  const footL = Math.max(px[29].y, px[31].y);
  const footR = Math.max(px[30].y, px[32].y);
  const m = {
    hipX: (px[23].x + px[24].x) / 2,
    hipY: (px[23].y + px[24].y) / 2,
    eyeY: eyes.reduce((s, p) => s + p.y, 0) / eyes.length,
    lowestFoot: Math.max(footL, footR), // the foot nearest the floor
    highestFoot: Math.min(footL, footR),
    feetX: [px[29].x, px[30].x, px[31].x, px[32].x],
    footX: (px[29].x + px[30].x + px[31].x + px[32].x) / 4,
    feet: [
      { bottom: footL, xs: [px[29].x, px[31].x] },
      { bottom: footR, xs: [px[30].x, px[32].x] },
    ],
    worldEyeToFloor: null,
  };
  if (world) {
    const floor = Math.max(world[29].y, world[30].y, world[31].y, world[32].y);
    m.worldEyeToFloor = floor - (world[2].y + world[5].y) / 2;
  }
  return m;
}

export class StanceDetector {
  /**
   * @param heightM the person's real height (sets the scale); null to estimate it
   * @param holdMs  how long they must stand still before it counts
   */
  constructor({ heightM = null, holdMs = 800 } = {}) {
    this.heightM = heightM;
    this.holdMs = holdMs;
    this.window = [];
  }

  clear() {
    this.window = [];
  }

  /**
   * Feed one frame's measure() result. Returns a calibration once the person has been
   * upright and still for holdMs, otherwise null.
   */
  update(t, m, angles) {
    const straight = ['left_knee', 'right_knee', 'left_hip', 'right_hip'].every((k) => angles?.[k] == null || angles[k] >= 150);
    const w = this.window;
    w.push({ t, ...m, straight });
    while (w.length && t - w[0].t > this.holdMs) w.shift();
    if (w.length < 5 || t - w[0].t < this.holdMs * 0.85) return null;

    const ground = median(w.map((s) => s.lowestFoot));
    const bodyPx = ground - median(w.map((s) => s.eyeY));
    if (!(bodyPx > 0)) return null;
    const tolerance = 0.02 * bodyPx;
    // Landmarks jitter, and now and then one frame is well off. Judge stillness on the
    // spread of the middle 80% of readings, so a single stray frame does not restart the wait.
    const spread = (values) => {
      const sorted = [...values].sort((x, y) => x - y);
      const cut = Math.floor(sorted.length * 0.1);
      return sorted[sorted.length - 1 - cut] - sorted[cut];
    };
    const still =
      w.filter((s) => s.straight).length >= 0.9 * w.length &&
      spread(w.map((s) => s.hipX)) < tolerance &&
      spread(w.map((s) => s.hipY)) < tolerance &&
      spread(w.map((s) => s.lowestFoot)) < 1.5 * tolerance; // feet are the jumpiest landmarks
    if (!still) return null;

    const worldEye = w.map((s) => s.worldEyeToFloor).filter((v) => v > 0);
    // Without a real height, fall back to the model's own estimate of body size.
    const eyeHeightM = this.heightM ? this.heightM * EYE_HEIGHT_RATIO : worldEye.length ? median(worldEye) : 1.7 * EYE_HEIGHT_RATIO;
    return {
      ground,
      hipY: median(w.map((s) => s.hipY)),
      hipX: median(w.map((s) => s.hipX)),
      footX: median(w.map((s) => s.footX)),
      bodyPx,
      scale: bodyPx / eyeHeightM, // pixels per metre
      approximate: !this.heightM,
    };
  }
}
