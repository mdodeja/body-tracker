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

import { measure, median, StanceDetector } from './stance.js';

export const G = 9.81;
const MIN_FLIGHT_MS = 200; // shorter than this is a step or a running stride, not a jump
const MAX_FLIGHT_MS = 2500;

export class JumpTracker {
  /** @param {{heightM?: number|null}} options  heightM: the jumper's real height, for scale. */
  constructor({ heightM = null } = {}) {
    this.heightM = heightM;
    this.stance = new StanceDetector({ heightM });
    this.reset();
  }

  setHeight(heightM) {
    this.heightM = this.stance.heightM = heightM || null;
    this.reset();
  }

  reset() {
    this.phase = 'searching'; // searching -> steady -> ready -> air -> ready ...
    this.cal = null;
    this.stance.clear();
    this.lastGround = null;
    this.prevGround = null;
    this.groundHips = []; // recent hip heights while on the floor: the dip and push before a jump
    this.groundFeet = []; // recent foot levels while on the floor: where the floor is right now
    this.floorY = null;
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
      this.stance.clear();
      this.phase = this.cal ? 'ready' : 'searching';
      return { phase: this.phase };
    }

    // Where the floor is under the jumper right now. It is followed continuously, not fixed
    // at calibration: landing a step nearer to or farther from the camera moves it up or
    // down the picture, and the next jump has to be judged from where the feet actually are.
    const floor = this.groundFeet.length >= 4 ? median(this.groundFeet.map((s) => s.y)) : null;
    this.floorY = floor ?? this.cal?.ground ?? null;
    const cleared = floor != null && this.cal && m.lowestFoot < floor - this.cal.threshold;
    // A take-off is abrupt. Feet that creep up the picture are someone walking away.
    const abrupt = this.lastGround && m.lowestFoot < this.lastGround.lowestFoot - 0.3 * (this.cal?.threshold ?? 0);
    if (cleared && abrupt) {
      this.air = {
        floor,
        // Standing hip height carried over to this floor.
        standingHipY: floor - (this.cal.ground - this.cal.hipY),
        tOff: (this.lastGround.t + t) / 2,
        lastAirT: t,
        takeoffFeetX: this.#takeoffFeetX(),
        pre: this.groundHips,
        preFloor: this.groundFeet,
        hipX0: this.lastGround.hipX,
        hipY0: this.lastGround.hipY,
        recentHipY: [m.hipY],
        feet: [{ t, y: m.lowestFoot }],
        peakY: m.hipY,
        peakX: m.hipX,
        // Hip positions through the jump, for drawing its arc.
        path: [{ t: this.lastGround.t, x: this.lastGround.hipX, y: this.lastGround.hipY }, { t, x: m.hipX, y: m.hipY }],
        peakT: t,
      };
      this.groundHips = [];
      this.groundFeet = [];
      this.stance.clear();
      this.phase = 'air';
      return { phase: this.phase, event: 'takeoff' };
    }
    this.prevGround = this.lastGround;
    this.lastGround = { t, feet: m.feet, hipX: m.hipX, hipY: m.hipY, lowestFoot: m.lowestFoot };
    this.groundHips.push({ t, y: m.hipY });
    while (t - this.groundHips[0].t > 2500) this.groundHips.shift();
    this.groundFeet.push({ t, y: m.lowestFoot });
    // Long enough to average out foot-landmark jitter (which feeds straight into the height),
    // short enough to have settled between quick consecutive jumps.
    while (t - this.groundFeet[0].t > 600) this.groundFeet.shift();

    const wasReady = this.phase === 'ready';
    const cal = this.stance.update(t, m, angles);
    if (cal) {
      // Clearance that counts as airborne: ~6 cm for an adult — off the floor, above landmark jitter.
      this.cal = { ...cal, threshold: 0.035 * cal.bodyPx };
      this.phase = 'ready';
      if (!wasReady) return { phase: this.phase, event: 'calibrated' };
    } else {
      this.phase = this.cal ? 'ready' : 'steady';
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
    const level = (this.floorY ?? this.cal.ground) - this.cal.threshold;
    const planted = frame.feet.filter((f) => f.bottom >= level);
    return (planted.length ? planted : frame.feet).flatMap((f) => f.xs);
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

    const touched = m.lowestFoot >= air.floor - cal.threshold / 2;
    // A landing spot that sits higher in the picture than the take-off spot (farther from
    // the camera, a tilted phone, sloping ground) never reaches the take-off floor line.
    // There, landing shows as the feet coming to rest: down from their highest point and
    // then level for a good tenth of a second. (At the top of a jump they are level too,
    // but not yet down from their highest point.)
    air.highestFoot = Math.min(air.highestFoot ?? Infinity, m.lowestFoot);
    air.feet.push({ t, y: m.lowestFoot });
    let rest = air.feet.length - 1;
    while (rest > 0 && Math.abs(air.feet[rest - 1].y - m.lowestFoot) < 0.4 * cal.threshold) rest--;
    const stalled =
      t - air.feet[rest].t >= 120 &&
      m.lowestFoot > air.highestFoot + cal.threshold &&
      air.feet[rest].t - air.tOff > MIN_FLIGHT_MS / 2;
    if (!air.touch) {
      if (!touched && !stalled) {
        air.lastAirT = t;
        return { phase: this.phase };
      }
      // Feet found at rest landed when the rest began, not now.
      const landedAt = touched ? (air.lastAirT + t) / 2 : (air.feet[Math.max(0, rest - 1)].t + air.feet[rest].t) / 2;
      // Wait one more frame before reading the landing position: on the touchdown frame
      // the feet can still be a few centimetres short of where they plant.
      air.touch = { t, y: m.lowestFoot, flightMs: this.#flightTime(landedAt - air.tOff) };
      if (touched) return { phase: this.phase };
    } else if (m.lowestFoot - air.touch.y > 0.5 * cal.threshold) {
      // Still falling: the landing spot is lower in the picture than the take-off spot, and
      // the feet only passed the old floor line on their way down. Keep going.
      air.touch = null;
      air.lastAirT = t;
      return { phase: this.phase };
    }

    const { flightMs } = air.touch;
    if (flightMs < MIN_FLIGHT_MS) return this.#endAir();

    const dir = Math.sign(m.hipX - air.hipX0) || 1;
    const takeoffX = dir * Math.max(...air.takeoffFeetX.map((x) => dir * x));
    const landingX = dir * Math.min(...m.feetX.map((x) => dir * x));
    // If the landing spot is nearer to or farther from the camera than the take-off spot,
    // the floor is at a different height in the picture at each end of the jump. Judge the
    // height of the hips against the floor sliding evenly from one to the other.
    const floorShift = m.lowestFoot - air.floor;
    const standingAt = (when) => air.standingHipY + floorShift * Math.min(1, Math.max(0, (when - air.tOff) / flightMs));
    const result = {
      flightMs,
      riseM: Math.max(0, standingAt(air.peakT) - air.peakY) / cal.scale,
      flightHeightM: (G * (flightMs / 1000) ** 2) / 8,
      distanceM: Math.max(0, dir * (landingX - takeoffX)) / cal.scale,
      approximate: cal.approximate,
      takeoffMps: (G * (flightMs / 1000)) / 2, // from air time: up for half of it, down for half
      ...this.#pushOff(),
      peakMs: Math.max(0, air.peakT - air.tOff),
      // The arc of the hips: time since take-off, distance travelled, height above standing.
      path: air.path.map((p) => ({
        tMs: Math.max(0, p.t - air.tOff),
        xM: (dir * (p.x - air.hipX0)) / cal.scale,
        riseM: (standingAt(p.t) - p.y) / cal.scale,
      })),
      pathPx: air.path.map((p) => ({ x: p.x, y: p.y })),
      // Pixel positions, for drawing the measurement over the video.
      marks: { takeoffX, landingX, groundY: air.floor, peakX: air.peakX, peakY: air.peakY, standingHipY: air.standingHipY },
    };
    this.prevGround = null;
    this.lastGround = { t, feet: m.feet, hipX: m.hipX, hipY: m.hipY, lowestFoot: m.lowestFoot };
    this.#endAir();
    return { phase: this.phase, event: 'result', result };
  }

  /**
   * The dip and push before take-off (a countermovement), read from the hips:
   *   dipM            how far the hips dropped below standing
   *   concentricMs    lowest point to take-off — the upward push
   *   timeToTakeoffMs start of the dip to take-off
   * All null when there was no real dip (under 5 cm), e.g. a jump from a held squat.
   */
  #pushOff() {
    const none = { dipM: null, concentricMs: null, timeToTakeoffMs: null };
    const { pre, tOff, standingHipY: hipY } = this.air;
    const { scale } = this.cal;
    if (pre.length < 3) return none;
    const lowestY = Math.max(...pre.map((s) => s.y));
    const dipM = (lowestY - hipY) / scale;
    if (dipM < 0.05) return none;
    // The last moment at the bottom, and before it the last moment still standing tall.
    const bottom = pre.findLast((s) => s.y >= lowestY - 0.01 * scale);
    const tall = hipY + Math.max(0.02 * scale, 0.1 * (lowestY - hipY));
    const onset = pre.findLast((s) => s.t < bottom.t && s.y <= tall);
    return {
      dipM,
      concentricMs: tOff - bottom.t,
      timeToTakeoffMs: onset ? tOff - onset.t : null,
    };
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
    this.stance.clear();
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
