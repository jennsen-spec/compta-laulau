// Service worker : permet d'installer l'app et de l'ouvrir même sans réseau
// (la lecture des factures, elle, a besoin d'internet).
// Change CACHE à chaque nouvelle version pour forcer la mise à jour sur le téléphone.
const CACHE = "compta-v0.2.0";
const ASSETS = ["./", "index.html", "app.js", "drive.js", "style.css", "manifest.webmanifest", "icons/icon-192.png"];
// Appels qui ne doivent jamais passer par le cache (API, connexion Google).
const NO_CACHE = ["api.anthropic.com", "googleapis.com", "accounts.google.com"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) =>
    Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

// Réseau d'abord (pour avoir les mises à jour), cache en secours.
// Les appels à l'API Anthropic ne passent jamais par le cache.
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET" || NO_CACHE.some((h) => e.request.url.includes(h))) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request)),
  );
});
