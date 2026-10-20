/**
 * `Blob`, `File` and `FormData`.
 *
 * Stage-2 payloads travel as bytes: a loader builds a Blob from a decrypted
 * string, slices it, reads it back as text or an ArrayBuffer, or wraps it in a
 * FormData upload. The host holds the real bytes (Uint8Array / Node Blob); the
 * guest sees browser-shaped classes whose `instanceof` chain holds and whose
 * async readers settle on the virtual clock.
 *
 * `URL.createObjectURL` lives in `url.js`, but both modules share one kit, so a
 * Blob is recognised by its state id no matter which module created it.
 */

import { isHandle } from '../bridge.js'
import { createKit } from './platform-kit.js'

export const meta = { id: 'blob', order: 92, requires: ['globals'] }

/**
 * Install the Blob family.
 * @param {object} bridge host bridge
 */
export function install(bridge) {
  const kit = createKit(bridge)
  const BlobCtor = installBlob(bridge, kit)
  installFile(bridge, kit, BlobCtor)
  installFormData(bridge, kit)
}

// ---------------------------------------------------------------------------
// Blob / File
// ---------------------------------------------------------------------------

/**
 * Copy an ArrayBuffer-backed guest value to host bytes, or `null`.
 * @param {object} ctx
 * @param {object} handle
 */
function tryArrayBuffer(ctx, handle) {
  try {
    const buffer = ctx.getArrayBuffer(handle)
    if (!buffer?.value) {
      buffer?.dispose?.()
      return null
    }
    const copy = buffer.value.slice()
    buffer.dispose()
    return copy
  } catch {
    return null
  }
}

/**
 * Read Blob constructor parts into one byte array. Strings count as UTF-8,
 * buffers and views contribute their bytes, and Blob/File parts contribute
 * their stored bytes.
 * @param {object} bridge
 * @param {object} kit
 * @param {object} source guest handle
 */
function readBlobBytes(bridge, kit, source) {
  const { ctx } = bridge

  const bytesOf = (handle) => {
    const type = ctx.typeof(handle)
    if (type === 'string') return new Uint8Array(Buffer.from(ctx.getString(handle), 'utf8'))
    if (type !== 'object') return new Uint8Array(0)
    const state = kit.states.get(handle)
    if (state?.bytes) return state.bytes
    const direct = tryArrayBuffer(ctx, handle)
    if (direct) return direct
    const inner = ctx.getProp(handle, 'buffer')
    let bytes = null
    if (ctx.typeof(inner) === 'object') bytes = tryArrayBuffer(ctx, inner)
    inner.dispose()
    return bytes ?? new Uint8Array(0)
  }

  const type = ctx.typeof(source)
  if (type === 'undefined' || type === 'null') return new Uint8Array(0)
  const lengthValue = ctx.getProp(source, 'length')
  const length = ctx.typeof(lengthValue) === 'number' ? ctx.getNumber(lengthValue) : -1
  lengthValue.dispose()
  if (length < 0) return bytesOf(source)
  const chunks = []
  for (let i = 0; i < length; i += 1) {
    const part = ctx.getProp(source, i)
    chunks.push(bytesOf(part))
    part.dispose()
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

/**
 * `Blob`: real bytes and MIME handling, synchronous byte access for the host,
 * promises that settle on the virtual clock.
 * @param {object} bridge
 * @param {object} kit
 */
function installBlob(bridge, kit) {
  const { ctx } = bridge
  const { states, retain, fulfilled } = kit

  const initialize = bridge.fn('initialize', 3, ({ args }) => {
    const bytes = readBlobBytes(bridge, kit, args[1])
    const options = bridge.fromGuest(args[2])
    const type = options && typeof options === 'object' && typeof options.type === 'string' ? options.type : ''
    const blob = new Blob([bytes], { type })
    states.set(args[0], { blob, bytes, type: blob.type })
    return ctx.undefined
  })

  const BlobCtor = bridge.nativeConstructor({
    name: 'Blob',
    arity: 0,
    bindings: { initialize },
    body: 'initialize(self, arguments[0], arguments[1]);',
  })
  kit.setToStringTag(BlobCtor, 'Blob')

  const proto = ctx.getProp(BlobCtor, 'prototype')
  const method = (name, fn) => bridge.install(proto, name, fn, { enumerable: true, configurable: true, writable: true })
  kit.defineGetter(proto, 'size', ({ thisHandle }) => ctx.newNumber(states.require(thisHandle).blob.size))
  kit.defineGetter(proto, 'type', ({ thisHandle }) => ctx.newString(states.require(thisHandle).type))

  method('text', bridge.fn('text', 0, ({ thisHandle }) => {
    const state = states.require(thisHandle)
    bridge.emit('api', 'before', { api: 'Blob.text', size: state.bytes.byteLength })
    return fulfilled(retain(ctx.newString(Buffer.from(state.bytes).toString('utf8'))))
  }))

  method('arrayBuffer', bridge.fn('arrayBuffer', 0, ({ thisHandle }) => {
    const state = states.require(thisHandle)
    bridge.emit('api', 'before', { api: 'Blob.arrayBuffer', size: state.bytes.byteLength })
    const copy = state.bytes.slice()
    return fulfilled(retain(ctx.newArrayBuffer(copy.buffer)))
  }))

  method('slice', bridge.fn('slice', 3, ({ args, thisHandle }) => {
    const state = states.require(thisHandle)
    const length = state.bytes.byteLength
    const start = relativeIndex(bridge, args, 0, length, 0)
    const end = relativeIndex(bridge, args, 1, length, length)
    const bytes = state.bytes.slice(start, Math.max(start, end))
    const type = isHandle(args[2]) && ctx.typeof(args[2]) !== 'undefined' ? kit.argumentText(args, 2) : ''
    return createBlob(bridge, kit, BlobCtor, bytes, type)
  }))
  proto.dispose()

  bridge.install(bridge.global, 'Blob', BlobCtor, { enumerable: true, configurable: true, writable: true })
  return BlobCtor
}

/**
 * Create a guest Blob from host bytes.
 * @param {object} bridge
 * @param {object} kit
 * @param {object} BlobCtor
 * @param {Uint8Array} bytes
 * @param {string} type
 */
function createBlob(bridge, kit, BlobCtor, bytes, type) {
  const { ctx } = bridge
  const copy = bytes.slice()
  const part = ctx.newArrayBuffer(copy.buffer)
  const parts = ctx.newArray()
  ctx.setProp(parts, 0, part)
  const options = ctx.newObject()
  const typeHandle = ctx.newString(type)
  ctx.setProp(options, 'type', typeHandle)
  const result = ctx.callFunction(BlobCtor, ctx.undefined, [parts, options])
  part.dispose()
  parts.dispose()
  options.dispose()
  typeHandle.dispose()
  if (result.error) {
    result.error.dispose()
    throw new TypeError('Failed to construct Blob')
  }
  return result.value
}

/**
 * Resolve a Blob slice index against the byte length, including negative
 * offsets from the end.
 * @param {object} bridge
 * @param {object[]} args
 * @param {number} index
 * @param {number} length
 * @param {number} fallback
 */
function relativeIndex(bridge, args, index, length, fallback) {
  const value = bridge.num(args, index, Number.NaN)
  if (!Number.isFinite(value)) return fallback
  const index0 = Math.trunc(value)
  if (index0 < 0) return Math.max(length + index0, 0)
  return Math.min(index0, length)
}

/**
 * `File`: a Blob with a name and modification time, inheriting Blob's methods.
 * @param {object} bridge
 * @param {object} kit
 * @param {object} BlobCtor
 */
function installFile(bridge, kit, BlobCtor) {
  const { ctx, clock } = bridge
  const { states } = kit

  const initialize = bridge.fn('initialize', 4, ({ args }) => {
    const [self, parts, name, optionsHandle] = args
    const bytes = readBlobBytes(bridge, kit, parts)
    const options = bridge.fromGuest(optionsHandle) ?? {}
    const type = typeof options.type === 'string' ? options.type : ''
    const lastModified = Number.isFinite(options.lastModified) ? options.lastModified : clock.now()
    const blob = new Blob([bytes], { type })
    states.set(self, {
      blob,
      bytes,
      type: blob.type,
      name: ctx.typeof(name) === 'undefined' ? 'undefined' : kit.toText(name),
      lastModified,
      webkitRelativePath: '',
    })
    return ctx.undefined
  })

  const FileCtor = bridge.nativeConstructor({
    name: 'File',
    arity: 2,
    bindings: { initialize },
    body: 'initialize(self, arguments[0], arguments[1], arguments[2]);',
  })
  kit.setToStringTag(FileCtor, 'File')
  kit.extend(FileCtor, BlobCtor)

  const proto = ctx.getProp(FileCtor, 'prototype')
  kit.defineGetter(proto, 'name', ({ thisHandle }) => ctx.newString(states.require(thisHandle).name))
  kit.defineGetter(proto, 'lastModified', ({ thisHandle }) => ctx.newNumber(states.require(thisHandle).lastModified))
  kit.defineGetter(proto, 'webkitRelativePath', ({ thisHandle }) =>
    ctx.newString(states.require(thisHandle).webkitRelativePath),
  )
  proto.dispose()

  bridge.install(bridge.global, 'File', FileCtor, { enumerable: true, configurable: true, writable: true })
  return FileCtor
}

// ---------------------------------------------------------------------------
// FormData
// ---------------------------------------------------------------------------

/**
 * `FormData` with its own ordered entry list so blob/file entries are returned
 * as the exact guest objects that were appended.
 * @param {object} bridge
 * @param {object} kit
 */
function installFormData(bridge, kit) {
  const { ctx } = bridge
  const { states, retain, valueIterator, pairIterator } = kit

  const initialize = bridge.fn('initialize', 1, ({ args }) => {
    states.set(args[0], { entries: [] })
    return ctx.undefined
  })

  const FormDataCtor = bridge.nativeConstructor({
    name: 'FormData',
    arity: 0,
    bindings: { initialize },
    body: 'initialize(self);',
  })
  kit.setToStringTag(FormDataCtor, 'FormData')

  /** Entry from a guest value: blob-backed or string. */
  const entryOf = (handle) => {
    if (!isHandle(handle)) return { text: '' }
    if (ctx.typeof(handle) === 'object' && states.get(handle)?.bytes) {
      return { blob: retain(handle.dup()) }
    }
    return { text: kit.toText(handle) }
  }

  const append = (args, thisHandle, replace) => {
    const name = kit.argumentText(args, 0)
    const entry = entryOf(args[1])
    const entries = states.require(thisHandle).entries
    const record = { name, ...entry }
    if (replace) {
      const index = entries.findIndex((item) => item.name === name)
      if (index >= 0) {
        entries[index] = record
        emitEntry(replace, record)
        return
      }
    }
    entries.push(record)
    emitEntry(replace, record)
  }

  const emitEntry = (replace, record) => {
    bridge.emit('api', 'before', {
      api: `FormData.${replace ? 'set' : 'append'}`,
      name: record.name,
      kind: record.blob ? 'blob' : 'string',
      size: record.text ? record.text.length : undefined,
    })
  }

  const proto = ctx.getProp(FormDataCtor, 'prototype')
  const method = (name, fn) => bridge.install(proto, name, fn, { enumerable: true, configurable: true, writable: true })

  method('append', bridge.fn('append', 2, ({ args, thisHandle }) => {
    append(args, thisHandle, false)
    return ctx.undefined
  }))
  method('set', bridge.fn('set', 2, ({ args, thisHandle }) => {
    append(args, thisHandle, true)
    return ctx.undefined
  }))

  const entryValue = (entry) => (entry.blob ? entry.blob.dup() : ctx.newString(entry.text))
  const iteratorValue = (entry) => entry.blob ?? entry.text

  method('get', bridge.fn('get', 1, ({ args, thisHandle }) => {
    const entry = states.require(thisHandle).entries.find((item) => item.name === kit.argumentText(args, 0))
    return entry ? entryValue(entry) : ctx.null
  }))

  method('getAll', bridge.fn('getAll', 1, ({ args, thisHandle }) => {
    const name = kit.argumentText(args, 0)
    const entries = states.require(thisHandle).entries.filter((item) => item.name === name)
    const array = ctx.newArray()
    entries.forEach((entry, index) => {
      const handle = entryValue(entry)
      ctx.setProp(array, index, handle)
      handle.dispose()
    })
    return array
  }))

  method('has', bridge.fn('has', 1, ({ args, thisHandle }) =>
    states.require(thisHandle).entries.some((item) => item.name === kit.argumentText(args, 0)) ? ctx.true : ctx.false,
  ))

  method('delete', bridge.fn('delete', 1, ({ args, thisHandle }) => {
    const name = kit.argumentText(args, 0)
    const state = states.require(thisHandle)
    state.entries = state.entries.filter((item) => item.name !== name)
    return ctx.undefined
  }))

  const entriesFn = bridge.fn('entries', 0, ({ thisHandle }) =>
    pairIterator(states.require(thisHandle).entries.map((entry) => [entry.name, iteratorValue(entry)])),
  )
  method('entries', entriesFn)
  method('keys', bridge.fn('keys', 0, ({ thisHandle }) =>
    valueIterator(states.require(thisHandle).entries.map((entry) => entry.name)),
  ))
  method('values', bridge.fn('values', 0, ({ thisHandle }) =>
    valueIterator(states.require(thisHandle).entries.map((entry) => iteratorValue(entry))),
  ))
  kit.setIterator(FormDataCtor, entriesFn)

  method('forEach', bridge.fn('forEach', 1, ({ args, thisHandle }) => {
    const callback = args[0]
    if (!callback || ctx.typeof(callback) !== 'function') {
      throw new TypeError("Failed to execute 'forEach' on 'FormData': parameter 1 is not of type 'Function'.")
    }
    const thisArg = args.length > 1 ? args[1] : ctx.undefined
    for (const entry of states.require(thisHandle).entries) {
      const valueHandle = entryValue(entry)
      const nameHandle = ctx.newString(entry.name)
      const result = ctx.callFunction(callback, thisArg, [valueHandle, nameHandle, thisHandle])
      valueHandle.dispose()
      nameHandle.dispose()
      if (result.error) return { error: result.error }
      result.value.dispose()
    }
    return ctx.undefined
  }))
  proto.dispose()

  bridge.install(bridge.global, 'FormData', FormDataCtor, { enumerable: true, configurable: true, writable: true })
  return FormDataCtor
}

