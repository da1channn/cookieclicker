/*
	sw.js — offline support for the iOS home screen web app.
	- code (html/js/css/manifest/loc): network first, cache fallback -> updates show up on next launch
	- assets (img/snd/fonts): cache first, filled on use -> no 23MB precache
	- other origins: untouched
	Saves live in localStorage and are never touched by this worker.
*/
var VERSION='cc-ios-v1';
var CORE=[
	'./',
	'index.html',
	'main.js',
	'ios-fixes.js',
	'ios-fixes.css',
	'base64.js',
	'minigameGarden.js',
	'minigameGrimoire.js',
	'minigameMarket.js',
	'minigamePantheon.js',
	'loc/EN.js',
	'manifest.webmanifest'
];

self.addEventListener('install',function(e){
	e.waitUntil(caches.open(VERSION).then(function(c){
		//one failing file must not block installation
		return Promise.all(CORE.map(function(u){return c.add(u).catch(function(){});}));
	}).then(function(){return self.skipWaiting();}));
});

self.addEventListener('activate',function(e){
	e.waitUntil(caches.keys().then(function(keys){
		return Promise.all(keys.filter(function(k){return k.indexOf('cc-ios-')===0 && k!==VERSION;}).map(function(k){return caches.delete(k);}));
	}).then(function(){return self.clients.claim();}));
});

//the page reports what it loaded before this worker took control (first launch), so the
//next launch also works offline
self.addEventListener('message',function(e){
	var d=e.data||{};
	if (d.type!=='cache-urls' || !Array.isArray(d.urls)) return;
	var p=caches.open(VERSION).then(function(c){
		return Promise.all(d.urls.slice(0,600).map(function(u){
			var url;
			try {url=new URL(u,self.location.href);} catch(err){return null;}
			if (url.origin!==self.location.origin) return null;
			var key=isAsset(url)?url.href:url.origin+url.pathname;
			return c.match(key).then(function(hit){
				if (hit) return null;
				return fetch(url.href).then(function(res){if (res.ok && res.status===200) return c.put(key,res);}).catch(function(){});
			});
		}));
	});
	if (e.waitUntil) e.waitUntil(p);
});

var isAsset=function(url){return /\/(img|snd|fonts)\//.test(url.pathname);};

self.addEventListener('fetch',function(e){
	var req=e.request;
	if (req.method!=='GET') return;
	var url=new URL(req.url);
	if (url.origin!==self.location.origin) return;
	if (req.headers.has('range')) return;//media range requests: let the browser handle them

	if (isAsset(url))
	{
		e.respondWith(caches.open(VERSION).then(function(c){
			return c.match(req).then(function(hit){
				if (hit) return hit;
				return fetch(req).then(function(res){
					if (res.ok && res.status===200) c.put(req,res.clone());
					return res;
				});
			});
		}));
		return;
	}

	//code is cached under its bare path: ?v=... and ?nocache=<timestamp> must not create new entries
	var key=url.origin+url.pathname;
	e.respondWith(fetch(req).then(function(res){
		if (res.ok && res.status===200)
		{
			var copy=res.clone();
			caches.open(VERSION).then(function(c){c.put(key,copy);});
		}
		return res;
	}).catch(function(){
		return caches.match(key).then(function(hit){
			if (hit) return hit;
			if (req.mode==='navigate') return caches.match('index.html').then(function(h){return h||caches.match('./');});
			return Response.error();
		});
	}));
});
