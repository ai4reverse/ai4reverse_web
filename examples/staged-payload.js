// Function-constructor dropper: the base64 body is decoded at runtime and
// compiled with `Function`, then invoked. The code/exception instrumentation
// records the constructor call site and the decoded body.
(function () {
  var encoded = 'cmV0dXJuIGF0b2IoJ2MzUmhaMlV0TWkxMllXeDFaUT09Jyk=';
  var body = atob(encoded);
  console.log('decoded function body', body);
  var stage2 = Function(body)();
  console.log('stage-2 returned', stage2);
  try {
    localStorage.setItem('stage2', String(stage2));
  } catch (error) {
    console.log('storage failed', error.message);
  }
})();
