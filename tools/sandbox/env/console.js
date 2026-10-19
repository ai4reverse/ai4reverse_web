/**
 * Browser console surface.
 *
 * Console output is one of the richest sources of analyst signal: samples print
 * decrypted strings, error objects, looted values and "debug" markers. Every
 * call is recorded as a structured trace event *and* kept in a bounded buffer
 * on the analysis result, while the guest sees the normal `undefined` return
 * value and Chrome's format specifier handling (`%s`, `%d`, `%o`, `%c`).
 */

export const meta = { id: 'console', order: 20, requires: [] }

const METHODS = [
  ['log', 0],
  ['info', 0],
  ['warn', 0],
  ['error', 0],
  ['debug', 0],
  ['trace', 0],
  ['dir', 1],
  ['dirxml', 1],
  ['table', 1],
  ['group', 0],
  ['groupCollapsed', 0],
  ['groupEnd', 0],
  ['assert', 1],
  ['count', 1],
  ['countReset', 1],
  ['time', 1],
  ['timeEnd', 1],
  ['timeLog', 1],
  ['clear', 0],
  ['profile', 1],
  ['profileEnd', 1],
  ['timeStamp', 1],
]

export function install(bridge) {
  const { ctx, profile } = bridge
  const consoleObject = bridge.obj()
  const buffer = []
  const counters = new Map()
  let groupDepth = 0

  const record = (method, args) => {
    const values = args.map((arg) => bridge.fromGuest(arg))
    const first = typeof values[0] === 'string' ? format(values[0], values.slice(1)) : undefined
    const entry = {
      method,
      group: groupDepth,
      text: first ?? values.map((value) => preview(value)).join(' '),
      values: values.map((value) => preview(value)),
    }
    if (buffer.length < 5000) buffer.push(entry)
    bridge.emit('api', 'before', { api: `console.${method}`, text: entry.text.slice(0, 2048), group: groupDepth })
    bridge.clock?.tick?.(1)
  }

  for (const [name, arity] of METHODS) {
    const handler = bridge.fn(name, arity, ({ args }) => {
      if (name === 'group' || name === 'groupCollapsed') {
        record(name, args)
        groupDepth += 1
        return ctx.undefined
      }
      if (name === 'groupEnd') {
        groupDepth = Math.max(0, groupDepth - 1)
        return ctx.undefined
      }
      if (name === 'count' || name === 'countReset') {
        const label = bridge.str(args, 0, 'default')
        const next = name === 'count' ? (counters.get(label) ?? 0) + 1 : 0
        counters.set(label, next)
        bridge.emit('api', 'before', { api: `console.${name}`, label, count: next })
        return ctx.undefined
      }
      if (name === 'time' || name === 'timeEnd' || name === 'timeLog') {
        const label = bridge.str(args, 0, 'default')
        bridge.emit('api', 'before', { api: `console.${name}`, label })
        return ctx.undefined
      }
      record(name, args)
      return ctx.undefined
    })
    bridge.install(consoleObject, name, handler, { enumerable: true, configurable: true, writable: true })
  }

  // Chrome exposes a MemoryInfo object on console.memory; Firefox does not.
  if (profile.browser !== 'firefox') {
    const memory = bridge.obj({
      jsHeapSizeLimit: 2_174_617_600,
      totalJSHeapSize: 12_345_678,
      usedJSHeapSize: 9_876_543,
    })
    bridge.install(consoleObject, 'memory', memory, { enumerable: true, configurable: true, writable: true })
  }

  // console._commandLineAPI exists in DevTools only; samples probe it to detect
  // an open console. It must be absent.
  bridge.install(bridge.global, 'console', consoleObject, {
    enumerable: true,
    configurable: true,
    writable: true,
  })

  bridge.onDispose(() => {
    bridge.emit('sandbox', 'emit', {
      event: 'console.detached',
      entries: buffer.length,
      sample: buffer.slice(-20),
    })
  })
}

/**
 * Minimal printf-style formatting matching the browser's console behaviour for
 * the specifiers malware actually uses.
 */
function format(template, args) {
  let index = 0
  const text = template.replace(/%([sdifoOc%])/g, (match, specifier) => {
    if (specifier === '%') return '%'
    if (index >= args.length) return match
    const value = args[index]
    index += 1
    if (specifier === 'c') return ''
    if (specifier === 'd' || specifier === 'i') return String(Number.parseInt(value, 10))
    if (specifier === 'f') return String(Number(value))
    if (specifier === 'o' || specifier === 'O') return preview(value)
    return String(value)
  })
  const rest = args.slice(index)
  return rest.length > 0 ? `${text} ${rest.map((value) => preview(value)).join(' ')}` : text
}

function preview(value, depth = 0) {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  const type = typeof value
  if (type === 'string') return value.length > 2000 ? `${value.slice(0, 2000)}…` : value
  if (type === 'number' || type === 'boolean' || type === 'bigint') return String(value)
  if (type === 'function') return `ƒ ${value.name ?? ''}()`
  if (type === '__type') return '[Object]'
  if (depth > 2) return '…'
  try {
    return JSON.stringify(value, (key, item) => (typeof item === 'function' ? '[Function]' : item))?.slice(0, 2000) ?? String(value)
  } catch {
    return '[object]'
  }
}
