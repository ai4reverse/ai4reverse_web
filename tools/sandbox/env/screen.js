/**
 * `screen` and `window.screen.orientation`.
 * Geometry is derived from the profile so it agrees with devicePixelRatio,
 * innerWidth/innerHeight and the UA's claimed device class.
 */

export const meta = { id: 'screen', order: 45, requires: ['globals'] }

export function install(bridge) {
  const { ctx, profile } = bridge
  const screen = bridge.obj()

  for (const [key, value] of Object.entries({
    width: profile.screen.width,
    height: profile.screen.height,
    availWidth: profile.screen.availWidth,
    availHeight: profile.screen.availHeight,
    colorDepth: profile.screen.colorDepth,
    pixelDepth: profile.screen.pixelDepth,
    availLeft: 0,
    availTop: 0,
    isExtended: false,
  })) {
    bridge.install(screen, key, value, { enumerable: true, configurable: true, writable: false })
  }

  const orientation = bridge.obj({
    type: profile.screen.height > profile.screen.width ? 'portrait-primary' : 'landscape-primary',
    angle: 0,
    onchange: null,
  })
  bridge.install(orientation, 'lock', bridge.fn('lock', 1, () => {
    const error = new Error('screen.orientation.lock() is not available on this device.')
    error.name = 'NotSupportedError'
    throw error
  }), { enumerable: true, configurable: true, writable: true })
  bridge.install(orientation, 'unlock', bridge.fn('unlock', 0, () => ctx.undefined), {
    enumerable: true,
    configurable: true,
    writable: true,
  })
  for (const name of ['addEventListener', 'removeEventListener', 'dispatchEvent']) {
    bridge.install(orientation, name, bridge.fn(name, name === 'dispatchEvent' ? 1 : 2, () => ctx.true), {
      enumerable: true,
      configurable: true,
      writable: true,
    })
  }
  bridge.install(screen, 'orientation', orientation, { enumerable: true, configurable: true, writable: false })

  bridge.install(bridge.global, 'screen', screen, { enumerable: true, configurable: true, writable: false })
  bridge.install(bridge.global, 'devicePixelRatio', profile.screen.devicePixelRatio, {
    enumerable: true,
    configurable: true,
    writable: false,
  })
}
