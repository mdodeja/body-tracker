# Body Tracker

A phone web app that uses the camera to track your body in real time: 33 body
joints, optional finger tracking (21 points per hand), and live joint angles.

The model runs **entirely on the phone**. Video frames are never uploaded; after
the first visit the app also works with no internet connection at all.

## What it does

- Live skeleton overlay from the front or back camera (left side teal, right side orange)
- Joint angles in degrees for shoulders, elbows, wrists, hips, knees and ankles,
  computed from 3D joint positions so they hold up when you are not square to the camera
- Optional finger tracking
- Record a session and download it as CSV (angles + 3D joint positions per frame) or JSON (everything)
- Analyse an existing video or photo instead of the live camera
- Installable to the home screen; works offline

## Using it on your phone

Browsers only allow camera access on HTTPS pages, so the app has to be served
from an HTTPS address.

**GitHub Pages (simplest).** In the repository go to *Settings → Pages*, set
*Source* to *Deploy from a branch*, and pick `main` and `/ (root)`. A minute or
two later the app is at `https://<user>.github.io/body-tracker/`; open that
address on the phone. Note that a Pages site is public even if the repository is
private (it contains only the app, never your data).

Then, on the phone: open the address, tap **Start camera**, allow camera access,
and prop the phone up so your whole body is in view. Use *Share → Add to Home
Screen* (iOS) or *Install app* (Android) to get an app icon and offline use.

## Running it on a computer

```sh
npm start            # http://localhost:8080 (camera works on localhost)
npm test             # unit tests for the angle maths and export format
npm run test:e2e     # browser test; needs Playwright with Chromium installed
```

There is no build step and there are no runtime dependencies.

## How it works

| Piece | What it is |
| --- | --- |
| `models/pose_landmarker_{lite,full}.task` | Google's BlazePose model ("Fast" / "Accurate" in Settings) |
| `models/hand_landmarker.task` | Hand model, loaded only when finger tracking is on |
| `vendor/tasks-vision/` | MediaPipe Tasks Vision 1.2.3 runtime (WebAssembly + WebGL) |
| `js/app.js` | Camera, frame loop, drawing, UI |
| `js/geometry.js` | Landmark names and joint-angle maths |
| `js/recorder.js` | Recording and CSV/JSON export |
| `sw.js` | Service worker that caches the app and models for offline use |

The models are pre-trained; nothing here trains or fine-tunes one. It tries the
phone's GPU first and falls back to CPU automatically.

### Recorded data

- `landmarks`: position in the image, `x`/`y` from 0 to 1
- `world`: 3D position in metres, with the origin midway between the hips
- `angles`: degrees, 180 = fully straight; blank when the joint is not clearly visible
- "left" and "right" always mean *your* left and right

## Limits to know about

- Tracks one person at a time.
- Depth (`z`) is estimated from a single camera, so it is less accurate than `x`/`y`.
  Angles are most reliable when the limb is side-on to the camera.
- Joints hidden behind your body are guessed and are dropped from the angle readout.
- This is not a medical device.

## Licences

MediaPipe and its models are © Google, licensed under Apache 2.0.
