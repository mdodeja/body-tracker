// Jump measurement from a stream of pose frames. Pure logic (no DOM) so it can be unit-tested.
//
// How it works
//   1. Calibrate while the person stands upright and still: find the floor line, the
//      standing hip height and the image scale (pixels per metre, from the person's height).
//   2. Take-off is the moment both feet rise clear of the floor line; landing is when a
//      foot comes back to it.
//   3. Height  = how far the hips rose above their standing height.
//      Distance = front-most toe at take-off to rear-most heel at landing, along the floor.
//      Air time is also converted to a height (g·t²/8) as an independent cross-check.

export const G = 9.81;
const EYE_HEIGHT_RATIO = 0.936; // eye height as a fraction of stature (standard anthropometry)
const STILL_WINDOW_MS = 800;
const MIN_FLIGHT_MS = 200; // shorter than this is a step or a running stride, not a jump
const MAX_FLIGHT_MS = 2500;

const median = (values) => {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const range = (values) => Math.max(...values) - Math.min(...values);
const vis = (p) => p?.visibility ?? 1;

/** Reduce one pose (pixel coordinates, y pointing down) to the few numbers the tracker needs. */
function measure(px, world) {
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

export class JumpTracker {
  /** @param {{heightM?: number|null}} options  heightM: the jumper's real height, for scale. */
  constructor({ heightM = null } = {}) {
    this.heightM = heightM;
    this.reset();
  }

  setHeight(heightM) {
    this.heightM = heightM || null;
    this.reset();
  }

  reset() {
    this.phase = 'searching'; // searching -> steady -> ready -> air -> ready ...
    this.cal = null;
    this.window = [];
    this.lastGround = null;
    this.prevGround = null;
    this.air = null;
    this.lastT = -Infinity;
  }

  /**
   * Feed one frame.
   * @param t      timestamp in ms
   * @param px     33 pose landmarks in pixels ({x, y, visibility}), or null if nobody is tracked
   * @param world  matching world landmarks (metres), used for scale when no height was given
   * @param angles joint angles from computeAngles(), used to check the person is standing straight
   * @returns {{phase: string, event?: 'calibrated'|'takeoff'|'result', result?: object}}
   */
  update(t, px, world = null, angles = null) {
    if (t < this.lastT) this.reset(); // the source restarted (e.g. a looping video)
    this.lastT = t;
    const m = measure(px, world);

    if (this.phase === 'air') return this.#inAir(t, m);

    if (!m) {
      this.window = [];
      this.phase = this.cal ? 'ready' : 'searching';
      return { phase: this.phase };
    }

    if (this.cal && this.lastGround && m.lowestFoot < this.cal.ground - this.cal.threshold) {
      this.air = {
        tOff: (this.lastGround.t + t) / 2,
        lastAirT: t,
        takeoffFeetX: this.#takeoffFeetX(),
        hipX0: this.lastGround.hipX,
        hipY0: this.lastGround.hipY,
        recentHipY: [m.hipY],
        recentFoot: [m.lowestFoot],
        peakY: m.hipY,
        peakX: m.hipX,
        peakT: t,
        // Hip positions through the jump, for drawing its arc.
        path: [{ t: this.lastGround.t, x: this.lastGround.hipX, y: this.lastGround.hipY }, { t, x: m.hipX, y: m.hipY }],
      };
      this.window = [];
      this.phase = 'air';
      return { phase: this.phase, event: 'takeoff' };
    }
    this.prevGround = this.lastGround;
    this.lastGround = { t, feet: m.feet, hipX: m.hipX, hipY: m.hipY };

    const straight = ['left_knee', 'right_knee', 'left_hip', 'right_hip'].every((k) => angles?.[k] == null || angles[k] >= 150);
    this.window.push({ t, ...m, straight });
    while (this.window.length && t - this.window[0].t > STILL_WINDOW_MS) this.window.shift();

    const wasReady = this.phase === 'ready';
    if (this.#standingStill(t)) {
      this.#calibrate();
      this.phase = 'ready';
      if (!wasReady) return { phase: this.phase, event: 'calibrated' };
    } else if (!this.cal) {
      this.phase = 'steady';
    } else {
      this.phase = 'ready';
    }
    return { phase: this.phase };
  }

  /**
   * Where the feet were planted for take-off. The last "grounded" frame can already be a
   * few centimetres into the jump (the feet have left the floor but not yet cleared the
   * threshold), so prefer the frame before it. Only feet that are actually on the floor
   * count, so a running take-off is measured from the planted foot, not the swinging one.
   */
  #takeoffFeetX() {
    const last = this.lastGround;
    const prev = this.prevGround;
    const frame = prev && last.t - prev.t < 100 ? prev : last;
    const floor = this.cal.ground - this.cal.threshold;
    const planted = frame.feet.filter((f) => f.bottom >= floor);
    return (planted.length ? planted : frame.feet).flatMap((f) => f.xs);
  }

  #standingStill(t) {
    const w = this.window;
    if (w.length < 5 || t - w[0].t < STILL_WINDOW_MS * 0.85) return false;
    const bodyPx = median(w.map((s) => s.lowestFoot - s.eyeY));
    if (!(bodyPx > 0)) return false;
    const tolerance = 0.02 * bodyPx;
    return (
      w.every((s) => s.straight) &&
      range(w.map((s) => s.hipX)) < tolerance &&
      range(w.map((s) => s.hipY)) < tolerance &&
      range(w.map((s) => s.lowestFoot)) < tolerance
    );
  }

  #calibrate() {
    const w = this.window;
    const ground = median(w.map((s) => s.lowestFoot));
    const bodyPx = ground - median(w.map((s) => s.eyeY));
    const worldEye = w.map((s) => s.worldEyeToFloor).filter((v) => v > 0);
    // Without a real height, fall back to the model's own estimate of body size.
    const eyeHeightM = this.heightM ? this.heightM * EYE_HEIGHT_RATIO : worldEye.length ? median(worldEye) : 1.7 * EYE_HEIGHT_RATIO;
    this.cal = {
      ground,
      hipY: median(w.map((s) => s.hipY)),
      hipX: median(w.map((s) => s.hipX)),
      bodyPx,
      scale: bodyPx / eyeHeightM, // pixels per metre
      threshold: 0.035 * bodyPx, // ~6 cm for an adult: clear of the floor, above landmark jitter
      approximate: !this.heightM,
    };
  }

  #inAir(t, m) {
    const air = this.air;
    const cal = this.cal;
    if (t - air.tOff > MAX_FLIGHT_MS) return this.#endAir();
    if (!m) return { phase: this.phase }; // tracking dropped mid-flight: keep waiting

    air.recentHipY = [...air.recentHipY.slice(-2), m.hipY];
    const hipY = median(air.recentHipY); // a 3-frame median keeps one jittery frame from setting the peak
    if (hipY < air.peakY) {
      air.peakY = hipY;
      air.peakX = m.hipX;
      air.peakT = t;
    }
    if (!air.touch) air.path.push({ t, x: m.hipX, y: m.hipY });
    air.recentFoot = [...air.recentFoot.slice(-2), m.lowestFoot];

    const touched = m.lowestFoot >= cal.ground - cal.threshold / 2;
    // Fallback for a landing spot that sits higher in the picture than the take-off spot
    // (tilted phone, sloping ground): the hips have come most of the way back down and the
    // feet have stopped falling.
    const descended = m.hipY >= air.peakY + 0.5 * (air.hipY0 - air.peakY);
    const settled = air.recentFoot.length === 3 && Math.abs(air.recentFoot[2] - air.recentFoot[0]) < 0.3 * cal.threshold;
    const stalled = t - air.tOff > MIN_FLIGHT_MS && descended && settled;
    if (!air.touch) {
      if (!touched && !stalled) {
        air.lastAirT = t;
        return { phase: this.phase };
      }
      // Wait one more frame before reading the landing position: on the touchdown frame
      // the feet can still be a few centimetres short of where they plant.
      air.touch = { t, flightMs: this.#flightTime((air.lastAirT + t) / 2 - air.tOff) };
      return { phase: this.phase };
    }

    const { flightMs } = air.touch;
    if (flightMs < MIN_FLIGHT_MS) return this.#endAir();

    const dir = Math.sign(m.hipX - air.hipX0) || 1;
    const takeoffX = dir * Math.max(...air.takeoffFeetX.map((x) => dir * x));
    const landingX = dir * Math.min(...m.feetX.map((x) => dir * x));
    const result = {
      flightMs,
      riseM: Math.max(0, cal.hipY - air.peakY) / cal.scale,
      flightHeightM: (G * (flightMs / 1000) ** 2) / 8,
      distanceM: Math.max(0, dir * (landingX - takeoffX)) / cal.scale,
      approximate: cal.approximate,
      peakMs: Math.max(0, air.peakT - air.tOff),
      // The arc of the hips: time since take-off, distance travelled, height above standing.
      path: air.path.map((p) => ({
        tMs: Math.max(0, p.t - air.tOff),
        xM: (dir * (p.x - air.hipX0)) / cal.scale,
        riseM: (cal.hipY - p.y) / cal.scale,
      })),
      pathPx: air.path.map((p) => ({ x: p.x, y: p.y })),
      // Pixel positions, for drawing the measurement over the video.
      marks: { takeoffX, landingX, groundY: cal.ground, peakX: air.peakX, peakY: air.peakY, standingHipY: cal.hipY },
    };
    this.prevGround = null;
    this.lastGround = { t, feet: m.feet, hipX: m.hipX, hipY: m.hipY };
    this.#endAir();
    return { phase: this.phase, event: 'result', result };
  }

  /**
   * The feet only count as airborne above a clearance threshold, so the observed air time
   * misses the moments spent rising to it and falling from it. Add those back, using the
   * take-off speed implied by the flight time itself (v = g·T/2).
   */
  #flightTime(observedMs) {
    const missedM = (1.5 * this.cal.threshold) / this.cal.scale; // full threshold up, half down
    let T = observedMs / 1000;
    for (let i = 0; i < 3; i++) T = observedMs / 1000 + missedM / ((G * T) / 2);
    return T * 1000;
  }

  #endAir() {
    this.air = null;
    this.window = [];
    this.phase = 'ready';
    return { phase: this.phase };
  }
}

// ---------------------------------------------------------------- formatting

/** Jump height: whole centimetres, or inches to one decimal. */
export function formatHeight(metres, units = 'metric', spoken = false) {
  if (units === 'imperial') {
    const inches = (metres / 0.0254).toFixed(1);
    return `${inches} ${spoken ? 'inches' : 'in'}`;
  }
  return `${Math.round(metres * 100)} ${spoken ? 'centimetres' : 'cm'}`;
}

/** Jump distance: metres to two decimals, or feet and whole inches. */
export function formatDistance(metres, units = 'metric', spoken = false) {
  if (units === 'imperial') {
    const total = Math.round(metres / 0.0254);
    const ft = Math.floor(total / 12);
    const inch = total % 12;
    return spoken ? `${ft} feet ${inch} inches` : `${ft} ft ${inch} in`;
  }
  return `${metres.toFixed(2)} ${spoken ? 'metres' : 'm'}`;
}
