/**
 * `window.chrome`: the Chromium browser/extension surface.
 *
 * Every headless probe of the last decade starts with `if (!window.chrome ||
 * !window.chrome.runtime)`: Firefox genuinely has no `window.chrome`, while a
 * Chromium build always exposes it on a normal page. The object is therefore
 * installed only for profiles whose `bridge.profile.chrome` record exists, so a
 * claimed Firefox profile cannot answer with a Chromium-only global.
 *
 * `chrome.csi()` / `chrome.loadTimes()` are timing fingerprints: they report
 * host time in a real browser, so they are derived from the virtual clock here
 * and stay internally consistent with `performance.now()`.
 */

export const meta = { id: 'chrome', order: 115, requires: ['navigator'] }

/**
 * Install `window.chrome` for profiles that claim a Chromium build.
 * @param {object} bridge host bridge
 */
export function install(bridge) {
  const { ctx, clock, profile } = bridge
  if (!profile.chrome) return

  const chrome = bridge.obj()
  const property = (target, key, value, flags = {}) =>
    bridge.install(target, key, value, { enumerable: true, configurable: true, writable: true, ...flags })

  // `runtime` is the property headless detectors look for first.
  const runtime = bridge.obj()
  property(runtime, 'id', ctx.undefined, { writable: false })
  property(
    runtime,
    'connect',
    bridge.fn('connect', 1, ({ args }) => {
      bridge.emit('api', 'before', { api: 'chrome.runtime.connect', extensionId: bridge.str(args, 0) })
      return ctx.undefined
    }),
  )
  property(
    runtime,
    'sendMessage',
    bridge.fn('sendMessage', 1, ({ args }) => {
      bridge.emit('api', 'before', { api: 'chrome.runtime.sendMessage', message: bridge.fromGuest(args[0]) })
      return ctx.undefined
    }),
  )
  property(chrome, 'runtime', runtime)

  const app = bridge.obj({
    isInstalled: profile.chrome.app.isInstalled,
    InstallState: { NOT_INSTALLED: 'not_installed', INSTALLED: 'installed', DISABLED: 'disabled' },
    RunningState: { RUNNING: 'running', CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run' },
  })
  property(app, 'getDetails', bridge.fn('getDetails', 0, () => bridge.obj({})))
  property(app, 'getIsInstalled', bridge.fn('getIsInstalled', 0, () => ctx.false))
  property(chrome, 'app', app)

  // `chrome.csi()` predates the Performance API and is still probed as a
  // Chromium tell. Values are seconds since the epoch / milliseconds since
  // navigation start, both from the virtual clock.
  const timeOriginSeconds = clock.timeOrigin / 1000
  property(
    chrome,
    'csi',
    bridge.fn('csi', 0, () => {
      bridge.emit('api', 'before', { api: 'chrome.csi' })
      return bridge.obj({
        onloadT: 0,
        startE: timeOriginSeconds,
        pageT: clock.performanceNow(),
        tran: 15,
      })
    }),
  )

  property(
    chrome,
    'loadTimes',
    bridge.fn('loadTimes', 0, () => {
      bridge.emit('api', 'before', { api: 'chrome.loadTimes' })
      const commit = timeOriginSeconds + 0.042
      return bridge.obj({
        requestTime: timeOriginSeconds,
        startLoadTime: timeOriginSeconds,
        commitLoadTime: commit,
        finishDocumentLoadTime: commit + 0.081,
        finishLoadTime: commit + 0.165,
        firstPaintTime: commit + 0.094,
        firstPaintAfterLoadTime: 0,
        navigationType: 'Other',
        wasFetchedViaSpdy: true,
        wasNpnNegotiated: true,
        protocolInfo: 'h2',
        connectionInfo: 'h2',
      })
    }),
  )

  bridge.install(bridge.global, 'chrome', chrome, { enumerable: true, configurable: true, writable: true })
}
