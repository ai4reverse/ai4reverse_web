// Anti-analysis probe: timing, automation flags, analysis-farm globals,
// global escape, native-brand checks, stack inspection and devtools size.
// In a correct traceless run every finding stays empty and the probe completes.
(function () {
  var findings = [];
  var start = Date.now();
  var accumulator = 0;
  for (var i = 0; i < 50000; i += 1) accumulator += Math.sqrt(i);
  var elapsed = Date.now() - start;
  if (!(elapsed >= 0) || elapsed > 60000) findings.push('timing-anomaly');
  if (typeof navigator !== 'undefined' && navigator.webdriver) findings.push('webdriver');
  if (typeof _phantom !== 'undefined' || typeof callPhantom !== 'undefined' || typeof __nightmare !== 'undefined') {
    findings.push('honeypot');
  }
  try {
    var globalEscape = Function('return this')();
    if (globalEscape !== globalThis) findings.push('global-escape');
  } catch (error) {
    findings.push('global-escape-threw');
  }
  try {
    var brand = Function.prototype.toString.call(Function.prototype.toString);
    if (brand.indexOf('[native code]') === -1) findings.push('toString-brand');
  } catch (error) {
    findings.push('toString-threw');
  }
  try {
    null.x;
  } catch (error) {
    if (String(error.stack).indexOf('<eval>') !== -1) findings.push('eval-stack');
  }
  if (window.outerWidth - window.innerWidth > 160) findings.push('devtools');
  if (navigator.plugins.length === 0) findings.push('no-plugins');
  debugger;
  console.log('analysis findings:', findings.length === 0 ? 'none' : findings.join(','));
  try {
    document.body.setAttribute('data-probe', String(findings.length));
  } catch (error) {
    console.log('dom failed', error.message);
  }
  void accumulator;
})();
