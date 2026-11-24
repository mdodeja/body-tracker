// Keeps tracked frames in memory and serialises them to JSON / CSV.
import { LANDMARK_NAMES, ANGLE_KEYS } from './geometry.js';

const round = (v, digits = 4) => (v == null ? null : Number(v.toFixed(digits)));
const packPoint = (p) => [round(p.x), round(p.y), round(p.z), round(p.visibility ?? 1, 2)];

export class Recorder {
  constructor() {
    this.frames = [];
    this.active = false;
    this.startedAt = 0;
    this.meta = {};
  }

  start(meta = {}) {
    this.frames = [];
    this.active = true;
    this.startedAt = performance.now();
    this.meta = { startedAt: new Date().toISOString(), ...meta };
  }

  stop() {
    this.active = false;
  }

  get durationMs() {
    return this.frames.length ? this.frames[this.frames.length - 1].t : 0;
  }

  /** landmarks: normalised image coords; world: metres, origin at mid-hip. */
  add({ landmarks, world, angles, hands }) {
    if (!this.active) return;
    const frame = {
      t: Math.round(performance.now() - this.startedAt),
      landmarks: landmarks ? landmarks.map(packPoint) : null,
      world: world ? world.map(packPoint) : null,
      angles: Object.fromEntries(ANGLE_KEYS.map((k) => [k, round(angles?.[k], 1)])),
    };
    if (hands?.length) {
      frame.hands = hands.map((h) => ({
        side: h.side,
        landmarks: h.landmarks.map((p) => [round(p.x), round(p.y), round(p.z)]),
      }));
    }
    this.frames.push(frame);
  }

  toJSON() {
    return JSON.stringify({
      format: 'body-tracker/1',
      ...this.meta,
      landmarkNames: LANDMARK_NAMES,
      pointFormat: '[x, y, z, visibility]',
      units: { landmarks: 'normalised image (0-1)', world: 'metres, origin at mid-hip', angles: 'degrees', t: 'ms' },
      frames: this.frames,
    });
  }

  toCSV() {
    const header = ['t_ms', ...ANGLE_KEYS.map((k) => `${k}_deg`)];
    for (const name of LANDMARK_NAMES) header.push(`${name}_x`, `${name}_y`, `${name}_z`, `${name}_vis`);
    const rows = [header.join(',')];
    for (const f of this.frames) {
      const row = [f.t, ...ANGLE_KEYS.map((k) => f.angles[k] ?? '')];
      for (let i = 0; i < LANDMARK_NAMES.length; i++) {
        const p = f.world?.[i];
        row.push(...(p ?? ['', '', '', '']));
      }
      rows.push(row.join(','));
    }
    return rows.join('\n') + '\n';
  }
}

export function download(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
