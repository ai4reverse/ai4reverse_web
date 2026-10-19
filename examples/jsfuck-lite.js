// JSFuck-style expressions: only [], (), !, +, {} and literals. The jsfuck
// pass evaluates these shapes statically without executing the sample.
(function () {
  var zero = +[];
  var one = +!![];
  var two = one + one;
  var f = ![] + [];
  var t = !![] + [];
  var u = [][[]] + [];
  var letters = (![] + [])[one] + (![] + [])[two] + (![] + [])[one + two];
  console.log('jsfuck', f, t, u, zero, one, two, letters);
  var marker = (![] + [])[zero + two];
  console.log('marker', marker, ([] + {})[one]);
})();
