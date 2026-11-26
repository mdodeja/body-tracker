// Replays a recording made with the app's Record button through the measuring code, to
// see exactly what it did with a real jump (or sprint) and why.
// Usage: node scripts/replay.mjs recording.json [--mode high|long|sprint|distance] [--height cm] [--verbose]
import { readFile } from 'node:fs/promises';
import { JumpTracker } from '../js/jump.js';
import { DistanceTracker, SprintTracker } from '../js/measure.js';

const args = process.argv.slice(2);
const flag = (name) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : null);
const file = args.find((a) => !a.startsWith('--') && a.endsWith('.json'));
if (!file) {
  console.error('Usage: node scripts/replay.mjs recording.json [--mode high|long|sprint|distance] [--height cm] [--verbose]');
  process.exit(1);
}

const rec = JSON.parse(await readFile(file, 'utf8'));
const { width = 720, height = 1280 } = rec.frame ?? {};
const mode = flag('mode') ?? (rec.measuring && rec.measuring !== 'off' ? rec.measuring : 'high');
const heightCm = Number(flag('height')) || rec.heightCm || null;
const heightM = heightCm ? heightCm / 100 : null;
const tracker =
  mode === 'sprint' ? new SprintTracker({ heightM, distanceM: rec.sprintM ?? 5 })
  : mode === 'distance' ? new DistanceTracker({ heightM })
  : new JumpTracker({ heightM });

const point = ([x, y, z, visibility]) => ({ x, y, z, visibility });
console.log(`${rec.frames.length} frames, ${width}x${height}, mode ${mode}, height ${heightCm ?? 'not given (scale estimated)'}`);
const gaps = rec.frames.slice(1).map((f, i) => f.t - rec.frames[i].t);
if (gaps.length) console.log(`frame interval: median ${[...gaps].sort((a, b) => a - b)[gaps.length >> 1]} ms, longest ${Math.max(...gaps)} ms`);

let phase = null;
for (const f of rec.frames) {
  const px = f.landmarks?.map(([x, y, z, visibility]) => ({ x: x * width, y: y * height, visibility })) ?? null;
  const out = tracker.update(f.t, px, f.world?.map(point) ?? null, f.angles, width);
  if (out.phase !== phase) console.log(`${String(f.t).padStart(6)} ms  ${phase ?? 'start'} -> ${out.phase}`);
  phase = out.phase;
  if (out.event) {
    const r = out.result;
    const detail = !r ? (out.flightMs ? `air ${Math.round(out.flightMs)} ms` : '')
      : r.riseM != null ? `rise ${(r.riseM * 100).toFixed(1)} cm, distance ${r.distanceM.toFixed(2)} m, air ${Math.round(r.flightMs)} ms, flight height ${(r.flightHeightM * 100).toFixed(1)} cm`
      : r.timeMs != null ? `${(r.timeMs / 1000).toFixed(2)} s over ${r.distanceM.toFixed(2)} m, avg ${r.avgMps.toFixed(2)} m/s, top ${r.topMps.toFixed(2)} m/s`
      : `${r.distanceM.toFixed(2)} m`;
    console.log(`${String(f.t).padStart(6)} ms  EVENT ${out.event} ${detail}`);
  }
  if (args.includes('--verbose') && px) {
    const foot = Math.max(px[29].y, px[30].y, px[31].y, px[32].y);
    const hip = (px[23].y + px[24].y) / 2;
    console.log(`${String(f.t).padStart(6)} ms  ${out.phase.padEnd(9)} foot ${foot.toFixed(0)} hip ${hip.toFixed(0)} floor ${tracker.floorY?.toFixed(0) ?? '-'}`);
  }
}
