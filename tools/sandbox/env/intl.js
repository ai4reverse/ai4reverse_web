/**
 * `Intl` and the locale-aware built-in methods.
 *
 * quickjs-emscripten has no ECMA-402 support at all: `typeof Intl` is
 * `'undefined'`, `Number.prototype.toLocaleString` returns the bare digits and
 * `Date.prototype.toLocaleString` a locale-free date. A sample that calls
 * `Intl.DateTimeFormat` — or merely feature-tests `Intl` — therefore learns on
 * its first line that it is not in a browser.
 *
 * Node ships full ICU and its `Intl` *is* the implementation a browser runs, so
 * nothing here reimplements formatting: the guest gets a browser-shaped `Intl`
 * and the host computes every string.
 *
 *  - Each guest instance keeps its host formatter in a closure-private
 *    `WeakMap` slot, so no internal id is enumerable, named or otherwise
 *    visible to analysed code.
 *  - Every guest function is a `newFunctionWithOptions` native (stringifies to
 *    `[native code]`, so `String(Intl.DateTimeFormat)` matches the platform, and
 *    a patched `toLocaleString` carries no `prototype` own property) or a guest
 *    shim registered with the stealth masker. Members and methods are
 *    non-enumerable, exactly as ECMA-402 says.
 *  - The defaults come from `bridge.profile`: the locale and the time zone are
 *    the ones `navigator.language` and `Date#getTimezoneOffset()` claim, so
 *    `Intl.DateTimeFormat().resolvedOptions().timeZone` cannot contradict the
 *    rest of the environment (the numbering system then follows from the
 *    locale, as it does in a browser).
 *  - `Intl.DateTimeFormat.prototype.format` converts its argument through the
 *    *guest's* own `valueOf`, so a virtual clock and a sample that patched
 *    `Date` are both respected instead of the host wall clock.
 *
 * Omitted on purpose: `Intl.Segmenter`, `formatRange`/`formatRangeToParts`,
 * iterator inputs to `ListFormat`, `PluralRules#selectRange`, `Locale` getters
 * beyond the scalar fields, and the `v8`-only helpers. A sample that only
 * formats, compares, pluralises or localises cannot observe the difference.
 */

import { isHandle } from '../bridge.js'

export const meta = { id: 'intl', order: 110, requires: ['globals'] }

/** Host Intl: the same ICU data a browser uses, so output is authentic. */
const hostIntl = Intl

const SUPPORTED_VALUE_KEYS = new Set([
  'calendar',
  'collation',
  'currency',
  'numberingSystem',
  'timeZone',
  'unit',
])

/**
 * `Intl.supportedValuesOf` needs ICU 72+; a small-ICU host build omits it. The
 * fallback keeps feature probes on a plausible list instead of throwing.
 */
const FALLBACK_SUPPORTED_VALUES = {
  calendar: ['buddhist', 'chinese', 'coptic', 'ethiopic', 'gregory', 'hebrew', 'indian', 'islamic', 'iso8601', 'japanese', 'persian', 'roc'],
  collation: ['big5han', 'compat', 'dict', 'emoji', 'eor', 'gb2312', 'phonebk', 'phonetic', 'pinyin', 'searchjl', 'stroke', 'trad', 'unihan', 'zhuyin'],
  currency: ['AED', 'AUD', 'BRL', 'CAD', 'CHF', 'CNY', 'EUR', 'GBP', 'HKD', 'INR', 'JPY', 'KRW', 'MXN', 'RUB', 'SAR', 'SGD', 'TRY', 'TWD', 'USD', 'ZAR'],
  numberingSystem: ['arab', 'arabext', 'beng', 'cyrl', 'deva', 'fullwide', 'grek', 'gujr', 'guru', 'hanidec', 'khmr', 'knda', 'laoo', 'latn', 'mlym', 'mong', 'mymr', 'orya', 'taml', 'telu', 'thai', 'tibt'],
  timeZone: ['Africa/Cairo', 'Africa/Johannesburg', 'America/Chicago', 'America/Los_Angeles', 'America/New_York', 'America/Sao_Paulo', 'Asia/Dubai', 'Asia/Hong_Kong', 'Asia/Kolkata', 'Asia/Shanghai', 'Asia/Tokyo', 'Australia/Sydney', 'Europe/Berlin', 'Europe/London', 'Europe/Moscow', 'Europe/Paris', 'Pacific/Auckland', 'UTC'],
  unit: ['acre', 'bit', 'byte', 'celsius', 'centimeter', 'day', 'degree', 'fahrenheit', 'fluid-ounce', 'foot', 'gallon', 'gigabit', 'gigabyte', 'gram', 'hectare', 'hour', 'inch', 'kilobit', 'kilobyte', 'kilogram', 'kilometer', 'liter', 'megabit', 'megabyte', 'meter', 'mile', 'milliliter', 'millimeter', 'millisecond', 'minute', 'month', 'ounce', 'percent', 'petabyte', 'pound', 'second', 'stone', 'terabit', 'terabyte', 'week', 'yard', 'year'],
}

/** Descriptor flags shared by every ECMA-402 prototype method and static. */
const METHOD_FLAGS = { enumerable: false, configurable: true, writable: true }

/** Scalar `Intl.Locale` fields exposed as prototype accessors, as in Chrome. */
const LOCALE_FIELDS = [
  'baseName',
  'language',
  'script',
  'region',
  'calendar',
  'numberingSystem',
  'hourCycle',
  'caseFirst',
  'collation',
  'numeric',
]

/**
 * @param {object} bridge host bridge (see docs/CONTRACTS.md)
 */
export function install(bridge) {
  const { ctx, clock, profile } = bridge
  const { language, timezone } = profile

  // ---- guest helpers -----------------------------------------------------
  /** Compile a guest expression once and dispose it with the sandbox. */
  const guest = (source) => {
    const handle = ctx.unwrapResult(ctx.evalCode(source, 'ai4r-internal:intl'))
    bridge.onDispose(() => {
      try {
        handle.dispose()
      } catch {
        /* already disposed */
      }
    })
    return handle
  }

  /** `Number(v)`: runs the guest's `valueOf`/`getTime`, never a host shortcut. */
  const numeric = guest('(function(v){ return Number(v) })')
  /** `"" + v`: ToString, including the guest's `toString` overrides. */
  const textual = guest('(function(v){ return "" + v })')
  const brandOf = guest('(function(v){ return Object.prototype.toString.call(v) })')
  const weakMapGet = guest('(function(map, key){ return map.get(key) })')
  const weakMapSet = guest('(function(map, key, value){ map.set(key, value); })')
  const brandPrototype = guest('(function(ctor, tag){ Object.defineProperty(ctor.prototype, Symbol.toStringTag, { value: tag, configurable: true }); })')
  const brandObject = guest('(function(target, tag){ Object.defineProperty(target, Symbol.toStringTag, { value: tag, configurable: true }); })')
  const localeBuilder = guest('(function(Locale, tag){ return new Locale(tag) })')
  /**
   * `Array.prototype.toLocaleString` in one guest frame: holes, nullish entries,
   * getters, nested arrays and elements overriding `toLocaleString` all behave
   * as in a browser because the iteration itself is guest code.
   */
  const arrayJoin = guest(
    '(function(array, locales, options){\n' +
    '  if (array === undefined || array === null) throw new TypeError("Array.prototype.toLocaleString called on null or undefined");\n' +
    '  var out = [];\n' +
    '  for (var i = 0; i < array.length; i++) {\n' +
    '    var element = array[i];\n' +
    '    out.push(element === undefined || element === null ? "" : element.toLocaleString(locales, options));\n' +
    '  }\n' +
    '  return out.join(",");\n' +
    '})',
  )
  /** `Date.prototype.getTime`, captured before any sample can patch it. */
  const dateGetTime = guest('Date.prototype.getTime')
  /** Instance slot map: closure-private, unreachable from guest code. */
  const slots = guest('new WeakMap()')
  /** Bound `format`/`compare` functions, cached per instance as V8 does. */
  const boundCache = guest('new WeakMap()')

  /** Run a two-argument guest helper once at install time. */
  const callWithTag = (helper, target, tag) => {
    const tagHandle = ctx.newString(tag)
    const result = ctx.callFunction(helper, ctx.undefined, [target, tagHandle])
    tagHandle.dispose()
    if (result.error) rethrowGuest(result.error)
    result.value.dispose()
  }

  /** Take a guest built-in by path and dispose the handle afterwards. */
  const withBuiltin = (source, apply) => {
    const handle = ctx.unwrapResult(ctx.evalCode(source, 'ai4r-internal:intl'))
    try {
      apply(handle)
    } finally {
      handle.dispose()
    }
  }

  /** Run `apply` with a constructor's prototype handle. */
  const withPrototype = (ctor, apply) => {
    const proto = ctx.getProp(ctor, 'prototype')
    try {
      apply(proto)
    } finally {
      proto.dispose()
    }
  }

  // ---- conversion helpers ------------------------------------------------
  /** Re-throw a guest error on the host side; `bridge.fn` restores name/message. */
  const rethrowGuest = (handle) => {
    const dumped = ctx.dump(handle)
    handle.dispose()
    const message =
      dumped && typeof dumped === 'object' && typeof dumped.message === 'string' ? dumped.message : String(dumped)
    const error = new Error(message)
    if (dumped && typeof dumped === 'object' && typeof dumped.name === 'string') error.name = dumped.name
    throw error
  }

  /** ToNumber with guest semantics. */
  const readNumber = (handle) => {
    if (!isHandle(handle)) return NaN
    const type = ctx.typeof(handle)
    if (type === 'number') return ctx.getNumber(handle)
    if (type === 'undefined') return NaN
    const result = ctx.callFunction(numeric, ctx.undefined, [handle])
    if (result.error) rethrowGuest(result.error)
    const value = ctx.getNumber(result.value)
    result.value.dispose()
    return value
  }

  /** ToString with guest semantics. */
  const readText = (handle) => {
    if (!isHandle(handle)) return String(handle)
    if (ctx.typeof(handle) === 'string') return ctx.getString(handle)
    const result = ctx.callFunction(textual, ctx.undefined, [handle])
    if (result.error) rethrowGuest(result.error)
    const value = ctx.getString(result.value)
    result.value.dispose()
    return value
  }

  /** `Object.prototype.toString` brand test, e.g. `'[object Date]'`. */
  const hasBrand = (handle, tag) => {
    if (!isHandle(handle)) return false
    const type = ctx.typeof(handle)
    if (type !== 'object' && type !== 'function') return false
    const result = ctx.callFunction(brandOf, ctx.undefined, [handle])
    if (result.error) {
      result.error.dispose()
      return false
    }
    const value = ctx.getString(result.value) === tag
    result.value.dispose()
    return value
  }

  /** Locales argument as a host value; `undefined` means the caller omitted it. */
  const readLocales = (handle) => {
    if (!isHandle(handle) || ctx.typeof(handle) === 'undefined') return undefined
    return bridge.fromGuest(handle)
  }

  /** Options argument as a host value; non-objects are forwarded so the host throws. */
  const readOptions = (handle) => {
    if (!isHandle(handle) || ctx.typeof(handle) === 'undefined') return undefined
    return bridge.fromGuest(handle)
  }

  /** Locale tag summary for the trace payload; never throws. */
  const describeLocales = (handle) => {
    try {
      const value = readLocales(handle)
      if (value === undefined) return language
      return typeof value === 'string' ? value : JSON.stringify(value)
    } catch {
      return language
    }
  }

  /** Guest handle for a host primitive (never bag-tracked, so never freed early). */
  const primitive = (value) => {
    if (value === undefined) return ctx.undefined
    if (value === null) return ctx.null
    switch (typeof value) {
      case 'string':
        return ctx.newString(value)
      case 'number':
        return ctx.newNumber(value)
      case 'boolean':
        return value ? ctx.true : ctx.false
      default:
        throw new TypeError(`Intl: unsupported primitive result ${typeof value}`)
    }
  }

  // ---- default arguments -------------------------------------------------
  /** Date options with the profile time zone applied; an explicit one wins. */
  const dateArgs = (localesHandle, optionsHandle) => {
    const locales = readLocales(localesHandle) ?? language
    const options = readOptions(optionsHandle)
    if (options === undefined) return [locales, { timeZone: timezone }]
    const merged = options !== null && typeof options === 'object' ? { timeZone: timezone, ...options } : options
    return [locales, merged]
  }

  /** Number/list options; the caller's options pass through untouched. */
  const plainArgs = (localesHandle, optionsHandle) => [
    readLocales(localesHandle) ?? language,
    readOptions(optionsHandle),
  ]

  // ---- instance records --------------------------------------------------
  /** @type {Map<number, {kind: string, formatter: object}>} */
  const records = new Map()
  let nextRecordId = 0

  const remember = (record) => {
    nextRecordId += 1
    records.set(nextRecordId, record)
    return nextRecordId
  }

  /** Record of the receiver, or `null` when `this` is not an `Intl` instance. */
  const recordOf = (thisHandle) => {
    if (!isHandle(thisHandle)) return null
    const result = ctx.callFunction(weakMapGet, ctx.undefined, [slots, thisHandle])
    if (result.error) {
      result.error.dispose()
      return null
    }
    const id = ctx.dump(result.value)
    result.value.dispose()
    return typeof id === 'number' ? records.get(id) ?? null : null
  }

  /** Record of the receiver, throwing the platform TypeError otherwise. */
  const requireRecord = (thisHandle, kind, method) => {
    const record = recordOf(thisHandle)
    if (!record || record.kind !== kind) {
      throw new TypeError(`Method Intl.${kind}.prototype.${method} called on incompatible receiver`)
    }
    return record
  }

  // ---- installation helpers ---------------------------------------------
  /** Emit the `api` trace event the env contract requires for every call. */
  const traced = (api, impl) => (call) => {
    bridge.emit('api', 'before', { api })
    return impl(call)
  }

  /** Install one prototype/static method with browser descriptor flags. */
  const installMethod = (target, key, length, api, impl, flags = METHOD_FLAGS) => {
    bridge.install(target, key, bridge.fn(key, length, traced(api, impl)), flags)
  }

  /** `Intl.<Ctor>.supportedLocalesOf(locales)` delegated to the host constructor. */
  const supportedLocalesOf = (hostCtor) =>
    bridge.fn('supportedLocalesOf', 1, ({ args }) => bridge.arr(hostCtor.supportedLocalesOf(readLocales(args[0]))))

  /** Create one guest `Intl` constructor backed by a host formatter. */
  const defineConstructor = (name, length, create) => {
    const init = bridge.fn(name, length, ({ args }) => {
      bridge.emit('api', 'before', { api: `Intl.${name}`, locale: describeLocales(args[0]) })
      return ctx.newNumber(remember({ kind: name, formatter: create(args[0], args[1]) }))
    })
    const ctor = bridge.nativeConstructor({
      name,
      arity: length,
      bindings: { __slots: slots, __init: init },
      body: '__slots.set(self, __init(arguments[0], arguments[1]));',
    })
    bridge.install(ctor, 'supportedLocalesOf', supportedLocalesOf(hostIntl[name]), METHOD_FLAGS)
    callWithTag(brandPrototype, ctor, `Intl.${name}`)
    return ctor
  }

  /** Bound-function cache lookup: the guest function when already materialised. */
  const readBound = (thisHandle) => {
    const result = ctx.callFunction(weakMapGet, ctx.undefined, [boundCache, thisHandle])
    if (result.error) {
      result.error.dispose()
      return null
    }
    if (ctx.typeof(result.value) !== 'function') {
      result.value.dispose()
      return null
    }
    return result.value
  }

  const writeBound = (thisHandle, fn) => {
    const result = ctx.callFunction(weakMapSet, ctx.undefined, [boundCache, thisHandle, fn])
    if (result.error) result.error.dispose()
    else result.value.dispose()
  }

  /**
   * Install `format`/`compare` as an accessor returning a cached bound
   * function, the shape V8 uses (arity 1, empty `name`, stable identity).
   */
  const installBoundMethod = (proto, key, kind, createImpl) => {
    const getter = Object.defineProperty(
      ({ thisHandle }) => {
        const record = requireRecord(thisHandle, kind, key)
        const cached = readBound(thisHandle)
        if (cached) return cached
        const fn = bridge.fn('', 1, traced(`Intl.${kind}.prototype.${key}`, createImpl(record)))
        writeBound(thisHandle, fn)
        return fn
      },
      'name',
      { value: `get ${key}` },
    )
    bridge.accessor(proto, key, { get: getter, enumerable: false })
  }

  // ---- receiver conversions ----------------------------------------------
  /** Primitive value of a Number receiver (or a Number object). */
  const numberThis = (thisHandle, method) => {
    if (isHandle(thisHandle)) {
      const type = ctx.typeof(thisHandle)
      if (type === 'number') return ctx.getNumber(thisHandle)
      if (type === 'object' && hasBrand(thisHandle, '[object Number]')) return readNumber(thisHandle)
    }
    throw new TypeError(`Number.prototype.${method} requires that 'this' be a Number`)
  }

  /** Primitive value of a BigInt receiver. */
  const bigintThis = (thisHandle, method) => {
    if (isHandle(thisHandle) && ctx.typeof(thisHandle) === 'bigint') return ctx.getBigInt(thisHandle)
    throw new TypeError(`BigInt.prototype.${method} requires that 'this' be a BigInt`)
  }

  /** Primitive value of a String receiver (or a String object). */
  const stringThis = (thisHandle, method) => {
    if (isHandle(thisHandle)) {
      const type = ctx.typeof(thisHandle)
      if (type === 'string') return ctx.getString(thisHandle)
      if (type === 'object' && hasBrand(thisHandle, '[object String]')) return readText(thisHandle)
    }
    throw new TypeError(`String.prototype.${method} called on incompatible receiver`)
  }

  /** Epoch ms of a Date receiver, validated with the pristine `getTime`. */
  const dateThis = (thisHandle, method) => {
    if (isHandle(thisHandle)) {
      const result = ctx.callFunction(dateGetTime, thisHandle)
      if (!result.error) {
        const value = ctx.getNumber(result.value)
        result.value.dispose()
        return Number.isNaN(value) ? value : Math.trunc(value)
      }
      result.error.dispose()
    }
    throw new TypeError(`Method Date.prototype.${method} called on incompatible receiver`)
  }

  /** Epoch ms of a guest date argument; `undefined` means "now" (virtual). */
  const epochOf = (handle) => {
    if (!isHandle(handle) || ctx.typeof(handle) === 'undefined') return clock.now()
    const value = readNumber(handle)
    return Number.isNaN(value) ? value : Math.trunc(value)
  }

  /** Number or BigInt operand of a NumberFormat-style call. */
  const numericOperand = (handle) => {
    if (isHandle(handle) && ctx.typeof(handle) === 'bigint') return ctx.getBigInt(handle)
    return readNumber(handle)
  }

  // ---- Intl.DateTimeFormat ----------------------------------------------
  const DateTimeFormat = defineConstructor(
    'DateTimeFormat',
    0,
    (locales, options) => new hostIntl.DateTimeFormat(...dateArgs(locales, options)),
  )
  withPrototype(DateTimeFormat, (proto) => {
    installBoundMethod(proto, 'format', 'DateTimeFormat', (record) => ({ args }) =>
      ctx.newString(record.formatter.format(epochOf(args[0]))),
    )
    installMethod(proto, 'formatToParts', 1, 'Intl.DateTimeFormat.prototype.formatToParts', ({ args, thisHandle }) => {
      const record = requireRecord(thisHandle, 'DateTimeFormat', 'formatToParts')
      return bridge.arr(record.formatter.formatToParts(epochOf(args[0])))
    })
    installMethod(proto, 'resolvedOptions', 0, 'Intl.DateTimeFormat.prototype.resolvedOptions', ({ thisHandle }) => {
      const resolved = requireRecord(thisHandle, 'DateTimeFormat', 'resolvedOptions').formatter.resolvedOptions()
      return bridge.obj({
        ...resolved,
        calendar: resolved.calendar ?? 'gregory',
        numberingSystem: resolved.numberingSystem ?? profile.numberingSystem,
        timeZone: resolved.timeZone ?? timezone,
      })
    })
  })

  // ---- Intl.NumberFormat -------------------------------------------------
  const NumberFormat = defineConstructor(
    'NumberFormat',
    0,
    (locales, options) => new hostIntl.NumberFormat(...plainArgs(locales, options)),
  )
  withPrototype(NumberFormat, (proto) => {
    installBoundMethod(proto, 'format', 'NumberFormat', (record) => ({ args }) =>
      ctx.newString(record.formatter.format(numericOperand(args[0]))),
    )
    installMethod(proto, 'formatToParts', 1, 'Intl.NumberFormat.prototype.formatToParts', ({ args, thisHandle }) => {
      const record = requireRecord(thisHandle, 'NumberFormat', 'formatToParts')
      return bridge.arr(record.formatter.formatToParts(numericOperand(args[0])))
    })
    installMethod(proto, 'resolvedOptions', 0, 'Intl.NumberFormat.prototype.resolvedOptions', ({ thisHandle }) =>
      bridge.obj(requireRecord(thisHandle, 'NumberFormat', 'resolvedOptions').formatter.resolvedOptions()),
    )
  })

  // ---- Intl.Collator -----------------------------------------------------
  const Collator = defineConstructor(
    'Collator',
    0,
    (locales, options) => new hostIntl.Collator(...plainArgs(locales, options)),
  )
  withPrototype(Collator, (proto) => {
    installBoundMethod(proto, 'compare', 'Collator', (record) => ({ args }) =>
      ctx.newNumber(record.formatter.compare(readText(args[0]), readText(args[1]))),
    )
    installMethod(proto, 'resolvedOptions', 0, 'Intl.Collator.prototype.resolvedOptions', ({ thisHandle }) =>
      bridge.obj(requireRecord(thisHandle, 'Collator', 'resolvedOptions').formatter.resolvedOptions()),
    )
  })

  // ---- Intl.RelativeTimeFormat ------------------------------------------
  const RelativeTimeFormat = defineConstructor(
    'RelativeTimeFormat',
    0,
    (locales, options) => new hostIntl.RelativeTimeFormat(...plainArgs(locales, options)),
  )
  withPrototype(RelativeTimeFormat, (proto) => {
    installMethod(proto, 'format', 2, 'Intl.RelativeTimeFormat.prototype.format', ({ args, thisHandle }) => {
      const record = requireRecord(thisHandle, 'RelativeTimeFormat', 'format')
      return ctx.newString(record.formatter.format(readNumber(args[0]), readText(args[1])))
    })
    installMethod(proto, 'formatToParts', 2, 'Intl.RelativeTimeFormat.prototype.formatToParts', ({ args, thisHandle }) =>
      bridge.arr(
        requireRecord(thisHandle, 'RelativeTimeFormat', 'formatToParts').formatter.formatToParts(
          readNumber(args[0]),
          readText(args[1]),
        ),
      ),
    )
    installMethod(proto, 'resolvedOptions', 0, 'Intl.RelativeTimeFormat.prototype.resolvedOptions', ({ thisHandle }) =>
      bridge.obj(requireRecord(thisHandle, 'RelativeTimeFormat', 'resolvedOptions').formatter.resolvedOptions()),
    )
  })

  // ---- Intl.PluralRules --------------------------------------------------
  const PluralRules = defineConstructor(
    'PluralRules',
    0,
    (locales, options) => new hostIntl.PluralRules(...plainArgs(locales, options)),
  )
  withPrototype(PluralRules, (proto) => {
    installMethod(proto, 'select', 1, 'Intl.PluralRules.prototype.select', ({ args, thisHandle }) =>
      ctx.newString(requireRecord(thisHandle, 'PluralRules', 'select').formatter.select(readNumber(args[0]))),
    )
    installMethod(proto, 'resolvedOptions', 0, 'Intl.PluralRules.prototype.resolvedOptions', ({ thisHandle }) =>
      bridge.obj(requireRecord(thisHandle, 'PluralRules', 'resolvedOptions').formatter.resolvedOptions()),
    )
  })

  // ---- Intl.ListFormat ---------------------------------------------------
  const ListFormat = defineConstructor(
    'ListFormat',
    0,
    (locales, options) => new hostIntl.ListFormat(...plainArgs(locales, options)),
  )
  /** String entries of a guest array argument. */
  const readStringList = (handle) => {
    if (!isHandle(handle) || ctx.typeof(handle) === 'undefined') return undefined
    return bridge.list(handle).map((value) => (typeof value === 'string' ? value : String(value)))
  }
  withPrototype(ListFormat, (proto) => {
    installMethod(proto, 'format', 1, 'Intl.ListFormat.prototype.format', ({ args, thisHandle }) =>
      ctx.newString(requireRecord(thisHandle, 'ListFormat', 'format').formatter.format(readStringList(args[0]))),
    )
    installMethod(proto, 'formatToParts', 1, 'Intl.ListFormat.prototype.formatToParts', ({ args, thisHandle }) =>
      bridge.arr(
        requireRecord(thisHandle, 'ListFormat', 'formatToParts').formatter.formatToParts(readStringList(args[0])),
      ),
    )
    installMethod(proto, 'resolvedOptions', 0, 'Intl.ListFormat.prototype.resolvedOptions', ({ thisHandle }) =>
      bridge.obj(requireRecord(thisHandle, 'ListFormat', 'resolvedOptions').formatter.resolvedOptions()),
    )
  })

  // ---- Intl.DisplayNames -------------------------------------------------
  const DisplayNames = defineConstructor(
    'DisplayNames',
    2,
    (locales, options) => new hostIntl.DisplayNames(...plainArgs(locales, options)),
  )
  withPrototype(DisplayNames, (proto) => {
    installMethod(proto, 'of', 1, 'Intl.DisplayNames.prototype.of', ({ args, thisHandle }) => {
      const record = requireRecord(thisHandle, 'DisplayNames', 'of')
      const code = isHandle(args[0]) && ctx.typeof(args[0]) === 'undefined' ? undefined : readText(args[0])
      return primitive(record.formatter.of(code))
    })
    installMethod(proto, 'resolvedOptions', 0, 'Intl.DisplayNames.prototype.resolvedOptions', ({ thisHandle }) =>
      bridge.obj(requireRecord(thisHandle, 'DisplayNames', 'resolvedOptions').formatter.resolvedOptions()),
    )
  })

  // ---- Intl.Locale -------------------------------------------------------
  const Locale = defineConstructor('Locale', 1, (tag, options) => {
    const value = isHandle(tag) && ctx.typeof(tag) === 'undefined' ? undefined : readText(tag)
    return new hostIntl.Locale(value, readOptions(options))
  })

  /** Build a guest `Intl.Locale` from a host Locale (maximize/minimize results). */
  const buildLocale = (hostLocale) => {
    const tagHandle = ctx.newString(hostLocale.toString())
    // The guest call dups its arguments, so the temporary handle is freed here.
    const result = ctx.callFunction(localeBuilder, ctx.undefined, [Locale, tagHandle])
    tagHandle.dispose()
    if (result.error) rethrowGuest(result.error)
    return result.value
  }

  withPrototype(Locale, (proto) => {
    for (const key of LOCALE_FIELDS) {
      const getter = Object.defineProperty(
        ({ thisHandle }) => primitive(requireRecord(thisHandle, 'Locale', key).formatter[key]),
        'name',
        { value: `get ${key}` },
      )
      bridge.accessor(proto, key, { get: getter, enumerable: false })
    }
    installMethod(proto, 'maximize', 0, 'Intl.Locale.prototype.maximize', ({ thisHandle }) =>
      buildLocale(requireRecord(thisHandle, 'Locale', 'maximize').formatter.maximize()),
    )
    installMethod(proto, 'minimize', 0, 'Intl.Locale.prototype.minimize', ({ thisHandle }) =>
      buildLocale(requireRecord(thisHandle, 'Locale', 'minimize').formatter.minimize()),
    )
    installMethod(proto, 'toString', 0, 'Intl.Locale.prototype.toString', ({ thisHandle }) =>
      ctx.newString(requireRecord(thisHandle, 'Locale', 'toString').formatter.toString()),
    )
  })

  // ---- the Intl object ---------------------------------------------------
  const getCanonicalLocales = bridge.fn('getCanonicalLocales', 1, ({ args }) =>
    bridge.arr(hostIntl.getCanonicalLocales(readLocales(args[0]))),
  )
  const supportedValuesOf = bridge.fn('supportedValuesOf', 1, ({ args }) => {
    const key = readText(args[0])
    if (typeof hostIntl.supportedValuesOf === 'function') return bridge.arr(hostIntl.supportedValuesOf(key))
    if (!SUPPORTED_VALUE_KEYS.has(key)) throw new RangeError(`Invalid key : ${key}`)
    return bridge.arr(FALLBACK_SUPPORTED_VALUES[key])
  })

  const intl = bridge.obj()
  // ECMA-402 defines these as non-enumerable, so `Object.keys(Intl)` is empty
  // in every browser; the order below is the spec's own ordering.
  const members = {
    getCanonicalLocales,
    Collator,
    DateTimeFormat,
    DisplayNames,
    ListFormat,
    Locale,
    NumberFormat,
    PluralRules,
    RelativeTimeFormat,
    supportedValuesOf,
  }
  for (const [key, value] of Object.entries(members)) {
    bridge.install(intl, key, value, METHOD_FLAGS)
  }
  callWithTag(brandObject, intl, 'Intl')
  bridge.install(bridge.global, 'Intl', intl, { enumerable: false, configurable: true, writable: true })

  // ---- locale-aware built-in methods -------------------------------------
  // Each replacement delegates to host ICU and never re-enters the guest
  // implementation it shadows, so arithmetic and argument handling elsewhere in
  // the prototype are untouched.
  withBuiltin('Number.prototype', (proto) => {
    installMethod(proto, 'toLocaleString', 0, 'Number.prototype.toLocaleString', ({ args, thisHandle }) => {
      const value = numberThis(thisHandle, 'toLocaleString')
      const formatter = new hostIntl.NumberFormat(...plainArgs(args[0], args[1]))
      return ctx.newString(formatter.format(value))
    })
  })

  withBuiltin('BigInt.prototype', (proto) => {
    installMethod(proto, 'toLocaleString', 0, 'BigInt.prototype.toLocaleString', ({ args, thisHandle }) => {
      const value = bigintThis(thisHandle, 'toLocaleString')
      const formatter = new hostIntl.NumberFormat(...plainArgs(args[0], args[1]))
      return ctx.newString(formatter.format(value))
    })
  })

  withBuiltin('Date.prototype', (proto) => {
    for (const name of ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString']) {
      installMethod(proto, name, 0, `Date.prototype.${name}`, ({ args, thisHandle }) => {
        const epoch = dateThis(thisHandle, name)
        const [locales, options] = dateArgs(args[0], args[1])
        return ctx.newString(new Date(epoch)[name](locales, options))
      })
    }
  })

  withBuiltin('String.prototype', (proto) => {
    installMethod(proto, 'localeCompare', 1, 'String.prototype.localeCompare', ({ args, thisHandle }) => {
      const value = stringThis(thisHandle, 'localeCompare')
      const that = readText(args[0])
      const [locales, options] = plainArgs(args[1], args[2])
      // With no `locales` argument the profile locale decides, exactly as
      // navigator.language does in a browser.
      return ctx.newNumber(value.localeCompare(that, locales, options))
    })
  })

  withBuiltin('Array.prototype', (proto) => {
    installMethod(proto, 'toLocaleString', 0, 'Array.prototype.toLocaleString', ({ args, thisHandle }) => {
      const localesArg = isHandle(args[0]) ? args[0] : ctx.undefined
      const optionsArg = isHandle(args[1]) ? args[1] : ctx.undefined
      const result = ctx.callFunction(arrayJoin, ctx.undefined, [thisHandle, localesArg, optionsArg])
      if (result.error) rethrowGuest(result.error)
      const text = ctx.getString(result.value)
      result.value.dispose()
      return ctx.newString(text)
    })
  })
}
