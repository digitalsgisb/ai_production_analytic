const CACHE_NAME = "sugi-prod-analytic-shell-v1";
const ESSENTIAL_ASSETS = [
  "/manifest.webmanifest",
  "/app-icon.svg",
  "/app-icon-180.png",
  "/app-icon-192.png",
  "/app-icon-512.png",
  "/brand/sugihara-wordmark.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    const response = await fetch("/", { cache: "reload" });
    if (response.ok) {
      await cache.put("/", response.clone());
      const html = await response.text();
      const builtAssets = [...html.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)].map((match) => match[1]);
      await cache.addAll([...ESSENTIAL_ASSETS, ...builtAssets]);
    } else {
      await cache.addAll(ESSENTIAL_ASSETS);
    }
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/") || url.pathname === "/sw.js") return;

  if (request.mode === "navigate") {
    event.respondWith(fetch(request).then(async (response) => {
      if (response.ok) {
        const cache = await caches.open(CACHE_NAME);
        await cache.put("/", response.clone());
      }
      return response;
    }).catch(() => caches.match("/")));
    return;
  }

  event.respondWith(caches.match(request).then((cached) => cached ?? fetch(request).then(async (response) => {
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, response.clone());
    }
    return response;
  })));
});
