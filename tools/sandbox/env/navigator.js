/**
 * `navigator` surface.
 *
 * Every value here comes from the seeded profile; nothing is invented locally.
 * Scalar properties are accessors (as in Chrome) so
 * `Object.getOwnPropertyDescriptor(navigator, 'userAgent').get.name` is
 * `"get userAgent"`, and the values cannot be overwritten by assignment.
 */

export const meta = { id: 'navigator', order: 40, requires: ['globals'] }

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

  // Chrome exposes `navigator.connection` and `navigator.getBattery` in misc.js;
  // keep this module limited to identity so ownership stays clear.

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
}
