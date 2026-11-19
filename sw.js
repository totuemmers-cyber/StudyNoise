// StudyNoise service worker — keeps a copy of the app's few files so it opens
// without a connection (and can be installed to the home screen).
//
// Network first: while online every request goes to the network and refreshes
// the stored copy, so a newly published version shows up on the next load just
// as it would without a service worker. The stored copy is only served when the
// network fails, or takes longer than a few seconds to answer.

const CACHE = "studynoise-v1";
const NETWORK_TIMEOUT_MS = 3000;
const FILES = [
  "./",
  "index.html",
  "style.css",
  "noise-dsp.js",
  "noise-worklet.js",
  "noise.js",
  "stars.js",
  "manifest.webmanifest",
  "icons/icon.svg",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png",
  "icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  if (new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    caches.open(CACHE).then((cache) =>
      cache.match(request, { ignoreSearch: true }).then((stored) => {
        const network = fetch(request).then((response) => {
          if (response.ok) cache.put(request, response.clone()).catch(() => {});
          return response;
        });
        if (!stored) return network;
        const timeout = new Promise((resolve) =>
          setTimeout(() => resolve(stored), NETWORK_TIMEOUT_MS)
        );
        return Promise.race([network.catch(() => stored), timeout]);
      })
    )
  );
});
