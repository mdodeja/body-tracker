// Two more measuring modes built on the same standing-still calibration as the jumps:
//   DistanceTracker — how far apart two spots are that you stand on, one after the other.
//   SprintTracker   — a start and a finish line a set distance apart, and how fast you
//                     get from one to the other.
// Pure logic (no DOM) so it can be unit-tested.

import { measure, StanceDetector } from './stance.js';

export class DistanceTracker {
  constructor({ heightM = null } = {}) {
    this.stance = new StanceDetector({ heightM });
    this.reset();
  }

  setHeight(heightM) {
    this.stance.heightM = heightM || null;
    this.reset();
  }

  reset() {
    this.phase = 'searching'; // searching -> steady -> marked
    this.spot = null; // the last place the person stood: { x, ground, scale }
    this.lastT = -Infinity;
    this.stance.clear();
  }

  /** @returns {{phase: string, event?: 'marked'|'result', result?: object}} */
  update(t, px, world = null, angles = null) {
    if (t < this.lastT) this.reset();
    this.lastT = t;
    const m = measure(px, world);
    if (!m) {
      this.stance.clear();
      this.phase = this.spot ? 'marked' : 'searching';
      return { phase: this.phase };
    }
    const cal = this.stance.update(t, m, angles);
    if (!cal) {
      this.phase = this.spot ? 'marked' : 'steady';
      return { phase: this.phase };
    }

    // A spot is the point midway between the feet.
    const here = { x: cal.footX, ground: cal.ground, scale: cal.scale, approximate: cal.approximate };
    const from = this.spot;
    this.spot = here;
    this.phase = 'marked';
    if (!from) return { phase: this.phase, event: 'marked' };
    // Still on the same spot (shifting weight is not a move): just refine it.
    if (Math.abs(here.x - from.x) < 0.15 * cal.bodyPx) return { phase: this.phase };

    // Standing at the same distance from the camera gives the same scale both times;
    // averaging evens out the small differences between the two readings.
    const scale = (from.scale + here.scale) / 2;
    return {
      phase: this.phase,
      event: 'result',
      result: {
        distanceM: Math.abs(here.x - from.x) / scale,
        approximate: here.approximate,
        marks: { fromX: from.x, toX: here.x, groundY: (from.ground + here.ground) / 2 },
      },
    };
  }
}

const SLOW_MPS = 0.5; // below this the runner has not really set off yet
const GO_DISTANCE_M = 0.5; // this far past the start line, the run is definitely on
const MAX_RUN_MS = 20000;
const REMARK_HOLD_MS = 3000;

export class SprintTracker {
  /** @param {{heightM?: number|null, distanceM?: number}} options */
  constructor({ heightM = null, distanceM = 5 } = {}) {
    this.stance = new StanceDetector({ heightM });
    this.distanceM = distanceM;
    this.reset();
  }

  setHeight(heightM) {
    this.stance.heightM = heightM || null;
    this.reset();
  }

  setDistance(distanceM) {
    this.distanceM = distanceM;
    this.reset();
  }

  reset() {
    this.phase = 'searching'; // searching -> steady -> set -> running -> set ...
    this.lines = null; // { startX, finishX, dir, scale, ground, fits }
    this.samples = []; // recent { t, x } of the hips
    this.run = null;
    this.armed = false;
    this.lastT = -Infinity;
    this.stance.holdMs = 800;
    this.stance.clear();
  }

  /**
   * @param frameWidth width of the picture in pixels, to check the finish line is in view
   * @returns {{phase: string, event?: 'set'|'nofit'|'start'|'result', result?: object}}
   */
  update(t, px, world = null, angles = null, frameWidth = Infinity) {
    if (t < this.lastT) this.reset();
    this.lastT = t;
    const m = measure(px, world);

    if (this.phase === 'running') return this.#running(t, m);

    if (!m) {
      this.stance.clear();
      this.phase = this.lines ? 'set' : 'searching';
      return { phase: this.phase };
    }
    this.samples.push({ t, x: m.hipX });
    while (t - this.samples[0].t > 3000) this.samples.shift();

    // Standing still places the lines. Once they are placed it takes a deliberate 3 seconds
    // to move them, so pausing before a run-up does not shift the start line.
    const cal = this.stance.update(t, m, angles);
    if (cal) {
      const startX = cal.hipX;
      const dir = startX < frameWidth / 2 ? 1 : -1; // run toward the side with more room
      const finishX = startX + dir * this.distanceM * cal.scale;
      const fits = finishX > 0.02 * frameWidth && finishX < 0.98 * frameWidth;
      const moved = !this.lines || Math.abs(startX - this.lines.startX) > 0.15 * cal.bodyPx;
      this.lines = { startX, finishX, dir, scale: cal.scale, ground: cal.ground, fits, approximate: cal.approximate };
      this.stance.holdMs = REMARK_HOLD_MS;
      this.stance.clear();
      this.armed = true;
      this.phase = 'set';
      if (moved) return { phase: this.phase, event: fits ? 'set' : 'nofit' };
      return { phase: this.phase };
    }
    if (!this.lines) {
      this.phase = 'steady';
      return { phase: this.phase };
    }
    this.phase = 'set';

    const { startX, dir, scale, fits } = this.lines;
    const ahead = (dir * (m.hipX - startX)) / scale; // metres past the start line
    if (!this.armed) {
      if (ahead < GO_DISTANCE_M / 2) this.armed = true; // back at the start: ready for another go
      return { phase: this.phase };
    }
    if (!fits || ahead < GO_DISTANCE_M) return { phase: this.phase };

    const start = this.#startMoment();
    this.run = { t0: start.t, x0: start.x, path: this.samples.filter((s) => s.t >= start.t) };
    this.armed = false;
    this.stance.clear();
    this.phase = 'running';
    return { phase: this.phase, event: 'start' };
  }

  /**
   * When the run began, looking back from the moment the runner is clearly under way:
   * the later of crossing the start line (a flying start) and setting off (a standing
   * start — so leaning forward and then waiting does not start the clock).
   */
  #startMoment() {
    const { startX, dir, scale } = this.lines;
    const s = this.samples;
    let cross = null;
    let slow = null;
    for (let i = s.length - 1; i > 0 && !(cross && slow); i--) {
      const a = s[i - 1];
      const b = s[i];
      if (!cross && dir * (a.x - startX) < 0 && dir * (b.x - startX) >= 0) {
        const f = (startX - a.x) / (b.x - a.x);
        cross = { t: a.t + f * (b.t - a.t), x: startX };
      }
      if (!slow && b.t > a.t && (dir * (b.x - a.x)) / scale / ((b.t - a.t) / 1000) < SLOW_MPS) slow = b;
    }
    const candidates = [cross, slow].filter(Boolean);
    if (!candidates.length) return s[0];
    return candidates.reduce((p, q) => (q.t > p.t ? q : p));
  }

  #running(t, m) {
    const run = this.run;
    const { startX, finishX, dir, scale } = this.lines;
    if (t - run.t0 > MAX_RUN_MS) return this.#endRun();
    if (!m) return { phase: this.phase }; // tracking dropped mid-run: keep waiting

    const prev = run.path[run.path.length - 1];
    const cur = { t, x: m.hipX };
    run.path.push(cur);
    if (dir * (cur.x - startX) < -0.3 * scale) return this.#endRun(); // turned back
    if (dir * (cur.x - finishX) < 0) return { phase: this.phase };

    const f = prev.x === cur.x ? 1 : (finishX - prev.x) / (cur.x - prev.x);
    const tFinish = prev.t + Math.min(1, Math.max(0, f)) * (cur.t - prev.t);
    const timeMs = tFinish - run.t0;
    const distanceM = Math.abs(finishX - run.x0) / scale;

    // Top speed: the fastest stretch of at least 0.3 s, which smooths out landmark jitter.
    let topMps = 0;
    for (let i = 0, j = 0; i < run.path.length; i++) {
      while (run.path[i].t - run.path[j + 1]?.t >= 300) j++;
      const dt = run.path[i].t - run.path[j].t;
      if (dt >= 300) topMps = Math.max(topMps, (dir * (run.path[i].x - run.path[j].x)) / scale / (dt / 1000));
    }
    const avgMps = distanceM / (timeMs / 1000);
    const result = {
      timeMs,
      distanceM,
      avgMps,
      topMps: Math.max(topMps, avgMps),
      approximate: this.lines.approximate,
    };
    this.#endRun();
    return { phase: this.phase, event: 'result', result };
  }

  #endRun() {
    this.run = null;
    this.samples = [];
    this.stance.clear();
    this.phase = 'set';
    return { phase: this.phase };
  }
}

/** Speed in km/h, or mph. */
export function formatSpeed(mps, units = 'metric', spoken = false) {
  if (units === 'imperial') return `${(mps * 2.23694).toFixed(1)} ${spoken ? 'miles per hour' : 'mph'}`;
  return `${(mps * 3.6).toFixed(1)} ${spoken ? 'kilometres per hour' : 'km/h'}`;
}
