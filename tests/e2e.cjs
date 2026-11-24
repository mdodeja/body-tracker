// End-to-end check in headless Chromium: loads the app, feeds it a photo of a person
// and a fake camera, and verifies that joints are tracked and recordings export.
// Usage: node tests/e2e.cjs [path/to/person.jpg]   (downloads a sample photo if omitted)
const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const port = 8765;
const shots = process.env.SHOTS_DIR;
const SAMPLE = 'https://storage.googleapis.com/mediapipe-assets/pose.jpg';

function check(cond, message) {
  if (!cond) throw new Error(`FAILED: ${message}`);
  console.log(`ok - ${message}`);
}

async function samplePhoto() {
  if (process.argv[2]) return process.argv[2];
  const file = path.join(root, 'tests', '.cache', 'pose.jpg');
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const res = await fetch(SAMPLE);
    if (!res.ok) throw new Error(`Could not download sample photo: ${res.status}`);
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  }
  return file;
}

(async () => {
  const photo = await samplePhoto();
  const server = spawn(process.execPath, [path.join(root, 'scripts', 'serve.mjs'), String(port)], { stdio: 'ignore' });
  const browser = await chromium.launch({
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  });
  try {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      permissions: ['camera'],
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await new Promise((r) => setTimeout(r, 400));
    await page.goto(`http://localhost:${port}/`);

    await page.waitForFunction(() => window.bodyTracker?.pose, null, { timeout: 60_000 });
    check(true, `pose model loads (${await page.evaluate(() => window.bodyTracker.delegate)})`);
    if (shots) await page.screenshot({ path: path.join(shots, 'intro.png') });

    // Photo of a person -> skeleton + angles.
    await page.setInputFiles('#file', photo);
    await page.waitForFunction(() => window.bodyTracker.last?.poseCount === 1, null, { timeout: 30_000 });
    const last = await page.evaluate(() => {
      const { landmarks, angles } = window.bodyTracker.last;
      return { count: landmarks.length, angles };
    });
    check(last.count === 33, 'tracks 33 body landmarks');
    const measured = Object.values(last.angles).filter((a) => a != null);
    check(measured.length >= 6, `measures joint angles (${measured.length} of 12 visible)`);
    check(measured.every((a) => a >= 0 && a <= 180), 'angles are within 0-180 degrees');
    await page.waitForFunction(() => document.getElementById('status').textContent === 'Tracking');
    check(await page.isVisible('#angles'), 'angle panel is shown');
    if (shots) await page.screenshot({ path: path.join(shots, 'photo.png') });

    // Finger tracking can be switched on.
    await page.click('#btn-settings');
    await page.check('#opt-hands');
    if (shots) await page.screenshot({ path: path.join(shots, 'settings.png') });
    await page.click('#settings button.primary');
    await page.waitForFunction(() => window.bodyTracker.hand, null, { timeout: 30_000 });
    check(true, 'hand model loads');

    // Recording -> export.
    await page.click('#btn-record');
    await page.waitForFunction(() => !document.getElementById('rec-time').textContent.includes('0:00'), null, { timeout: 30_000 });
    await page.waitForTimeout(3000);
    await page.click('#btn-record');
    check(await page.isVisible('#export'), 'export dialog opens after recording');
    const [csvFile] = await Promise.all([page.waitForEvent('download'), page.click('#export-csv')]);
    const csv = fs.readFileSync(await csvFile.path(), 'utf8').trim().split('\n');
    check(csv.length > 5 && csv[0].startsWith('t_ms,left_shoulder_deg'), `CSV export has ${csv.length - 1} frames`);
    const [jsonFile] = await Promise.all([page.waitForEvent('download'), page.click('#export-json')]);
    const json = JSON.parse(fs.readFileSync(await jsonFile.path(), 'utf8'));
    check(json.frames.length === csv.length - 1 && json.frames[0].world.length === 33, 'JSON export matches CSV');
    await page.click('#export button.link');

    // Jump mode: settings round-trip and the on-screen prompt. (The photo's subject is in a
    // lunge, so the tracker must keep asking them to stand straight rather than arm itself.)
    await page.click('#btn-jump');
    await page.selectOption('#opt-units', 'imperial');
    await page.selectOption('#opt-jump', 'long');
    await page.fill('#opt-height-ft', '5');
    await page.fill('#opt-height-in', '10');
    await page.click('#jump-dlg button.primary');
    await page.waitForFunction(() => document.getElementById('jump-status').textContent.includes('hold still'), null, { timeout: 15_000 });
    check(await page.isVisible('#jump'), 'jump panel prompts the jumper to stand straight and still');
    const heightM = await page.evaluate(() => window.bodyTracker.jumpTracker.heightM);
    check(Math.abs(heightM - 1.778) < 0.001, 'height entered in feet and inches sets the scale');
    await page.click('#btn-jump');
    await page.selectOption('#opt-jump', 'off');
    await page.click('#jump-dlg button.primary');
    check(!(await page.isVisible('#jump')), 'jump panel hides when measuring is switched off');

    // Live camera path (Chromium's synthetic camera has no person in it).
    await page.click('#btn-camera');
    await page.waitForFunction(() => window.bodyTracker.source?.kind === 'camera' && window.bodyTracker.last, null, { timeout: 15_000 });
    await page.waitForFunction(() => window.bodyTracker.fps > 0);
    check(true, 'camera stream is processed frame by frame');
    await page.click('#btn-camera');
    check(await page.isVisible('#intro'), 'stopping the camera returns to the start screen');

    check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join('; ')}` : ''}`);
    console.log('\nAll end-to-end checks passed.');
  } finally {
    await browser.close();
    server.kill();
  }
})().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
