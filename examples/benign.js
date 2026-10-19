// Benign control sample: no eval, no network, no obfuscation.
(function () {
  var total = 0;
  for (var i = 1; i <= 10; i += 1) total += i;
  console.log('sum', total);
  if (total === 55) console.log('ok');
})();
