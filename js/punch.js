// Punch speed: how fast the fist (tracked at the wrist) travels as the arm shoots out.
// Pure logic (no DOM) so it can be unit-tested.
//
// Scale comes from the same standing-still calibration as the other measuring modes.
// After that only the shoulders and wrists need to be in view. A punch is a burst of wrist
// speed during which the wrist moves away from its shoulder; pulling the hand back, or
// the whole picture shaking, is fast too but does not extend the arm, so it is ignored.
//
// Speed is measured across the plane of the picture, so the punch has to travel across
// the screen (camera side-on), not toward the camera.

import { measure, StanceDetector } from './stance.js';

const START_MPS = 2.5; // a burst begins above this...
const END_MPS = 1.2; // ...and ends below this
const MIN_EXTENSION_M = 0.15; // the arm must actually reach out
const MAX_FRAME_GAP_MS = 150; // longer than this between frames and speed is meaningless
const ARMS = {
  left: { shoulder: 11, wrist: 15 },
  right: { shoulder: 12, wrist: 16 },
};
const seen = (p) => p && (p.visibility ?? 1) >= 0.3; // a fast fist is blurred: accept a faint wrist

export class PunchTracker {
  constructor({ heightM = null } = {}) {
    this.stance = new StanceDetector({ heightM });
    this.reset();
  }

  setHeight(heightM) {
    this.stance.heightM = heightM || null;
    this.reset();
  }

  reset() {
    this.phase = 'searching'; // searching -> steady -> ready <-> punching
    this.scale = null; // pixels per metre
    this.approximate = false;
    this.prev = null; // last frame's wrists
    this.bursts = { left: null, right: null };
    this.rest = { left: null, right: null }; // where each fist last was while not moving fast
    this.lastT = -Infinity;
    this.stance.clear();
  }

  /** Call when the phone itself is being moved: forget any punch in progress. */
  interrupt() {
    this.prev = null;
    this.bursts = { left: null, right: null };
    this.rest = { left: null, right: null };
    this.stance.clear();
  }

  /** @returns {{phase: string, event?: 'calibrated'|'result', result?: object}} */
  update(t, px, world = null, angles = null) {
    if (t < this.lastT) this.reset();
    this.lastT = t;

    // Scale: whenever the whole body is in view, upright and still.
    let event;
    const m = measure(px, world);
    if (m) {
      const cal = this.stance.update(t, m, angles);
      if (cal) {
        if (!this.scale) event = 'calibrated';
        this.scale = cal.scale;
        this.approximate = cal.approximate;
      }
    } else {
      this.stance.clear();
    }
    if (!this.scale) {
      this.phase = m ? 'steady' : 'searching';
      return { phase: this.phase };
    }

    const prev = this.prev;
    this.prev = px ? { t, px } : null;
    let result = null;
    if (px && prev && t - prev.t <= MAX_FRAME_GAP_MS && t > prev.t) {
      const dt = (t - prev.t) / 1000;
      for (const [hand, arm] of Object.entries(ARMS)) {
        const done = this.#trackHand(hand, arm, prev, px, t, dt);
        // Two hands rarely finish on the same frame; if they do, keep the faster.
        if (done && (!result || done.peakMps > result.peakMps)) result = done;
      }
    } else {
      this.bursts = { left: null, right: null };
    }

    this.phase = this.bursts.left || this.bursts.right ? 'punching' : 'ready';
    if (result) return { phase: this.phase, event: 'result', result };
    return event ? { phase: this.phase, event } : { phase: this.phase };
  }

  #trackHand(hand, arm, prev, px, t, dt) {
    const wrist = px[arm.wrist];
    const shoulder = px[arm.shoulder];
    const before = prev.px[arm.wrist];
    if (!seen(wrist) || !seen(before) || !seen(shoulder)) {
      this.bursts[hand] = null;
      return null;
    }
    const scale = this.scale;
    const speed = Math.hypot(wrist.x - before.x, wrist.y - before.y) / scale / dt;
    const reach = Math.hypot(wrist.x - shoulder.x, wrist.y - shoulder.y) / scale;
    const reachBefore = Math.hypot(before.x - prev.px[arm.shoulder].x, before.y - prev.px[arm.shoulder].y) / scale;

    let burst = this.bursts[hand];
    if (!burst) {
      if (speed < END_MPS) this.rest[hand] = { t, x: wrist.x, y: wrist.y, reach };
      if (speed < START_MPS) return null;
      // The punch began where the fist last sat still, a frame or two before it got fast.
      const rest = this.rest[hand] && t - this.rest[hand].t < 300 ? this.rest[hand] : { t: prev.t, x: before.x, y: before.y, reach: reachBefore };
      burst = this.bursts[hand] = {
        t0: rest.t, from: { x: rest.x, y: rest.y }, startReach: rest.reach, maxReach: rest.reach,
        peakMps: 0, to: null, tEnd: rest.t,
      };
    }
    if (speed >= END_MPS) {
      // Only the outward part of the movement counts toward the speed.
      if (reach > reachBefore && speed > burst.peakMps) burst.peakMps = speed;
      if (reach > burst.maxReach) {
        burst.maxReach = reach;
        burst.to = { x: wrist.x, y: wrist.y };
        burst.tEnd = t;
      }
      return null;
    }

    this.bursts[hand] = null;
    this.rest[hand] = { t, x: wrist.x, y: wrist.y, reach };
    if (reach > burst.maxReach) {
      burst.maxReach = reach;
      burst.to = { x: wrist.x, y: wrist.y };
      burst.tEnd = t;
    }
    const extensionM = burst.maxReach - burst.startReach;
    if (extensionM < MIN_EXTENSION_M || !burst.to || burst.peakMps < START_MPS) return null;
    return {
      hand,
      peakMps: burst.peakMps,
      extensionM,
      durationMs: burst.tEnd - burst.t0,
      approximate: this.approximate,
      marks: { from: burst.from, to: burst.to }, // pixel positions, for drawing the punch
    };
  }
}
