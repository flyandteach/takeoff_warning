const CACHE_NAME = "takeoff-pwa-v1";
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.webmanifest",
  "./data/runways.json"
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(ASSETS);
    self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => k !== CACHE_NAME ? caches.delete(k) : null));
    self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // Network-first for METAR requests; cache-first for local assets
  if (url.hostname.includes("aviationweather.gov") || url.hostname.includes("flyandteach.workers.dev")) {
    event.respondWith((async () => {
      try {
        const resp = await fetch(event.request);
        return resp;
      } catch (e) {
        return new Response(JSON.stringify({error:"offline"}), { headers: {"Content-Type":"application/json"} });
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(event.request);
    if (cached) return cached;
    const resp = await fetch(event.request);
    cache.put(event.request, resp.clone());
    return resp;
  })());
});
