/**
 * sw.js – Service Worker
 * ------------------------------------------------------------------
 * - App-Dateien werden beim Installieren zwischengespeichert, damit die
 *   App sofort und auch ohne Netz startet (z. B. im Supermarkt-Funkloch).
 * - Eigene Dateien: "Netzwerk zuerst, sonst Cache" → Updates kommen
 *   sofort an, offline läuft trotzdem alles.
 * - Firebase-SDK (gstatic.com): "Cache zuerst" (versionierte URLs).
 * - Firestore-Datenverkehr selbst wird NICHT angefasst – den Offline-
 *   Abgleich übernimmt Firebase.
 *
 * Bei Änderungen an der App: CACHE_VERSION hochzählen.
 * ------------------------------------------------------------------
 */

const CACHE_VERSION = 'v15';
const APP_CACHE = `einkauf-app-${CACHE_VERSION}`;
const CDN_CACHE = 'einkauf-cdn-v1';

const APP_SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './categories.js',
  './config.js',
  './wissen.js',
  './rezeptformat.js',
  './manifest.json',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];

const FIREBASE_VERSION = '10.12.2';
const CDN_FILES = [
  `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-app.js`,
  `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-firestore.js`,
  `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-auth.js`
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const appCache = await caches.open(APP_CACHE);
    await appCache.addAll(APP_SHELL);
    // CDN-Dateien: Fehler hier dürfen die Installation nicht verhindern
    try {
      const cdnCache = await caches.open(CDN_CACHE);
      await cdnCache.addAll(CDN_FILES);
    } catch (err) {
      console.warn('[SW] Firebase-SDK konnte nicht vorgeladen werden:', err);
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((key) => key.startsWith('einkauf-') && key !== APP_CACHE && key !== CDN_CACHE)
        .map((key) => caches.delete(key))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Firebase-SDK von gstatic: Cache zuerst
  if (url.hostname === 'www.gstatic.com' && url.pathname.startsWith('/firebasejs/')) {
    event.respondWith(cacheFirst(request, CDN_CACHE));
    return;
  }

  // Schrift (Google Fonts): Cache zuerst
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(cacheFirst(request, CDN_CACHE));
    return;
  }

  // Nur eigene Dateien behandeln (Firestore, Prospekt-Seiten usw. nicht)
  if (url.origin !== self.location.origin) return;

  event.respondWith(networkFirst(request));
});

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

const NETWORK_TIMEOUT_MS = 3000;

async function networkFirst(request) {
  const cache = await caches.open(APP_CACHE);
  // no-cache: nie eine veraltete Seite aus dem Browser-Zwischenspeicher nehmen,
  // sonst passen nach einem Update Seite und Programmcode nicht zusammen
  const network = fetch(request, { cache: 'no-cache' }).then((response) => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  });
  network.catch(() => {}); // Fehler wird unten behandelt
  try {
    // Bei schlechtem Empfang nicht ewig warten: nach 3 s Cache nutzen
    const timeout = new Promise((resolve) => {
      setTimeout(async () => resolve(await cache.match(request, { ignoreSearch: true })), NETWORK_TIMEOUT_MS);
    });
    const response = await Promise.race([network, timeout.then((cached) => cached || network)]);
    return response;
  } catch (err) {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    // Navigation offline → App-Startseite
    if (request.mode === 'navigate') {
      const shell = await cache.match('./index.html');
      if (shell) return shell;
    }
    throw err;
  }
}
