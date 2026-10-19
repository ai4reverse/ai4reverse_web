// Control-flow flattening: a switch over an order string drives execution.
// The control-flow pass should restore the sequential statements.
(function () {
  var order = '3|1|0|2'.split('|'), index = 0;
  var state = { a: 0, b: 0, ready: false };
  while (true) {
    switch (order[index++]) {
      case '0':
        state.a = 6;
        continue;
      case '1':
        state.b = 7;
        continue;
      case '2':
        console.log('product', state.a * state.b, 'ready', state.ready);
        continue;
      case '3':
        state.ready = true;
        console.log('start');
        continue;
    }
    break;
  }
  if (false) {
    console.log('unreachable branch');
  }
})();
