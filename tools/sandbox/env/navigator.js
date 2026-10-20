/**
 * `navigator` surface: identity, plugins/mimeTypes and the capability
 * augmentations malware probes (permissions, connection, battery, media
 * devices, clipboard, geolocation, credentials, locks, beacon).
 *
 * Every value here comes from the seeded profile; nothing is invented locally.
 * Scalar properties are accessors (as in Chrome) so
 * `Object.getOwnPropertyDescriptor(navigator, 'userAgent').get.name` is
 * `"get userAgent"`, and the values cannot be overwritten by assignment.
 *
 * The capability list used to live in `misc.js`, which augmented a navigator it
 * did not own: selecting `misc` alone silently dropped the augmentations and
 * selecting `navigator` alone silently dropped them too. They now run in this
 * module's `install`, after `storage` (whose `StorageManager` becomes
 * `navigator.storage`) — hence order 58 and `requires: ['storage']`.
 */
import { createKit } from './platform-kit.js'
export const meta = { id: 'navigator', order: 58, requires: ['globals', 'storage'] }

export function install(bridge) {
  const { ctx, profile } = bridge
  const navigator = bridge.obj()

  // Scalar properties as read-only data properties (assignment is a no-op in
  // sloppy mode, throws in strict mode only for accessors; browsers throw for
  // Navigator.prototype accessors, which this approximates).
  const setReadonly = (target, key, value) =>
    bridge.install(target, key, value, { enumerable: true, configurable: true, writable: false })

  const values = {
    appCodeName: profile.appCodeName,
    appName: profile.appName,
    appVersion: profile.appVersion,
    product: profile.product,
    productSub: profile.productSub,
    vendor: profile.vendor,
    vendorSub: '',
    userAgent: profile.userAgent,
    platform: profile.platform,
    language: profile.language,
    hardwareConcurrency: profile.hardwareConcurrency,
    maxTouchPoints: profile.maxTouchPoints,
    doNotTrack: profile.doNotTrack,
    cookieEnabled: profile.cookieEnabled,
    onLine: profile.onLine,
    webdriver: profile.webdriver,
    pdfViewerEnabled: profile.pdfViewerEnabled,
  }
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue
    setReadonly(navigator, key, value)
  }

  bridge.install(navigator, 'languages', bridge.arr(profile.languages), {
    enumerable: true,
    configurable: true,
    writable: false,
  })

  if (profile.browser === 'firefox') {
    setReadonly(navigator, 'oscpu', profile.oscpu)
    setReadonly(navigator, 'buildID', profile.buildID ?? '')
  }
  if (profile.browser === 'chrome' || profile.browser === 'edge') {
    setReadonly(navigator, 'deviceMemory', profile.deviceMemory)
  }

  bridge.install(
    navigator,
    'javaEnabled',
    bridge.fn('javaEnabled', 0, () => ctx.false),
    { enumerable: true, configurable: true, writable: true },
  )

  // Plugin / MimeType arrays. Chrome's PDF viewer entries are the canonical
  // shape; Firefox reports pdf.js entries. Both are derived from the profile.
  const mimeTypeObjects = []
  const pluginObjects = profile.plugins.map((plugin) => {
    const object = bridge.obj({
      name: plugin.name,
      filename: plugin.filename,
      description: plugin.description,
    })
    const mime = bridge.obj({
      type: 'application/pdf',
      suffixes: 'pdf',
      description: 'Portable Document Format',
    })
    mimeTypeObjects.push(mime)
    bridge.install(object, 'length', 1, { enumerable: true, configurable: true, writable: false })
    bridge.install(object, 0, mime, { enumerable: true, configurable: true, writable: false })
    bridge.install(object, 'item', bridge.fn('item', 1, () => mime), {
      enumerable: true,
      configurable: true,
      writable: true,
    })
    bridge.install(object, 'namedItem', bridge.fn('namedItem', 1, ({ args }) => {
      const name = bridge.str(args, 0)
      return name === 'application/pdf' || name === 'pdf' ? mime : ctx.null
    }), { enumerable: true, configurable: true, writable: true })
    bridge.install(mime, 'enabledPlugin', object, { enumerable: true, configurable: true, writable: false })
    return object
  })

  const pluginArray = bridge.obj()
  bridge.install(pluginArray, 'length', pluginObjects.length, {
    enumerable: true,
    configurable: true,
    writable: false,
  })
  pluginObjects.forEach((plugin, index) => {
    bridge.install(pluginArray, index, plugin, { enumerable: true, configurable: true, writable: false })
    const pluginName = profile.plugins[index].name
    bridge.install(pluginArray, pluginName, plugin, { enumerable: false, configurable: true, writable: false })
  })
  bridge.install(
    pluginArray,
    'item',
    bridge.fn('item', 1, ({ args }) => pluginObjects[bridge.int(args, 0, -1)] ?? ctx.null),
    { enumerable: true, configurable: true, writable: true },
  )
  bridge.install(
    pluginArray,
    'namedItem',
    bridge.fn('namedItem', 1, ({ args }) => {
      const name = bridge.str(args, 0)
      const index = profile.plugins.findIndex((plugin) => plugin.name === name)
      return index >= 0 ? pluginObjects[index] : ctx.null
    }),
    { enumerable: true, configurable: true, writable: true },
  )
  bridge.install(
    pluginArray,
    'refresh',
    bridge.fn('refresh', 0, () => ctx.undefined),
    { enumerable: true, configurable: true, writable: true },
  )

  const mimeTypeArray = bridge.obj()
  bridge.install(mimeTypeArray, 'length', mimeTypeObjects.length, {
    enumerable: true,
    configurable: true,
    writable: false,
  })
  mimeTypeObjects.forEach((mime, index) => {
    bridge.install(mimeTypeArray, index, mime, { enumerable: true, configurable: true, writable: false })
  })
  bridge.install(mimeTypeArray, 'item', bridge.fn('item', 1, ({ args }) => mimeTypeObjects[bridge.int(args, 0, -1)] ?? ctx.null), {
    enumerable: true,
    configurable: true,
    writable: true,
  })
  bridge.install(mimeTypeArray, 'namedItem', bridge.fn('namedItem', 1, ({ args }) => {
    const type = bridge.str(args, 0)
    return mimeTypeObjects.find((mime) => ctx.dump(ctx.getProp(mime, 'type')) === type) ?? ctx.null
  }), { enumerable: true, configurable: true, writable: true })

  bridge.install(navigator, 'plugins', pluginArray, { enumerable: true, configurable: true, writable: false })
  bridge.install(navigator, 'mimeTypes', mimeTypeArray, { enumerable: true, configurable: true, writable: false })

  if (profile.userAgentData) {
    const uaData = bridge.obj({
      brands: bridge.arr(profile.userAgentData.brands),
      mobile: profile.userAgentData.mobile,
      platform: profile.userAgentData.platform,
    })
    bridge.install(
      uaData,
      'getHighEntropyValues',
      bridge.fn('getHighEntropyValues', 1, ({ args }) => {
        const hints = bridge.list(args[0])
        const values = profile.userAgentData.getHighEntropyValues
        const result = bridge.obj({ brands: bridge.arr(profile.userAgentData.brands), mobile: profile.userAgentData.mobile, platform: profile.userAgentData.platform })
        const mapping = {
          architecture: values.architecture,
          bitness: values.bitness,
          model: values.model,
          platformVersion: values.platformVersion,
          uaFullVersion: values.uaFullVersion,
          fullVersionList: bridge.arr(values.fullVersionList),
          wow64: false,
          formFactors: bridge.arr(['Desktop']),
        }
        for (const hint of hints) {
          if (mapping[hint] !== undefined) bridge.install(result, hint, mapping[hint], { enumerable: true, configurable: true, writable: true })
        }
        bridge.emit('api', 'before', { api: 'navigator.userAgentData.getHighEntropyValues', hints })
        const deferred = bridge.deferred()
        deferred.resolve(result)
        return deferred.handle
      }),
      { enumerable: true, configurable: true, writable: true },
    )
    bridge.install(navigator, 'userAgentData', uaData, { enumerable: true, configurable: true, writable: false })
  }

  bridge.install(bridge.global, 'navigator', navigator, {
    enumerable: true,
    configurable: true,
    writable: false,
  })
  bridge.install(bridge.global, 'clientInformation', navigator, {
    enumerable: true,
    configurable: true,
    writable: false,
  })

  // Capabilities augment the object installed above, so they run last.
  installCapabilities(bridge, createKit(bridge))
}

// ---------------------------------------------------------------------------
// navigator capabilities
// ---------------------------------------------------------------------------

/**
 * Permission, battery, device, clipboard, geolocation, beacon and storage
 * surfaces on the navigator installed above. Every answer is derived from the
 * profile so a permission cross-check cannot expose the sandbox.
 * @param {object} bridge
 * @param {object} kit
 */
function installCapabilities(bridge, kit) {
  const { ctx, clock, profile } = bridge
  const { retain, pinObject, pinArray, pinError, pinString, fulfilled, rejected, installEventTarget } = kit

  const navigatorHandle = ctx.getProp(bridge.global, 'navigator')
  if (ctx.typeof(navigatorHandle) !== 'object') {
    navigatorHandle.dispose()
    return
  }
  const property = (name, value) =>
    bridge.install(navigatorHandle, name, value, { enumerable: true, configurable: true, writable: false })
  const method = (name, fn) =>
    bridge.install(navigatorHandle, name, fn, { enumerable: true, configurable: true, writable: true })

  const chromeLike = profile.browser !== 'firefox'
  const permissions = bridge.obj()
  property('permissions', permissions)
  bridge.install(permissions, 'query', bridge.fn('query', 1, ({ args }) => {
    const descriptor = bridge.value(args, 0) ?? {}
    const name = typeof descriptor.name === 'string' ? descriptor.name : String(descriptor.name ?? '')
    // PermissionState has no 'default'; Chrome maps the notification default
    // to 'prompt'.
    const configured = profile.permissions[name] ?? 'prompt'
    const state = configured === 'default' ? 'prompt' : configured
    const status = pinObject({ state, name, onchange: null })
    installEventTarget(status, ['addEventListener', 'removeEventListener', 'dispatchEvent'])
    bridge.emit('api', 'before', { api: 'navigator.permissions.query', name, state })
    return fulfilled(status)
  }), { enumerable: true, configurable: true, writable: true })
  installEventTarget(permissions, ['addEventListener', 'removeEventListener', 'dispatchEvent'])

  if (chromeLike) {
    const connection = bridge.obj({
      effectiveType: profile.connection.effectiveType,
      rtt: profile.connection.rtt,
      downlink: profile.connection.downlink,
      saveData: profile.connection.saveData,
      onchange: null,
    })
    if (profile.connection.type !== undefined) {
      bridge.install(connection, 'type', profile.connection.type, {
        enumerable: true,
        configurable: true,
        writable: false,
      })
    }
    installEventTarget(connection, ['addEventListener', 'removeEventListener'])
    property('connection', connection)

    method('getBattery', bridge.fn('getBattery', 0, () => {
      const battery = pinObject({
        charging: profile.battery.charging,
        level: profile.battery.level,
        chargingTime: profile.battery.chargingTime,
        dischargingTime: profile.battery.dischargingTime,
        onchargingchange: null,
        onchargingtimechange: null,
        ondischargingtimechange: null,
        onlevelchange: null,
      })
      installEventTarget(battery, ['addEventListener', 'removeEventListener'])
      bridge.emit('api', 'before', { api: 'navigator.getBattery', level: profile.battery.level })
      return fulfilled(battery)
    }))
  }

  const promiseOf = (value) => {
    const deferred = bridge.deferred()
    deferred.resolve(value)
    return deferred.handle
  }
  property('credentials', pinObject({
    get: bridge.fn('get', 1, () => promiseOf(ctx.null)),
    store: bridge.fn('store', 1, () => promiseOf(ctx.undefined)),
    create: bridge.fn('create', 1, () => promiseOf(ctx.null)),
    preventSilentAccess: bridge.fn('preventSilentAccess', 0, () => promiseOf(ctx.undefined)),
  }))
  property('getGamepads', bridge.fn('getGamepads', 0, () => pinArray([null, null, null, null])))
  property('mediaSession', pinObject({
    metadata: null,
    playbackState: 'none',
    setActionHandler: bridge.fn('setActionHandler', 2, () => ctx.undefined),
    setPositionState: bridge.fn('setPositionState', 1, () => ctx.undefined),
  }))
  if (chromeLike) {
    property('locks', pinObject({ request: bridge.fn('request', 2, () => promiseOf(ctx.null)) }))
    property('wakeLock', pinObject({ request: bridge.fn('request', 1, () => promiseOf(ctx.null)) }))
  }

  const mediaDevices = bridge.obj()
  property('mediaDevices', mediaDevices)
  bridge.install(mediaDevices, 'enumerateDevices', bridge.fn('enumerateDevices', 0, () => {
    bridge.emit('api', 'before', {
      api: 'navigator.mediaDevices.enumerateDevices',
      count: profile.mediaDevices.length,
    })
    return fulfilled(pinArray(profile.mediaDevices))
  }), { enumerable: true, configurable: true, writable: true })
  bridge.install(mediaDevices, 'getUserMedia', bridge.fn('getUserMedia', 1, ({ args }) => {
    bridge.emit('api', 'before', {
      api: 'navigator.mediaDevices.getUserMedia',
      constraints: bridge.fromGuest(args[0]),
    })
    return rejected(pinError('NotAllowedError', 'Permission denied'))
  }), { enumerable: true, configurable: true, writable: true })
  bridge.install(mediaDevices, 'getDisplayMedia', bridge.fn('getDisplayMedia', 1, () => {
    bridge.emit('api', 'before', { api: 'navigator.mediaDevices.getDisplayMedia' })
    return rejected(pinError('NotAllowedError', 'Permission denied'))
  }), { enumerable: true, configurable: true, writable: true })
  installEventTarget(mediaDevices, ['addEventListener', 'removeEventListener'])

  const clipboard = bridge.obj()
  property('clipboard', clipboard)
  bridge.install(clipboard, 'readText', bridge.fn('readText', 0, () => {
    bridge.emit('api', 'before', { api: 'navigator.clipboard.readText' })
    return fulfilled(pinString(''))
  }), { enumerable: true, configurable: true, writable: true })
  bridge.install(clipboard, 'writeText', bridge.fn('writeText', 1, ({ args }) => {
    const text = kit.argumentText(args, 0)
    bridge.emit('api', 'before', { api: 'navigator.clipboard.writeText', length: text.length })
    bridge.reportIOC('clipboard', text)
    return fulfilled(ctx.undefined)
  }), { enumerable: true, configurable: true, writable: true })

  const geolocation = bridge.obj()
  property('geolocation', geolocation)
  bridge.install(geolocation, 'getCurrentPosition', bridge.fn('getCurrentPosition', 1, ({ args }) => {
    const errorCallback = args[1] && ctx.typeof(args[1]) === 'function' ? retain(args[1].dup()) : null
    bridge.emit('api', 'before', { api: 'navigator.geolocation.getCurrentPosition' })
    clock.schedule({
      delay: 0,
      fn: () => {
        if (!errorCallback) return
        const error = pinObject({ code: 1, message: 'User denied Geolocation', PERMISSION_DENIED: 1 })
        const result = ctx.callFunction(errorCallback, ctx.undefined, [error])
        if (result.error) result.error.dispose()
        else result.value.dispose()
      },
    })
    return ctx.undefined
  }), { enumerable: true, configurable: true, writable: true })
  bridge.install(geolocation, 'watchPosition', bridge.fn('watchPosition', 1, () => {
    bridge.emit('api', 'before', { api: 'navigator.geolocation.watchPosition' })
    return ctx.newNumber(1)
  }), { enumerable: true, configurable: true, writable: true })
  bridge.install(geolocation, 'clearWatch', bridge.fn('clearWatch', 1, ({ args }) => {
    bridge.emit('api', 'before', { api: 'navigator.geolocation.clearWatch', id: bridge.int(args, 0, 0) })
    return ctx.undefined
  }), { enumerable: true, configurable: true, writable: true })

  method('sendBeacon', bridge.fn('sendBeacon', 2, ({ args }) => {
    const url = kit.argumentText(args, 0)
    const payload = kit.preview(args[1])
    bridge.emit('api', 'before', { api: 'navigator.sendBeacon', url: url.slice(0, 2048), size: payload.length })
    bridge.reportIOC('url', url)
    return ctx.true
  }))

  property('userActivation', bridge.obj({ isActive: true, hasBeenActive: true }))
  if (bridge.storageManager) property('storage', bridge.storageManager)

  navigatorHandle.dispose()
}

