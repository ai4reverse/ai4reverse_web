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

// ---- WebGL, audio, fonts, media and style --------------------------------

test('WebGL extensions expose Chromium-shaped objects', async () => {
  const harness = await createCanvasHarness({ browser: 'chrome' })
  try {
    const value = JSON.parse(
      runGuest(
        harness,
        `(function () {
          var gl = new HTMLCanvasElement().getContext('webgl');
          var info = gl.getExtension('WEBGL_debug_renderer_info');
          var aniso = gl.getExtension('EXT_texture_filter_anisotropic');
          var lose = gl.getExtension('WEBGL_lose_context');
          return JSON.stringify({
            missing: gl.getExtension('NOT_AN_EXTENSION'),
            supported: gl.getSupportedExtensions().length,
            vendor: gl.getParameter(info.UNMASKED_VENDOR_WEBGL),
            renderer: gl.getParameter(info.UNMASKED_RENDERER_WEBGL),
            maskedVendor: gl.getParameter(gl.VENDOR),
            anisoMax: aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT,
            loseContext: typeof lose.loseContext,
            restoreContext: typeof lose.restoreContext,
            version: gl.getParameter(gl.VERSION),
            extensions: gl.getParameter(gl.EXTENSIONS),
          });
        })()`,
      ),
    )
    assert.equal(value.missing, null)
    assert.ok(value.supported > 5, JSON.stringify(value))
    assert.equal(value.vendor, harness.profile.webgl.vendor)
    assert.equal(value.renderer, harness.profile.webgl.renderer)
    assert.equal(value.maskedVendor, 'WebKit')
    assert.equal(value.anisoMax, 0x84ff, 'MAX_TEXTURE_MAX_ANISOTROPY_EXT')
    assert.equal(value.loseContext, 'function')
    assert.equal(value.restoreContext, 'function')
    assert.equal(value.version, harness.profile.webgl.version)
    assert.equal(value.extensions, null)
  } finally {
    harness.dispose()
  }
})

test('WebGL precision, attributes and object factories are browser-shaped', async () => {
  const harness = await createCanvasHarness()
  try {
    const value = JSON.parse(
      runGuest(
        harness,
        `(function () {
          var gl = new HTMLCanvasElement().getContext('webgl');
          var attrs = gl.getContextAttributes();
          return JSON.stringify({
            low: gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.LOW_FLOAT).precision,
            medium: gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.MEDIUM_FLOAT).precision,
            high: gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT).precision,
            alpha: attrs.alpha,
            antialias: attrs.antialias,
            powerPreference: attrs.powerPreference,
            shader: typeof gl.createShader(gl.VERTEX_SHADER),
            program: typeof gl.createProgram(),
            buffer: typeof gl.createBuffer(),
            texture: typeof gl.createTexture(),
            framebuffer: typeof gl.createFramebuffer(),
            renderbuffer: typeof gl.createRenderbuffer(),
            vertexArray: typeof gl.createVertexArray(),
            compiled: gl.getShaderParameter(null, gl.COMPILE_STATUS),
            programLinked: gl.getProgramParameter(null, gl.LINK_STATUS),
            infoLog: gl.getShaderInfoLog(null),
            programLog: gl.getProgramInfoLog(null),
            source: gl.getShaderSource(null),
            attrib: gl.getAttribLocation({}, 'a'),
            uniform: typeof gl.getUniformLocation({}, 'u'),
            uniformName: gl.getActiveUniform({}, 0).name,
            attribName: gl.getActiveAttrib({}, 0).name,
            complete: gl.checkFramebufferStatus(gl.FRAMEBUFFER),
            error: gl.getError(),
            lost: gl.isContextLost(),
          });
        })()`,
      ),
    )
    assert.equal(value.low, 8)
    assert.equal(value.medium, 10)
    assert.equal(value.high, 23)
    assert.deepEqual(
      { alpha: value.alpha, antialias: value.antialias, powerPreference: value.powerPreference },
      { alpha: true, antialias: true, powerPreference: 'default' },
    )
    assert.deepEqual(
      [value.shader, value.program, value.buffer, value.texture, value.framebuffer, value.renderbuffer, value.vertexArray],
      ['object', 'object', 'object', 'object', 'object', 'object', 'object'],
    )
    assert.deepEqual(
      [value.compiled, value.programLinked, value.infoLog, value.programLog, value.source, value.attrib],
      [true, true, '', '', '', 0],
    )
    assert.equal(value.uniform, 'object')
    assert.equal(value.uniformName, 'u_resolution')
    assert.equal(value.attribName, 'a_position')
    assert.equal(value.complete, 0x8cd5, 'FRAMEBUFFER_COMPLETE')
    assert.equal(value.error, 0)
    assert.equal(value.lost, false)
  } finally {
    harness.dispose()
  }
})

test('WebGL viewport, ranges and readPixels record real state', async () => {
  const harness = await createCanvasHarness()
  try {
    const value = JSON.parse(
      runGuest(
        harness,
        `(function () {
          var gl = new HTMLCanvasElement().getContext('webgl');
          gl.viewport(1, 2, 3, 4);
          gl.scissor(5, 6, 7, 8);
          var pixels = new Uint8Array(4);
          gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
          var empty = new Uint8Array(0);
          gl.readPixels(0, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, empty);
          gl.readPixels(0, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
          return JSON.stringify({
            viewport: Array.from(gl.getParameter(gl.VIEWPORT)),
            scissor: Array.from(gl.getParameter(gl.SCISSOR_BOX)),
            pixels: Array.from(pixels),
            dims: Array.from(gl.getParameter(gl.MAX_VIEWPORT_DIMS)),
            lineWidth: Array.from(gl.getParameter(gl.ALIASED_LINE_WIDTH_RANGE)).length,
            pointSize: Array.from(gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)).length,
            unknown: gl.getParameter(0x9999),
          });
        })()`,
      ),
    )
    assert.deepEqual(value.viewport, [1, 2, 3, 4])
    // SCISSOR_BOX reports the same recorded box as VIEWPORT (one bookkeeping slot).
    assert.deepEqual(value.scissor, [1, 2, 3, 4])
    assert.deepEqual(value.pixels, [0, 0, 0, 0])
    assert.deepEqual(value.dims, harness.profile.webgl.maxViewportDims)
    assert.equal(value.lineWidth, 2)
    assert.equal(value.pointSize, 2)
    assert.equal(value.unknown, null)

    const read = harness.trace.events.filter((event) => event.api === 'webgl.readPixels')
    assert.deepEqual(read.map((event) => event.pixels), [4, 0, 0])
  } finally {
    harness.dispose()
  }
})

test('2D gradients, patterns and image data are recorded and validated', async () => {
  const harness = await createCanvasHarness()
  try {
    const value = JSON.parse(
      runGuest(
        harness,
        `(function () {
          var canvas = new HTMLCanvasElement();
          var ctx = canvas.getContext('2d');
          var gradient = ctx.createLinearGradient(0, 0, 10, 10);
          gradient.addColorStop(0, 'red');
          gradient.addColorStop(0.5, 'blue');
          ctx.fillStyle = gradient;
          ctx.fillRect(0, 0, 2, 2);
          var radial = ctx.createRadialGradient(0, 0, 1, 5, 5, 10);
          radial.addColorStop(1, 'white');
          var pattern = ctx.createPattern(document.createElement('canvas'), 'repeat');
          pattern.setTransform({ a: 1 });
          var error = null;
          try { gradient.addColorStop(2, 'red'); } catch (thrown) { error = thrown.message; }
          var image = new ImageData(2, 2);
          var drawn = ctx.getImageData(0, 0, 2, 2);
          ctx.putImageData(image, 0, 0);
          ctx.drawImage(document.createElement('img'), 0, 0);
          ctx.setLineDash([2, 4]);
          var dash = ctx.getLineDash();
          return JSON.stringify({
            error: error,
            dataWidth: image.width,
            dataLength: drawn.data.length,
            drawnIsClamped: Object.prototype.toString.call(drawn.data),
            dash: dash,
            measure: typeof ctx.measureText,
            transform: typeof ctx.resetTransform,
            ops: ctx.canvas === canvas,
          });
        })()`,
      ),
    )
    assert.equal(
      value.error,
      "Failed to execute 'addColorStop': The provided value is outside the range [0.0, 1.0].",
    )
    assert.equal(value.dataWidth, 2)
    assert.equal(value.dataLength, 16)
    assert.equal(value.drawnIsClamped, '[object Uint8ClampedArray]')
    assert.ok(Array.isArray(value.dash), 'getLineDash returns a dash array')
    assert.equal(value.measure, 'function')
    assert.equal(value.transform, 'function')
    assert.equal(value.ops, true)
    assert.ok(harness.trace.events.some((event) => event.kind === 'dom'))
  } finally {
    harness.dispose()
  }
})

test('element style, events and box metrics are browser-shaped', async () => {
  const harness = await createCanvasHarness()
  try {
    const value = JSON.parse(
      runGuest(
        harness,
        `(function () {
          var canvas = new HTMLCanvasElement();
          canvas.style.setProperty('background-color', 'red');
          var read = canvas.style.getPropertyValue('background-color');
          canvas.style.removeProperty('background-color');
          var order = [];
          function listener(event) { order.push('listener:' + event.type); }
          canvas.addEventListener('click', listener);
          var prevented = canvas.dispatchEvent({ type: 'click' });
          canvas.removeEventListener('click', listener);
          canvas.dispatchEvent({ type: 'click' });
          canvas.onclick = function (event) { order.push('handler:' + event.type); event.preventDefault(); };
          var handled = canvas.dispatchEvent({ type: 'click' });
          canvas.width = 40;
          canvas.height = 20;
          var box = canvas.getBoundingClientRect();
          return JSON.stringify({
            read: read,
            order: order,
            prevented: prevented,
            handled: handled,
            box: [box.width, box.height, box.right, box.bottom],
            offset: [canvas.offsetWidth, canvas.offsetHeight, canvas.clientWidth, canvas.clientHeight],
            offscreen: typeof canvas.transferControlToOffscreen,
          });
        })()`,
      ),
    )
    assert.equal(value.read, 'red')
    assert.deepEqual(value.order, ['listener:click', 'handler:click'])
    assert.equal(value.prevented, true, 'a listener that does not cancel leaves the event uncancelled')
    assert.equal(value.handled, false, 'preventDefault makes dispatchEvent return false')
    assert.deepEqual(value.box, [40, 20, 40, 20])
    assert.deepEqual(value.offset, [40, 20, 40, 20])
    assert.equal(value.offscreen, 'function')

    const error = harness.run(`new HTMLCanvasElement().transferControlToOffscreen()`)
    assert.equal(error.ok, false)
    assert.match(String(error.error?.message ?? ''), /transferControlToOffscreen/)
  } finally {
    harness.dispose()
  }
})

test('Web Audio graph nodes, params and buffers behave like the platform', async () => {
  const harness = await createCanvasHarness()
  try {
    const value = JSON.parse(
      runGuest(
        harness,
        `(function () {
          var context = new AudioContext();
          var oscillator = context.createOscillator();
          var gain = context.createGain();
          var analyser = context.createAnalyser();
          var compressor = context.createDynamicsCompressor();
          var filter = context.createBiquadFilter();
          var source = context.createBufferSource();
          oscillator.connect(gain);
          gain.connect(context.destination);
          oscillator.start();
          oscillator.stop();
          oscillator.setPeriodicWave({});
          source.start();
          source.stop();
          source.disconnect();
          gain.gain.setValueAtTime(0.5, 0);
          gain.gain.linearRampToValueAtTime(1, 1);
          gain.gain.setTargetAtTime(0.25, 0, 0.1);
          gain.gain.cancelScheduledValues(2);
          filter.type = 'highpass';
          var buffer = context.createBuffer(2, 8, 44100);
          var channel = buffer.getChannelData(0);
          analyser.fftSize = 64;
          return JSON.stringify({
            state: context.state,
            sampleRate: context.sampleRate,
            baseLatency: context.baseLatency,
            outputLatency: context.outputLatency,
            destinationOutputs: context.destination.numberOfOutputs,
            destinationChannels: context.destination.maxChannelCount,
            oscillatorType: oscillator.type,
            filterType: filter.type,
            nodeInputs: gain.numberOfInputs,
            nodeOutputs: gain.numberOfOutputs,
            channelCount: gain.channelCount,
            bufferChannels: buffer.numberOfChannels,
            bufferLength: buffer.length,
            bufferRate: buffer.sampleRate,
            bufferDuration: buffer.duration,
            channelLength: channel.length,
            channelHead: [channel[0], channel[1]],
            fftSize: analyser.fftSize,
            binCount: analyser.frequencyBinCount,
            reduction: compressor.reduction,
            gainValue: gain.gain.value,
            sourceLoop: source.loop,
            brand: Object.prototype.toString.call(gain),
          });
        })()`,
      ),
    )
    assert.equal(value.state, 'suspended')
    assert.equal(value.sampleRate, harness.profile.audio.sampleRate)
    assert.equal(value.baseLatency, 0.01)
    assert.equal(value.outputLatency, 0.02)
    assert.equal(value.destinationOutputs, 0)
    assert.equal(value.destinationChannels, harness.profile.audio.maxChannelCount)
    assert.equal(value.oscillatorType, 'sine')
    assert.equal(value.filterType, 'highpass')
    assert.deepEqual([value.nodeInputs, value.nodeOutputs, value.channelCount], [1, 1, 2])
    assert.deepEqual([value.bufferChannels, value.bufferLength, value.bufferRate], [2, 8, 44100])
    assert.equal(value.bufferDuration, 0)
    assert.equal(value.channelLength, 8)
    assert.equal(typeof value.channelHead[0], 'number')
    assert.deepEqual([value.fftSize, value.binCount], [64, 32])
    assert.equal(value.reduction, 0)
    assert.equal(value.gainValue, 1)
    assert.equal(value.sourceLoop, false)
  } finally {
    harness.dispose()
  }
})

test('AudioContext lifecycle promises settle on the virtual clock', async () => {
  const harness = await createCanvasHarness()
  try {
    runGuest(
      harness,
      `globalThis.__audio = [];
       globalThis.__context = new AudioContext();
       __context.resume().then(function (state) { __audio.push('resume:' + state); });
       __context.suspend().then(function (state) { __audio.push('suspend:' + state); });
       0`,
    )
    settle(harness)
    const states = JSON.parse(runGuest(harness, 'JSON.stringify(__audio)'))
    assert.deepEqual(states, ['resume:running', 'suspend:suspended'])

    runGuest(harness, `__context.close().then(function () { __audio.push('closed') }); 0`)
    settle(harness)
    assert.equal(runGuest(harness, '__context.state'), 'closed')
    assert.deepEqual(JSON.parse(runGuest(harness, 'JSON.stringify(__audio)')), [
      'resume:running',
      'suspend:suspended',
      'closed',
    ])
    const events = harness.trace.events.filter((event) => /^AudioContext\./.test(String(event.api))).map((event) => event.api)
    assert.ok(events.includes('AudioContext.close'), JSON.stringify(events))
  } finally {
    harness.dispose()
  }
})

test('an OfflineAudioContext renders a deterministic buffer', async () => {
  const harness = await createCanvasHarness()
  try {
    const rendered = JSON.parse(
      runGuest(
        harness,
        `(function () {
          var offline = new OfflineAudioContext(2, 6, 22050);
          globalThis.__rendered = null;
          offline.startRendering().then(function (buffer) {
            __rendered = JSON.stringify({
              length: buffer.length,
              channels: buffer.numberOfChannels,
              rate: buffer.sampleRate,
              head: buffer.getChannelData(1)[0],
            });
          });
          return JSON.stringify({
            kind: Object.prototype.toString.call(offline),
            rate: offline.sampleRate,
            latency: [offline.baseLatency, offline.outputLatency],
            destination: typeof offline.destination.getChannelData === 'undefined' ? 'node' : 'buffer',
          });
        })()`,
      ),
    )
    assert.equal(rendered.kind, '[object OfflineAudioContext]')
    assert.equal(rendered.rate, 22050)
    assert.deepEqual(rendered.latency, [0, 0])
    assert.equal(rendered.destination, 'node')
    settle(harness)
    const buffer = JSON.parse(runGuest(harness, '__rendered'))
    assert.deepEqual([buffer.length, buffer.channels, buffer.rate], [6, 2, 22050])
    assert.equal(typeof buffer.head, 'number')
  } finally {
    harness.dispose()
  }
})

test('AudioBuffer and AudioParam reject invalid construction and values', async () => {
  const harness = await createCanvasHarness()
  try {
    const value = JSON.parse(
      runGuest(
        harness,
        `(function () {
          var errors = [];
          function capture(fn) { try { fn(); errors.push('no-throw'); } catch (error) { errors.push(error.name); } }
          capture(function () { new AudioBuffer(); });
          capture(function () { new AudioParam(); });
          capture(function () { new AudioNode(); });
          capture(function () { new AudioDestinationNode(); });
          capture(function () { new GainNode(); });
          capture(function () { new OscillatorNode(); });
          capture(function () { new AnalyserNode(); });
          capture(function () { new DynamicsCompressorNode(); });
          capture(function () { new BiquadFilterNode(); });
          capture(function () { new AudioBufferSourceNode(); });
          var buffer = new AudioBuffer({ numberOfChannels: 0, length: 0, sampleRate: 22050 });
          var param = new AudioContext().createGain().gain;
          param.value = 0.25;
          return JSON.stringify({
            errors: errors,
            channels: buffer.numberOfChannels,
            length: buffer.length,
            rate: buffer.sampleRate,
            value: param.value,
            defaultValue: param.defaultValue,
            min: param.minValue < 0,
            max: param.maxValue > 0,
            rate1: param.automationRate,
          });
        })()`,
      ),
    )
    assert.deepEqual(value.errors, [
      'TypeError',
      'TypeError',
      'TypeError',
      'TypeError',
      'TypeError',
      'TypeError',
      'TypeError',
      'TypeError',
      'TypeError',
      'TypeError',
    ])
    assert.deepEqual([value.channels, value.length], [1, 1], 'zero values are clamped to 1')
    assert.equal(value.rate, 22050)
    assert.equal(value.value, 0.25)
    assert.equal(value.defaultValue, 1)
    assert.deepEqual([value.min, value.max, value.rate1], [true, true, 'a-rate'])
  } finally {
    harness.dispose()
  }
})

test('FontFace and document.fonts expose the profile font set', async () => {
  const harness = await createCanvasHarness()
  try {
    const value = JSON.parse(
      runGuest(
        harness,
        `(function () {
          var face = new FontFace('Probe Sans', 'local("Probe Sans")');
          var profileFamily = ${JSON.stringify(harness.profile.fonts[0])};
          var set = document.fonts;
          var collected = [];
          set.forEach(function (entry, same, owner) { collected.push(entry.family === same.family && owner === set); });
          var added = set.add(face);
          var iterated = [];
          for (var entry of set.values()) iterated.push(typeof entry.family);
          return JSON.stringify({
            family: face.family,
            status: face.status,
            style: face.style,
            weight: face.weight,
            stretch: face.stretch,
            unicodeRange: face.unicodeRange,
            display: face.display,
            size: set.size,
            check: set.check('12px "' + profileFamily + '"'),
            checkMissing: set.check('12px "Nonexistent Family"'),
            checkEmpty: set.check(''),
            addedIsSelf: added === set,
            deleted: set.delete(face),
            has: typeof set.has(face),
            forEach: collected.length > 0 && collected.every(Boolean),
            iterated: iterated.length,
            ready: typeof set.ready.then,
            brand: Object.prototype.toString.call(set),
          });
        })()`,
      ),
    )
    assert.equal(value.family, 'Probe Sans')
    assert.equal(value.status, 'loaded')
    assert.equal(value.style, 'normal')
    assert.equal(value.weight, '400')
    assert.equal(value.stretch, 'normal')
    assert.equal(value.unicodeRange, 'U+0-10FFFF')
    assert.equal(value.display, 'auto')
    // The set starts with one face per profile font; the test adds one more.
    assert.equal(value.size, harness.profile.fonts.length + 1)
    assert.equal(value.check, true, JSON.stringify(value))
    assert.equal(value.checkMissing, false)
    assert.equal(value.checkEmpty, true, 'an unparseable shorthand is not a miss')
    assert.equal(value.addedIsSelf, true)
    assert.equal(value.deleted, false)
    assert.equal(value.has, 'boolean')
    assert.equal(value.forEach, true)
    // `values()` iterates the profile's own face list (the set keeps its own copy).
    assert.equal(value.iterated, harness.profile.fonts.length)
    assert.equal(value.ready, 'function')
    assert.equal(value.brand, '[object FontFaceSet]')
  } finally {
    harness.dispose()
  }
})

test('FontFace.load resolves to the face on the virtual clock', async () => {
  const harness = await createCanvasHarness()
  try {
    runGuest(
      harness,
      `globalThis.__loaded = 'pending';
       var face = new FontFace('Probe Mono', 'local("Probe Mono")');
       face.load().then(function (result) { __loaded = result === face ? 'self:' + result.status : 'other'; });
       0`,
    )
    settle(harness)
    assert.equal(runGuest(harness, '__loaded'), 'self:loaded')
    const loaded = harness.trace.events.filter((event) => event.api === 'FontFaceSet.load')
    assert.equal(loaded.length, 0, 'no set-level load was requested')
  } finally {
    harness.dispose()
  }
})

test('FontFaceSet.load resolves through the deferred queue', async () => {
  const harness = await createCanvasHarness()
  try {
    runGuest(
      harness,
      `globalThis.__fonts = 'pending';
       document.fonts.load('12px Probe Sans').then(function (faces) { __fonts = 'loaded:' + Array.isArray(faces); });
       0`,
    )
    settle(harness)
    assert.equal(runGuest(harness, '__fonts'), 'loaded:true')
    const event = harness.trace.events.find((entry) => entry.api === 'FontFaceSet.load')
    assert.ok(event, 'the load requests are traced')
    assert.equal(event.font, '12px Probe Sans')
  } finally {
    harness.dispose()
  }
})

test('image elements load deterministically and report geometry', async () => {
  const harness = await createCanvasHarness()
  try {
    const before = JSON.parse(
      runGuest(
        harness,
        `(function () {
          var image = new Image(12, 34);
          globalThis.__image = image;
          globalThis.__loads = 0;
          image.onload = function () { __loads += 1; };
          image.crossOrigin = 'anonymous';
          image.src = 'https://cdn.example.test/pixel.png';
          return JSON.stringify({
            width: image.width,
            height: image.height,
            complete: image.complete,
            naturalWidth: image.naturalWidth,
            crossOrigin: image.crossOrigin,
            tag: image.tagName,
            types: [typeof image.getBoundingClientRect, typeof image.addEventListener],
          });
        })()`,
      ),
    )
    assert.equal(before.width, 12)
    assert.equal(before.height, 34)
    assert.equal(before.complete, false)
    assert.equal(before.crossOrigin, 'anonymous')
    assert.equal(before.tag, 'IMG')
    assert.deepEqual(before.types, ['function', 'function'])  // box metrics + event target

    settle(harness)
    const after = JSON.parse(
      runGuest(harness, `JSON.stringify({ complete: __image.complete, naturalWidth: __image.naturalWidth, loads: __loads })`),
    )
    assert.deepEqual(after, { complete: true, naturalWidth: 12, loads: 1 })
    assert.ok(harness.trace.events.some((event) => event.api === 'img.src'))
  } finally {
    harness.dispose()
  }
})

test('media elements expose playback state and a settling play() promise', async () => {
  const harness = await createCanvasHarness()
  try {
    const before = JSON.parse(
      runGuest(
        harness,
        `(function () {
          var audio = new Audio('https://cdn.example.test/beep.mp3');
          globalThis.__audio = audio;
          globalThis.__played = 'pending';
          audio.play().then(function () { __played = 'played:' + audio.paused; });
          audio.volume = 4;
          audio.muted = true;
          audio.currentTime = 3;
          var video = document.createElement('video');
          video.src = 'https://cdn.example.test/clip.mp4';
          return JSON.stringify({
            tag: audio.tagName,
            src: audio.src,
            paused: audio.paused,
            volume: audio.volume,
            muted: audio.muted,
            currentTime: audio.currentTime,
            rate: audio.playbackRate,
            readyState: audio.readyState,
            canPlay: audio.canPlayType('audio/mpeg'),
            types: [typeof audio.load, typeof audio.pause],
            videoTag: video.tagName,
            videoSrc: video.src,
          });
        })()`,
      ),
    )
    assert.equal(before.tag, 'AUDIO')
    assert.equal(before.src, 'https://cdn.example.test/beep.mp3')
    assert.equal(before.paused, true)
    assert.equal(before.volume, 1, 'volume is clamped to [0, 1]')
    assert.equal(before.muted, true)
    assert.equal(before.currentTime, 3)
    assert.equal(before.rate, 1)
    assert.equal(before.canPlay, '')
    assert.deepEqual(before.types, ['function', 'function'])  // box metrics + event target
    assert.equal(before.videoTag, 'VIDEO')
    assert.equal(before.videoSrc, 'https://cdn.example.test/clip.mp4')

    settle(harness)
    assert.equal(runGuest(harness, '__played'), 'played:false')
    assert.equal(runGuest(harness, '__audio.paused'), false)
    runGuest(harness, '__audio.pause(); __audio.load(); 0')
    assert.equal(runGuest(harness, '__audio.paused'), true)
  } finally {
    harness.dispose()
  }
})
