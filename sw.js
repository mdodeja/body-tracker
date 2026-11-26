// Offline support: after the first visit the app, runtime and models are all served from cache.
const VERSION = 'v9';
const SHELL = `shell-${VERSION}`;
const HEAVY = `heavy-${VERSION}`; // wasm runtime + models: large and immutable per version

const SHELL_FILES = [
  './',
  'index.html',
  'css/style.css',
  'js/app.js',
  'js/geometry.js',
  'js/jump.js',
  'js/measure.js',
  'js/punch.js',
  'js/stance.js',
  'js/recorder.js',
  'manifest.webmanifest',
  'icon.svg',
];
const HEAVY_FILES = [
  'vendor/tasks-vision/vision_bundle.mjs',
  'vendor/tasks-vision/wasm/vision_wasm_internal.js',
  'vendor/tasks-vision/wasm/vision_wasm_internal.wasm',
  'models/pose_landmarker_lite.task',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    Promise.all([
      caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)),
      caches.open(HEAVY).then((c) => c.addAll(HEAVY_FILES)),
    ]).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== HEAVY).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin) return;
  const heavy = /\/(vendor|models)\//.test(url.pathname);
  event.respondWith(heavy ? cacheFirst(event.request) : networkFirst(event.request));
});

// Models not precached (accurate pose, hands) are cached the first time they are used.
async function cacheFirst(request) {
  const cache = await caches.open(HEAVY);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

// App code: prefer fresh, fall back to cache when offline.
async function networkFirst(request) {
  const cache = await caches.open(SHELL);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (err) {
    const hit = await cache.match(request, { ignoreSearch: true });
    if (hit) return hit;
    throw err;
  }
}
