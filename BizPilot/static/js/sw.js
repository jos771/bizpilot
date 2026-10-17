// BizPilot service worker: makes the app open and work with no internet.
// The app files are stored on the device. Records live in the browser's own database, so recording
// sales never needs this file or the network. API calls and the admin pages are never cached.
const VERSION = "bizpilot-v5";
const SHELL = [
  "/app",
  "/static/app.css",
  "/static/js/core.js",
  "/static/js/ui.js",
  "/static/img/favicon.svg",
  "/static/img/icon-192.png",
  "/static/img/icon-512.png",
  "/static/img/apple-touch-icon.png",
  "/static/img/bg-hero.svg",
  "/static/img/bg-barber.svg",
  "/static/img/bg-print.svg",
  "/static/img/bg-general.svg",
  "/manifest.webmanifest",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(VERSION)
      .then((cache) => Promise.all(SHELL.map((url) => cache.add(url).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Serve the saved copy straight away, and refresh it in the background for next time.
async function staleWhileRevalidate(cacheKey, fetchInput) {
  const cache = await caches.open(VERSION);
  const cached = await cache.match(cacheKey);
  const refresh = fetch(fetchInput, { cache: "no-cache" })
    .then((res) => { if (res && res.ok) cache.put(cacheKey, res.clone()); return res; })
    .catch(() => null);
  if (cached) return cached;
  const res = await refresh;
  return res || new Response("You are offline and this page has not been saved yet.", { status: 503, headers: { "Content-Type": "text/plain" } });
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const path = url.pathname;
  if (path.startsWith("/api/") || path.startsWith("/admin")) return;

  if (req.mode === "navigate") {
    if (path === "/app" || path === "/app/") {
      event.respondWith(staleWhileRevalidate("/app", "/app"));
      return;
    }
    event.respondWith(fetch(req).catch(() => caches.match(req).then((r) => r || caches.match("/app"))));
    return;
  }
  if (path.startsWith("/static/") || path === "/manifest.webmanifest") {
    event.respondWith(staleWhileRevalidate(req, req));
  }
});
