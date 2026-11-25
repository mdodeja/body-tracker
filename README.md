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
- **Jump measurement**: high jump (how far you rise off the ground) and long jump
  (take-off toe to landing heel), read out loud after each jump
- **Sprint timing**: start and finish lines a set distance apart, drawn on screen;
  gives your time, average speed and top speed
- **Distance between two spots**: stand on one, then the other
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
| `js/stance.js` | Standing-still detection: floor line and image scale |
| `js/jump.js` | Jump detection and measurement |
| `js/measure.js` | Sprint timing and distance between two spots |
| `js/recorder.js` | Recording and CSV/JSON export |
| `sw.js` | Service worker that caches the app and models for offline use |

The models are pre-trained; nothing here trains or fine-tunes one. It tries the
phone's GPU first and falls back to CPU automatically.

### Recorded data

- `landmarks`: position in the image, `x`/`y` from 0 to 1
- `world`: 3D position in metres, with the origin midway between the hips
- `angles`: degrees, 180 = fully straight; blank when the joint is not clearly visible
- "left" and "right" always mean *your* left and right

## Measuring jumps

Tap **Jump**, choose *High jump* or *Long jump*, and enter your height — that is
what converts pixels into real distances, so it needs to be right.

1. Prop the phone up so it does not move, with your whole body in view (feet included).
   For a long jump, put it side-on so you travel across the screen and both the
   take-off and landing spots are in view.
2. Stand up straight and still for about a second. The app says "Ready" once it has
   found the floor line and your standing height.
3. Jump. The result is shown, spoken, and saved to the history in the Jump dialog.
   You also get the time in the air, the peak height and when it was reached, and a
   graph of the jump's arc; the same arc is drawn over the video where you jumped.

You can jump again straight away — there is no need to reset or stand still between
jumps. The floor line follows your feet, so landing a step nearer to or farther from
the phone does not throw off the next jump. Standing still again simply refreshes
the scale.

The phone has to stay put while measuring. If it is moved or knocked, the app says
"Hold the phone still" and ignores what it sees until it settles (it uses the phone's
motion sensor for this — an iPhone asks permission the first time). As a second line of
defence, something only counts as a jump if the hips trace the arc gravity would give.

For a long jump with a run-up, stand still at the take-off spot first, then walk back
and run; the floor line and scale are kept until you next stand still.

How the numbers are worked out:

- **High jump** is how far your hips rise above their standing height. This matches a
  jump-and-reach test; it is higher than "air time" methods, which start counting only
  once your toes leave the ground.
- **Long jump** is the horizontal distance from the front of the planted foot at
  take-off to the rear-most part of your feet at landing.
- Take-off and landing are the moments your feet clear, and return to, the floor line.

For a high jump the panel also shows the standard jump-test numbers:

| Metric | Meaning |
| --- | --- |
| Air time | Take-off to landing |
| Flight height | Height worked out from air time (g·t²/8) — the convention used by force plates and jump mats. Lower than the headline, which also counts rising onto your toes |
| Take-off | Speed leaving the floor (g·t/2) |
| Push-off | Lowest point of the dip to take-off (the "concentric" phase). Shown only if you dipped at least 5 cm |
| RSI-mod | Flight height ÷ time from the start of the dip to take-off |
| Peak power | Sayers estimate from flight height and body weight. Shown only if you entered your weight |

Expect accuracy of a few centimetres for height and several centimetres for distance at
30 frames per second. The biggest sources of error are a wrong height, a tilted phone,
and jumping toward or away from the camera instead of across it. It measures how high
*you* go, not the height of a bar you clear.

## Timing a sprint

Tap **Measure**, choose *Sprint*, and set the distance (5 m by default). Turn the
phone on its side and put it far enough back that the whole run fits across the
screen — roughly 6 m away for a 5 m sprint.

1. Stand up straight and still where you want to start. The app says "Set" and draws
   a green START line through you and a yellow FINISH line the chosen distance away,
   toward whichever side has more room. If it says the finish line is out of view,
   move the phone back or shorten the distance.
2. Run. From a standing start the clock starts when you actually set off (leaning
   forward and waiting does not start it); if you walk back and run through the
   start line, it starts as you cross the line. It stops as your hips cross FINISH.
3. You get the time, average speed and top speed. Walk back to the start for another
   go, or stand still for 3 seconds anywhere to move the start line there.

At 30 frames per second each line crossing is known to about a frame, so expect the
time for a one-second sprint to be within a few percent. Top speed is the fastest
0.3-second stretch.

## Measuring a distance

Choose *Distance between two spots*. Stand still on one spot until you hear "Marked",
walk to the other and stand still again: the distance between them (midpoint of your
feet to midpoint of your feet) is shown and spoken. This is the quickest way to check
the scale against a tape measure — if a taped 1 m reads as 1 m, the jump and sprint
figures can be trusted to the same degree.

## Limits to know about

- Tracks one person at a time.
- Depth (`z`) is estimated from a single camera, so it is less accurate than `x`/`y`.
  Angles are most reliable when the limb is side-on to the camera.
- Joints hidden behind your body are guessed and are dropped from the angle readout.
- This is not a medical device.

## Licences

MediaPipe and its models are © Google, licensed under Apache 2.0.
