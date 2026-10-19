// Environment fingerprint dump: every value must be internally coherent with
// the seeded profile (UA/platform/screen/timezone/Intl/WebGL/canvas/audio).
(function () {
  function safe(fn, fallback) {
    try {
      return fn();
    } catch (error) {
      return fallback === undefined ? 'error:' + error.message : fallback;
    }
  }
  var canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 32;
  var context = canvas.getContext('2d');
  context.fillStyle = '#123456';
  context.fillRect(0, 0, 32, 32);
  context.fillText('fp', 2, 12);
  var gl = canvas.getContext('webgl');
  var debugInfo = gl && gl.getExtension('WEBGL_debug_renderer_info');
  var audio = safe(function () {
    var ctx = new AudioContext();
    return { sampleRate: ctx.sampleRate, state: ctx.state };
  }, null);
  var report = {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    language: navigator.language,
    timezone: safe(function () {
      return Intl.DateTimeFormat().resolvedOptions().timeZone;
    }),
    offset: new Date().getTimezoneOffset(),
    localTime: new Date(1792394400000).toString(),
    screen: [screen.width, screen.height, devicePixelRatio],
    hardwareConcurrency: navigator.hardwareConcurrency,
    plugins: navigator.plugins.length,
    webdriver: navigator.webdriver,
    webglRenderer: gl ? gl.getParameter(gl.RENDERER) : null,
    webglUnmasked: debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : null,
    canvasHash: canvas.toDataURL('image/png').slice(0, 64),
    audio: audio,
    fonts: safe(function () {
      return document.fonts.check('12px Arial');
    })
  };
  console.log('fingerprint', JSON.stringify(report));
})();
