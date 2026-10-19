import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHarness } from './helpers/harness.js'
import { install as installCanvasEnv, meta as canvasMeta } from '../tools/sandbox/env/canvas.js'

/**
 * Canvas / WebGL / Web Audio / font surfaces.
 *
 * The harness installs the module through the real environment registry (so the
 * DOM module registers `bridge.elementFactories` first, exactly as in a run);
 * the fallback paths that need a bridge without a document install the module
 * directly on a bare harness.
 */

const PNG_PREFIX = 'data:image/png;base64,iVBORw0KGgo'
/** PNG signature (8) + IHDR chunk (25) precede the deterministic payload. */
const PNG_HEADER_BYTES = 33

/** Harness with the canvas surfaces installed by the environment registry. */
async function createCanvasHarness(profile = {}) {
  const harness = await createHarness({ modules: ['globals', 'console', 'timers', 'dom', 'canvas'], profile })
  const installed = harness.env.installed.some((entry) => entry.id === 'canvas')
  assert.equal(installed, true, 'the canvas module must install through the registry')
  return harness
}

/** Evaluate guest source and fail the test when it throws. */
function runGuest(harness, source) {
  const result = harness.run(source)
  assert.equal(result.ok, true, `guest threw: ${JSON.stringify(result.error)}`)
  return result.value
}

/** Run the virtual clock and the promise job queue to completion. */
function settle(harness, rounds = 4) {
  for (let index = 0; index < rounds; index += 1) {
    harness.timers()
    harness.jobs()
  }
}

test('meta declares the canvas module contract', () => {
  assert.equal(canvasMeta.id, 'canvas')
  assert.equal(canvasMeta.order, 105)
  assert.deepEqual([...canvasMeta.requires], ['globals'])
})

test('element factories are registered for document.createElement', async () => {
  const harness = await createCanvasHarness()
  try {
    const factories = harness.bridge.elementFactories
    assert.ok(factories instanceof Map, 'elementFactories must be a Map')
    assert.equal(harness.bridge.canvasFactories, factories, 'canvasFactories must publish the same map')
    for (const tag of ['canvas', 'img', 'audio', 'video']) {
      assert.equal(typeof factories.get(tag), 'function', `missing factory for ${tag}`)
    }

    const canvas = factories.get('canvas')({ width: 32, height: 16 })
    harness.bridge.install(harness.bridge.global, 'probeCanvas', canvas, {
      enumerable: true,
      configurable: true,
      writable: true,
    })
    canvas.dispose()
    const probe = runGuest(
      harness,
      `(function(){
        return [
          probeCanvas instanceof HTMLCanvasElement,
          probeCanvas.tagName,
          probeCanvas.width,
          probeCanvas.height,
          typeof probeCanvas.getContext,
        ]
      })()`,
    )
    assert.deepEqual(probe, [true, 'CANVAS', 32, 16, 'function'])

    // The document module calls the same factories from createElement().
    const created = runGuest(
      harness,
      `(function(){
        var canvas = document.createElement('canvas')
        var image = document.createElement('img')
        var audio = document.createElement('audio')
        return [
          Object.prototype.toString.call(canvas),
          canvas.ownerDocument === document,
          Object.prototype.toString.call(image),
          Object.prototype.toString.call(audio),
          canvas.getContext('2d') === canvas.getContext('2d'),
        ]
      })()`,
    )
    assert.deepEqual(created, [
      '[object HTMLCanvasElement]',
      true,
      '[object HTMLImageElement]',
      '[object HTMLAudioElement]',
      true,
    ])
  } finally {
    harness.dispose()
  }
})

test('2D drawing operations are recorded and traced', async () => {
  const harness = await createCanvasHarness()
  try {
    runGuest(
      harness,
      `(function(){
        var canvas = new HTMLCanvasElement()
        var ctx = canvas.getContext('2d')
        ctx.fillStyle = '#f60'
        ctx.font = '14px Arial'
        ctx.fillRect(0, 0, 10, 20)
        ctx.fillText('probe', 1, 2)
        ctx.save()
        ctx.restore()
        return ctx.canvas === canvas
      })()`,
    )

    const domEvents = harness.trace.events.filter((event) => event.kind === 'dom')
    const ops = domEvents.filter((event) => event.op).map((event) => event.op)
    assert.ok(ops.includes('fillRect'), 'fillRect must be traced')
    assert.ok(ops.includes('fillText'), 'fillText must be traced')
    assert.ok(ops.includes('save') && ops.includes('restore'), 'save/restore must be traced')

    const fillRect = domEvents.find((event) => event.op === 'fillRect')
    assert.deepEqual(fillRect.args, [0, 0, 10, 20])
    assert.equal(fillRect.fillStyle, '#f60')
    assert.equal(fillRect.font, '14px Arial')

    const fillText = domEvents.find((event) => event.op === 'fillText')
    assert.equal(fillText.args[0], 'probe')
  } finally {
    harness.dispose()
  }
})

test('toDataURL is a deterministic function of the drawn content', async () => {
  const harness = await createCanvasHarness()
  try {
    const urls = runGuest(
      harness,
      `(function(){
        function render(width) {
          var canvas = new HTMLCanvasElement()
          var ctx = canvas.getContext('2d')
          ctx.fillStyle = '#def'
          ctx.fillRect(0, 0, width, 12)
          return canvas.toDataURL()
        }
        return [render(10), render(10), render(11)]
      })()`,
    )

    assert.ok(urls[0].startsWith(PNG_PREFIX), `unexpected data URL prefix: ${urls[0].slice(0, 32)}`)
    assert.equal(urls[0], urls[1], 'identical operations must hash identically')
    assert.notEqual(urls[0], urls[2], 'different operations must hash differently')

    const payload = Buffer.from(urls[0].slice(`data:image/png;base64,`.length), 'base64')
    assert.equal(payload.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG signature must be present')
    assert.equal(payload.subarray(12, 16).toString('latin1'), 'IHDR', 'the header must be a PNG IHDR chunk')
    const deterministicBytes = payload.length - PNG_HEADER_BYTES
    assert.ok(
      deterministicBytes >= 64 && deterministicBytes <= 256,
      `deterministic payload length out of range: ${deterministicBytes}`,
    )
  } finally {
    harness.dispose()
  }
})

test('toDataURL depends on the profile seed', async () => {
  const first = await createCanvasHarness({ seed: 0x11 })
  const second = await createCanvasHarness({ seed: 0x22 })
  try {
    const source = `(function(){
      var canvas = new HTMLCanvasElement()
      var ctx = canvas.getContext('2d')
      ctx.fillRect(0, 0, 4, 4)
      return canvas.toDataURL()
    })()`
    assert.notEqual(runGuest(first, source), runGuest(second, source), 'profiles must not share a canvas hash')
  } finally {
    first.dispose()
    second.dispose()
  }
})

test('toBlob delivers a byte-identical blob on the virtual clock', async () => {
  const harness = await createCanvasHarness()
  try {
    runGuest(
      harness,
      `(function(){
        globalThis.probeBlobs = []
        function grab() {
          var canvas = new HTMLCanvasElement()
          var ctx = canvas.getContext('2d')
          ctx.fillRect(0, 0, 8, 8)
          canvas.toBlob(function(blob){
            blob.arrayBuffer().then(function(buffer){
              globalThis.probeBlobs.push([blob.size, blob.type, buffer.byteLength])
            })
          }, 'image/png')
          return canvas.toDataURL().length
        }
        globalThis.probeUrlLength = grab()
        return 'queued'
      })()`,
    )

    assert.equal(runGuest(harness, 'globalThis.probeBlobs.length'), 0, 'toBlob must be asynchronous')
    settle(harness)
    const blobs = runGuest(harness, 'globalThis.probeBlobs')
    assert.equal(blobs.length, 1)
    assert.equal(blobs[0][1], 'image/png')
    assert.equal(blobs[0][2], blobs[0][0], 'the blob must expose its real byte length')
    assert.ok(blobs[0][0] > PNG_HEADER_BYTES, 'the blob must carry the PNG header and payload')
  } finally {
    harness.dispose()
  }
})

test('2D state survives save() and is restored by restore()', async () => {
  const harness = await createCanvasHarness()
  try {
    const state = runGuest(
      harness,
      `(function(){
        var canvas = new HTMLCanvasElement()
        var ctx = canvas.getContext('2d')
        var gradient = ctx.createLinearGradient(0, 0, 10, 10)
        gradient.addColorStop(0, '#000')
        gradient.addColorStop(1, 'rgba(255,255,255,0.5)')
        ctx.fillStyle = '#ff0000'
        ctx.lineWidth = 4
        ctx.save()
        ctx.fillStyle = gradient
        ctx.lineWidth = 9
        var inner = [typeof ctx.fillStyle, ctx.lineWidth]
        ctx.restore()
        return { gradient: Object.prototype.toString.call(gradient), inner: inner, outer: [ctx.fillStyle, ctx.lineWidth] }
      })()`,
    )

    assert.equal(state.gradient, '[object CanvasGradient]')
    assert.deepEqual(state.inner, ['object', 9])
    assert.deepEqual(state.outer, ['#ff0000', 4])
  } finally {
    harness.dispose()
  }
})

test('measureText is deterministic and proportional to text length', async () => {
  const harness = await createCanvasHarness()
  try {
    const metrics = runGuest(
      harness,
      `(function(){
        var canvas = new HTMLCanvasElement()
        var ctx = canvas.getContext('2d')
        ctx.font = '16px Arial'
        var once = ctx.measureText('fingerprint')
        var twice = ctx.measureText('fingerprint')
        return {
          first: once.width,
          second: twice.width,
          empty: ctx.measureText('').width,
          one: ctx.measureText('a').width,
          two: ctx.measureText('aa').width,
          four: ctx.measureText('aaaa').width,
          ascent: once.fontBoundingBoxAscent,
          descent: once.fontBoundingBoxDescent,
          right: once.actualBoundingBoxRight,
        }
      })()`,
    )

    assert.equal(metrics.first, metrics.second, 'measureText must be deterministic')
    assert.equal(metrics.empty, 0)
    assert.ok(metrics.one > 0, 'a character must advance the pen')
    assert.ok(metrics.two > metrics.one && metrics.four > metrics.two, 'width must grow with text length')
    assert.ok(metrics.ascent > 0 && metrics.descent > 0, 'font bounding box must be non-degenerate')
    assert.equal(metrics.right, metrics.first)
  } finally {
    harness.dispose()
  }
})

test('getImageData returns deterministic opaque noise', async () => {
  const harness = await createCanvasHarness()
  try {
    const pixels = runGuest(
      harness,
      `(function(){
        function read(x, y, w, h) {
          var canvas = new HTMLCanvasElement()
          var ctx = canvas.getContext('2d')
          var image = ctx.getImageData(x, y, w, h)
          return [image.width, image.height, Array.prototype.join.call(image.data, ',')]
        }
        return [read(0, 0, 4, 4), read(0, 0, 4, 4), read(0, 0, 4, 5)]
      })()`,
    )

    assert.equal(pixels[0][0], 4)
    assert.equal(pixels[0][1], 4)
    const bytes = pixels[0][2].split(',').map(Number)
    assert.equal(bytes.length, 4 * 4 * 4, 'RGBA data must have width*height*4 entries')
    assert.ok(bytes.every((value, index) => (index % 4 === 3 ? value === 255 : value >= 0 && value <= 255)))
    assert.equal(pixels[0][2], pixels[1][2], 'identical rectangles must yield identical pixels')
    assert.notEqual(pixels[0][2], pixels[2][2], 'different rectangles must yield different pixels')
  } finally {
    harness.dispose()
  }
})

test('WebGL reports the profile GPU and exposes constants', async () => {
  const harness = await createCanvasHarness()
  try {
    const info = runGuest(
      harness,
      `(function(){
        var canvas = new HTMLCanvasElement()
        var gl = canvas.getContext('webgl')
        var gl2 = canvas.getContext('webgl2')
        var extension = gl.getExtension('WEBGL_debug_renderer_info')
        return {
          renderer: gl.getParameter(gl.RENDERER),
          vendor: gl.getParameter(gl.VENDOR),
          unmaskedVendor: gl.getParameter(extension.UNMASKED_VENDOR_WEBGL),
          unmaskedRenderer: gl.getParameter(extension.UNMASKED_RENDERER_WEBGL),
          extensionVendorConstant: extension.UNMASKED_VENDOR_WEBGL,
          extensionRendererConstant: extension.UNMASKED_RENDERER_WEBGL,
          extensions: gl.getSupportedExtensions(),
          permission: gl.getExtension('KHR_does_not_exist'),
          constants: [gl.VENDOR, gl.RENDERER, gl.VERSION, gl.SHADING_LANGUAGE_VERSION, gl.MAX_TEXTURE_SIZE],
          prototypeConstants: [
            WebGLRenderingContext.prototype.VENDOR,
            WebGLRenderingContext.prototype.UNMASKED_RENDERER_WEBGL,
            WebGL2RenderingContext.prototype.MAX_TEXTURE_SIZE,
          ],
          maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
          viewportDims: Array.prototype.join.call(gl.getParameter(gl.MAX_VIEWPORT_DIMS), ','),
          error: gl.getError(),
          lost: gl.isContextLost(),
          isWebGL: gl instanceof WebGLRenderingContext,
          isWebGL2: gl2 instanceof WebGL2RenderingContext,
          tag: Object.prototype.toString.call(gl),
        }
      })()`,
    )

    const webglProfile = harness.profile.webgl
    // Chrome masks vendor/renderer; profile strings only appear via
    // WEBGL_debug_renderer_info, and masked !== unmasked.
    assert.equal(info.renderer, 'WebKit WebGL')
    assert.equal(info.vendor, 'WebKit')
    assert.notEqual(info.renderer, info.unmaskedRenderer)
    assert.equal(info.unmaskedRenderer, webglProfile.renderer)
    assert.equal(info.unmaskedVendor, webglProfile.vendor)
    assert.equal(info.extensionVendorConstant, 0x9245)
    assert.equal(info.extensionRendererConstant, 0x9246)
    assert.ok(info.extensions.length > 3, `expected several extensions, got ${info.extensions.length}`)
    assert.ok(info.extensions.includes('WEBGL_debug_renderer_info'))
    assert.equal(info.permission, null)
    assert.deepEqual(info.constants, [0x1f00, 0x1f01, 0x1f02, 0x8b8c, 0x0d33])
    assert.deepEqual(info.prototypeConstants, [0x1f00, 0x9246, 0x0d33])
    assert.equal(info.maxTextureSize, webglProfile.maxTextureSize)
    assert.equal(info.viewportDims, `${webglProfile.maxViewportDims[0]},${webglProfile.maxViewportDims[1]}`)
    assert.equal(info.error, 0)
    assert.equal(info.lost, false)
    assert.equal(info.isWebGL, true)
    assert.equal(info.isWebGL2, true)
    assert.equal(info.tag, '[object WebGLRenderingContext]')
  } finally {
    harness.dispose()
  }
})

test('AudioContext matches the profile and resumes on the virtual clock', async () => {
  const harness = await createCanvasHarness()
  try {
    const initial = runGuest(
      harness,
      `(function(){
        globalThis.probeResume = null
        var context = new AudioContext()
        globalThis.probeAudio = context
        context.resume().then(function(state){ globalThis.probeResume = [state, context.state] })
        return [context.sampleRate, context.state, context.baseLatency, context.currentTime, context.destination.maxChannelCount]
      })()`,
    )

    const audioProfile = harness.profile.audio
    assert.equal(initial[0], audioProfile.sampleRate)
    assert.equal(initial[1], 'suspended')
    assert.ok(initial[2] > 0, 'baseLatency must be a plausible positive value')
    assert.equal(initial[3], 0)
    assert.equal(initial[4], audioProfile.maxChannelCount)

    settle(harness)
    assert.deepEqual(runGuest(harness, 'globalThis.probeResume'), ['running', 'running'])
  } finally {
    harness.dispose()
  }
})

test('OfflineAudioContext renders a deterministic buffer', async () => {
  const harness = await createCanvasHarness()
  try {
    runGuest(
      harness,
      `(function(){
        globalThis.probeRenders = []
        for (var index = 0; index < 2; index += 1) {
          var offline = new OfflineAudioContext(2, 32, 44100)
          offline.startRendering().then(function(buffer){
            globalThis.probeRenders.push([
              buffer.length,
              buffer.numberOfChannels,
              buffer.sampleRate,
              Array.prototype.join.call(buffer.getChannelData(0), ','),
            ])
          })
        }
        return 'queued'
      })()`,
    )

    settle(harness)
    const renders = runGuest(harness, 'globalThis.probeRenders')
    assert.equal(renders.length, 2, 'both renders must resolve')
    assert.deepEqual(renders[0].slice(0, 3), [32, 2, 44100])
    const samples = renders[0][3].split(',').map(Number)
    assert.equal(samples.length, 32)
    assert.ok(samples.every((value) => value >= -1 && value <= 1), 'samples must be in [-1, 1]')
    assert.equal(renders[0][3], renders[1][3], 'identical renders must produce identical data')
  } finally {
    harness.dispose()
  }
})

test('AnalyserNode frequency data is deterministic', async () => {
  const harness = await createCanvasHarness()
  try {
    const bins = runGuest(
      harness,
      `(function(){
        function read() {
          var context = new AudioContext()
          var analyser = context.createAnalyser()
          var data = new Float32Array(analyser.frequencyBinCount)
          analyser.getFloatFrequencyData(data)
          return [analyser.fftSize, analyser.frequencyBinCount, Array.prototype.join.call(data, ',')]
        }
        return [read(), read()]
      })()`,
    )

    assert.equal(bins[0][0], 2048)
    assert.equal(bins[0][1], 1024)
    assert.equal(bins[0][2], bins[1][2], 'frequency data must be stable for a profile')
    const values = bins[0][2].split(',').map(Number)
    assert.equal(values.length, 1024)
    assert.ok(values.every((value) => value <= 0), 'dBFS values are non-positive')
    assert.ok(new Set(values).size > 100, 'the spectrum must not be a constant')
  } finally {
    harness.dispose()
  }
})

test('document.fonts exposes the profile font set', async () => {
  const harness = await createCanvasHarness()
  try {
    const fonts = runGuest(
      harness,
      `(function(){
        var families = []
        for (var face of document.fonts) families.push(face.family)
        return {
          status: document.fonts.status,
          size: document.fonts.size,
          check: document.fonts.check('12px "Segoe UI"'),
          checkUnknown: document.fonts.check('12px "Definitely Not Installed"'),
          has: document.fonts.has({}),
          families: families,
          isSet: document.fonts instanceof FontFaceSet,
          tag: Object.prototype.toString.call(document.fonts),
          ready: typeof document.fonts.ready.then,
        }
      })()`,
    )

    assert.equal(fonts.status, 'loaded')
    assert.equal(fonts.check, harness.profile.fonts.includes('Segoe UI'))
    assert.equal(fonts.checkUnknown, false)
    assert.equal(fonts.size, harness.profile.fonts.length)
    assert.equal(fonts.has, true)
    assert.equal(fonts.families.length, harness.profile.fonts.length)
    assert.ok(fonts.families.includes(harness.profile.fonts[0]))
    assert.equal(fonts.isSet, true)
    assert.equal(fonts.tag, '[object FontFaceSet]')
    assert.equal(fonts.ready, 'function')

    // measureText reads the metrics map the font surface publishes.
    const metrics = harness.bridge.fontMetrics
    assert.ok(metrics instanceof Map)
    for (const family of harness.profile.fonts) {
      assert.ok(metrics.has(family.toLowerCase()), `missing metrics for ${family}`)
    }
    const width = runGuest(
      harness,
      `(function(){ var ctx = new HTMLCanvasElement().getContext('2d'); ctx.font = '10px Arial'; return ctx.measureText('mm').width })()`,
    )
    assert.ok(width > 0)
  } finally {
    harness.dispose()
  }
})

test('document.fonts is deferred until the document exists', async () => {
  // No DOM module: `document` appears only after the module has installed.
  const harness = await createHarness({ modules: ['globals', 'console', 'timers'] })
  try {
    installCanvasEnv(harness.bridge)
    assert.equal(typeof harness.bridge.deferUntilDocument, 'function')
    const pending = harness.bridge.pendingDocumentTasks
    assert.ok(Array.isArray(pending) && pending.length === 1, 'one deferred document task must be queued')

    harness.bridge.install(harness.bridge.global, 'document', harness.bridge.obj({}), {
      enumerable: true,
      configurable: true,
      writable: true,
    })
    for (const task of pending) task()
    assert.equal(runGuest(harness, 'document.fonts.size'), harness.profile.fonts.length)
  } finally {
    harness.dispose()
  }
})

test('platform functions look native and leak no host frames', async () => {
  const harness = await createCanvasHarness()
  try {
    const brands = runGuest(
      harness,
      `(function(){
        var canvas = new HTMLCanvasElement()
        var ctx = canvas.getContext('2d')
        return {
          audio: String(AudioContext),
          webkitAudio: String(webkitAudioContext),
          canvas: String(HTMLCanvasElement),
          webgl: String(WebGLRenderingContext),
          context: String(CanvasRenderingContext2D),
          toDataURL: Function.prototype.toString.call(canvas.toDataURL),
          fillRect: Function.prototype.toString.call(ctx.fillRect),
          measureText: Function.prototype.toString.call(ctx.measureText),
          widthGetter: String(Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'width').get),
          tag: Object.prototype.toString.call(canvas),
        }
      })()`,
    )

    for (const [name, source] of Object.entries(brands)) {
      if (name === 'tag') continue
      assert.ok(source.includes('[native code]'), `${name} must look native: ${source}`)
      for (const leak of ['tools/', 'sandbox', 'quickjs', 'node:', 'ai4r-internal']) {
        assert.ok(!source.includes(leak), `${name} leaks host detail "${leak}": ${source}`)
      }
    }
    assert.equal(brands.tag, '[object HTMLCanvasElement]')
  } finally {
    harness.dispose()
  }
})
