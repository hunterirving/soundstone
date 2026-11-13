// Keeps an installed copy of soundstone working when the server it came from
// cannot be reached, which is the usual case for an install from a local network.

const CACHE_NAME = 'soundstone';
const FILES = ['./', 'resources/style.css', 'resources/main.js', 'resources/deck.js', 'manifest.json', 'resources/favicon.svg', 'resources/icon.png'];

self.addEventListener('install', event => {
	self.skipWaiting();
	event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(FILES)));
});

self.addEventListener('activate', event => {
	event.waitUntil(self.clients.claim());
});

// Answers from the cache immediately, and refreshes the cache from the network in
// the background. A change on the server therefore shows up on the second launch.
self.addEventListener('fetch', event => {
	if (event.request.method !== 'GET') return;
	event.respondWith(caches.open(CACHE_NAME).then(async cache => {
		const cached = await cache.match(event.request);
		const fresh = fetch(event.request).then(response => {
			if (response.ok) cache.put(event.request, response.clone());
			return response;
		});
		if (!cached) return fresh;
		event.waitUntil(fresh.catch(() => {}));
		return cached;
	}));
});
