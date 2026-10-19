/**
 * Virtual `Date` — the sandbox's only time and timezone source.
 *
 * QuickJS's own `Date` reads the host wall clock and the host timezone, which
 * breaks a `zh-CN` / `Asia/Shanghai` profile running on a UTC machine in two
 * ways: every timezone-sensitive fingerprint contradicts `navigator.language`,
 * and `Date.now()` deltas reveal how fast the host really executes. This module
 * replaces the constructor with a guest shim whose clock is `bridge.clock` and
 * whose local-time methods use `profile.timezoneOffsetMinutes`.
 *
 * Design notes:
 *  - `Date.prototype` stays the engine's original prototype, so every instance
 *    remains a genuine Date: `instanceof`, `Object.prototype.toString`,
 *    `valueOf`, the UTC accessors and `toISOString` keep native behaviour and
 *    engine storage. Only the constructor is swapped.
 *  - Local-time methods are host functions (`bridge.fn`), hence already
 *    native-looking; they read the instant through the engine's `getTime` and
 *    write it back through its `setTime`, so no guest-visible epoch field exists
 *    that a sample could tamper with.
 *  - Local arithmetic is DST-free on purpose: `profile.timezoneOffsetMinutes` is
 *    a single fixed offset, so one instant always maps to the same local fields
 *    and a replay on any host produces an identical result. `getTimezoneOffset`
 *    reports that same fixed value, and the numeric label (`GMT+0800`) is
 *    derived from it.
 *  - Formatting is delegated to Node's ICU with the profile locale and timezone,
 *    so locale-specific output (zh-CN `2026/10/19 15:20:00`) and the long zone
 *    name (`China Standard Time`) come from the same data a browser would use
 *    while the host timezone stays invisible. ICU describes the *named* zone,
 *    so its name can disagree with the pinned offset away from the profile's
 *    anchor instant (America/New_York pinned at -240 calls a January date
 *    "Eastern Standard Time", Europe/London pinned at 0 is BST in October):
 *    the fixed offset stays authoritative for every numeric field, which is
 *    what keeps replays identical.
 *  - `Date.parse`/`Date.UTC` are the engine's originals: UTC-annotated strings
 *    and UTC field arithmetic are already timezone independent.
 */

import { timezoneOffsetMinutesAt, instantFromLocalFields } from '../../util/timezone.js'

export const meta = { id: 'time', order: 25, requires: ['globals'] }

const MINUTE_MS = 60_000

const WEEKDAYS = Object.freeze(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'])
const MONTHS = Object.freeze([
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
])

/** Local field order shared by the constructor and every setter. */
const FIELD_YEAR = 0
const FIELD_COUNT = 7
/** Spec defaults for `new Date(y, m, ...)`: month 0, date 1, time fields 0. */
const FIELD_DEFAULTS = Object.freeze([0, 0, 1, 0, 0, 0, 0])

const PROTOTYPE_FLAGS = Object.freeze({ enumerable: false, configurable: true, writable: true })
const GLOBAL_FLAGS = Object.freeze({ enumerable: false, configurable: true, writable: true })

/**
 * Guest-side constructor. It creates real engine Dates through the original
 * constructor, so instances keep engine `[[DateValue]]` storage, and it is
 * registered as a native shim so `Function.prototype.toString` shows
 * `[native code]`. `Date.prototype` is the original prototype object, which is
 * why `new Date(...) instanceof Date` and the inherited UTC methods still work.
 *
 * Bindings: `__now` virtual clock, `__create` epoch -> Date, `__fromLocal` the
 * seven-argument local-time form, `__text` `Date()` as a function, `__Date` the
 * original constructor, `__prototype` the original prototype, `__parse` and
 * `__utc` the preserved statics.
 */
const CONSTRUCTOR_SHIM = [
  '(function (__now, __create, __fromLocal, __text, __Date, __prototype, __parse, __utc, __arg, __parse2) {',
  '  function Date(a0, a1, a2, a3, a4, a5, a6) {',
  '    if (new.target === undefined) return __text(__now());',
  '    switch (arguments.length) {',
  '      case 0: return __create(__now());',
  '      case 1: return __create(__arg(a0));',
  '      default: return __fromLocal(a0, a1, a2, a3, a4, a5, a6, arguments.length);',
  '    }',
  '  }',
  '  Date.prototype = __prototype;',
  '  Date.now = __now;',
  '  Date.parse = __parse2;',
  '  Date.UTC = __utc;',
  '  return Date;',
  '})',
].join('\n')

/** Local-time accessors, evaluated against the UTC fields of the offset instant. */
const LOCAL_GETTERS = Object.freeze([
  ['getFullYear', (local) => local.getUTCFullYear()],
  ['getMonth', (local) => local.getUTCMonth()],
  ['getDate', (local) => local.getUTCDate()],
  ['getDay', (local) => local.getUTCDay()],
  ['getHours', (local) => local.getUTCHours()],
  ['getMinutes', (local) => local.getUTCMinutes()],
  ['getSeconds', (local) => local.getUTCSeconds()],
  ['getMilliseconds', (local) => local.getUTCMilliseconds()],
  ['getYear', (local) => local.getUTCFullYear() - 1900],
])

/**
 * Local-time setters. `args` pairs each guest argument with the local field it
 * replaces; fields without an argument keep the date's current local value.
 * `setYear` alone applies the two-digit-year mapping.
 */
const LOCAL_SETTERS = Object.freeze([
  { name: 'setMilliseconds', length: 1, args: [[6, 0]] },
  { name: 'setSeconds', length: 2, args: [[5, 0], [6, 1]] },
  { name: 'setMinutes', length: 3, args: [[4, 0], [5, 1], [6, 2]] },
  { name: 'setHours', length: 4, args: [[3, 0], [4, 1], [5, 2], [6, 3]] },
  { name: 'setDate', length: 1, args: [[2, 0]] },
  { name: 'setMonth', length: 2, args: [[1, 0], [2, 1]] },
  { name: 'setFullYear', length: 3, args: [[0, 0], [1, 1], [2, 2]] },
  { name: 'setYear', length: 1, args: [[0, 0]], twoDigitYear: true },
])

/** Default component set per locale formatter (browser `Date.prototype` shape). */
const LOCALE_DEFAULTS = Object.freeze({
  toLocaleString: Object.freeze({
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }),
  toLocaleDateString: Object.freeze({ year: 'numeric', month: 'numeric', day: 'numeric' }),
  toLocaleTimeString: Object.freeze({ hour: 'numeric', minute: '2-digit', second: '2-digit' }),
})

/** @param {object} bridge */
export function install(bridge) {
  const { ctx, profile, clock } = bridge

  /** Engine intrinsics retained for the whole run; released at teardown. */
  const captured = []
  const retain = (handle) => {
    captured.push(handle)
    return handle
  }
  bridge.onDispose(() => {
    for (let index = captured.length - 1; index >= 0; index -= 1) {
      try {
        captured[index].dispose()
      } catch {
        /* teardown must never throw */
      }
    }
    captured.length = 0
  })

  // ---- captured intrinsics -------------------------------------------------
  const OriginalDate = retain(ctx.getProp(bridge.global, 'Date'))
  const datePrototype = retain(ctx.getProp(OriginalDate, 'prototype'))
  const originalGetTime = retain(ctx.getProp(datePrototype, 'getTime'))
  const originalSetTime = retain(ctx.getProp(datePrototype, 'setTime'))
  const originalToISOString = retain(ctx.getProp(datePrototype, 'toISOString'))
  const originalParse = retain(ctx.getProp(OriginalDate, 'parse'))
  const originalUtc = retain(ctx.getProp(OriginalDate, 'UTC'))
  /** `new Ctor(value)` — the only way to reach the engine constructor. */
  const constructDate = retain(
    ctx.unwrapResult(ctx.evalCode('(function (Ctor, value) { return new Ctor(value) })', 'ai4r-internal:time')),
  )
  /** Guest ToNumber, so setter arguments coerce exactly as they do in a browser. */
  const toNumber = retain(
    ctx.unwrapResult(ctx.evalCode('(function (value) { return Number(value) })', 'ai4r-internal:time')),
  )

  const offsetMinutesFor = (instant) =>
    Number.isFinite(instant) ? timezoneOffsetMinutesAt(profile.timezone, instant) : NaN
  const offsetMsFor = (instant) => offsetMinutesFor(instant) * MINUTE_MS
  const anchorOffsetMinutes = profile.timezoneOffsetMinutes
  const anchorOffsetText = gmtOffsetText(anchorOffsetMinutes)
  const zoneFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: profile.timezone,
    timeZoneName: 'long',
  })

  // ---- handle plumbing -----------------------------------------------------

  /**
   * Convert a guest error handle into a host error with the same name and
   * release the handle. `bridge.fn` re-throws it as a guest error, so a
   * non-Date receiver produces a real `TypeError` without host frames.
   * @param {{dispose: () => void}} handle
   */
  function takeError(handle) {
    let name = 'TypeError'
    let message = ''
    try {
      const dumped = ctx.dump(handle)
      if (dumped && typeof dumped === 'object') {
        name = dumped.name ?? name
        message = dumped.message ?? ''
      } else {
        message = String(dumped)
      }
    } catch {
      /* a non-dumpable throw becomes a bare TypeError */
    } finally {
      handle.dispose()
    }
    const error = new Error(message || 'not a Date object')
    error.name = name
    return error
  }

  /**
   * The instant behind a guest `this`, read through the engine's `getTime`.
   * @param {object} thisHandle
   */
  function readInstant(thisHandle) {
    const result = ctx.callFunction(originalGetTime, thisHandle, [])
    if (result.error) throw takeError(result.error)
    try {
      return ctx.getNumber(result.value)
    } finally {
      result.value.dispose()
    }
  }

  /**
   * Store an instant through the engine's `setTime`.
   * @returns {object} the guest number handle the setter must return
   */
  function writeInstant(thisHandle, instant) {
    const value = ctx.newNumber(instant)
    try {
      const result = ctx.callFunction(originalSetTime, thisHandle, [value])
      if (result.error) throw takeError(result.error)
      return result.value
    } finally {
      value.dispose()
    }
  }

  /**
   * A real guest Date for an instant (engine storage, engine prototype).
   * @param {number} instant epoch milliseconds
   */
  function createDate(instant) {
    const value = ctx.newNumber(instant)
    try {
      const result = ctx.callFunction(constructDate, ctx.undefined, [OriginalDate, value])
      if (result.error) throw takeError(result.error)
      return result.value
    } finally {
      value.dispose()
    }
  }

  /**
   * Guest `Number(value)` for a setter/constructor argument.
   * @param {object} handle
   */
  function toGuestNumber(handle) {
    const result = ctx.callFunction(toNumber, ctx.undefined, [handle])
    if (result.error) throw takeError(result.error)
    try {
      return ctx.getNumber(result.value)
    } finally {
      result.value.dispose()
    }
  }

  // ---- formatting ----------------------------------------------------------

  /** Host Date whose UTC fields are the profile-local fields of `instant`. */
  const localInstant = (instant) => new Date(instant - offsetMsFor(instant))

  /** Long ICU name for the profile timezone at `instant` ("China Standard Time"). */
  function zoneName(instant) {
    try {
      for (const part of zoneFormatter.formatToParts(new Date(instant))) {
        if (part.type === 'timeZoneName') return part.value
      }
    } catch {
      /* fall back to the numeric offset below */
    }
    return gmtOffsetText(offsetMinutesFor(instant))
  }

  /** Browser `toString` pieces for an instant; `null` for an invalid date. */
  function describe(instant) {
    if (Number.isNaN(instant)) return null
    const local = localInstant(instant)
    const date =
      `${WEEKDAYS[local.getUTCDay()]} ${MONTHS[local.getUTCMonth()]} ` +
      `${pad2(local.getUTCDate())} ${yearText(local.getUTCFullYear())}`
    const time =
      `${pad2(local.getUTCHours())}:${pad2(local.getUTCMinutes())}:${pad2(local.getUTCSeconds())} ` +
      `${gmtOffsetText(offsetMinutesFor(instant))} (${zoneName(instant)})`
    return { date, time, full: `${date} ${time}` }
  }

  /** `Mon Oct 19 2026 15:20:00 GMT+0800 (China Standard Time)` */
  function instantText(instant) {
    const parts = describe(instant)
    return parts ? parts.full : 'Invalid Date'
  }

  /** ISO rendering of an instant through the retained `toISOString`. */
  function isoText(instant) {
    const date = createDate(instant)
    try {
      const result = ctx.callFunction(originalToISOString, date, [])
      if (result.error) {
        takeError(result.error)
        return ''
      }
      try {
        return ctx.getString(result.value)
      } finally {
        result.value.dispose()
      }
    } finally {
      date.dispose()
    }
  }

  // ---- prototype methods ---------------------------------------------------

  /**
   * Install a host function on the engine's Date.prototype. `bridge.fn` builds
   * it with `newFunctionWithOptions`, so `name`, `length` and
   * `Function.prototype.toString` already match a platform function.
   */
  function installPrototypeMethod(name, length, impl) {
    bridge.install(datePrototype, name, bridge.fn(name, length, impl), PROTOTYPE_FLAGS)
  }

  for (const [name, read] of LOCAL_GETTERS) {
    installPrototypeMethod(name, 0, ({ thisHandle }) => ctx.newNumber(read(localInstant(readInstant(thisHandle)))))
  }

  installPrototypeMethod('getTimezoneOffset', 0, ({ thisHandle }) => {
    const instant = readInstant(thisHandle)
    return ctx.newNumber(Number.isNaN(instant) ? NaN : offsetMinutesFor(instant))
  })

  for (const setter of LOCAL_SETTERS) {
    installPrototypeMethod(setter.name, setter.length, ({ args, thisHandle }) => {
      const instant = readInstant(thisHandle)
      if (Number.isNaN(instant)) return ctx.newNumber(NaN)
      const fields = localFieldsOf(localInstant(instant))
      for (const [fieldIndex, argIndex] of setter.args) {
        if (argIndex < args.length) fields[fieldIndex] = toGuestNumber(args[argIndex])
      }
      if (setter.twoDigitYear) fields[FIELD_YEAR] = expandTwoDigitYear(fields[FIELD_YEAR])
      return writeInstant(thisHandle, instantFromLocalFields(profile.timezone, fields))
    })
  }

  installPrototypeMethod('toString', 0, ({ thisHandle }) =>
    ctx.newString(instantText(readInstant(thisHandle))),
  )
  installPrototypeMethod('toDateString', 0, ({ thisHandle }) => {
    const parts = describe(readInstant(thisHandle))
    return ctx.newString(parts ? parts.date : 'Invalid Date')
  })
  installPrototypeMethod('toTimeString', 0, ({ thisHandle }) => {
    const parts = describe(readInstant(thisHandle))
    return ctx.newString(parts ? parts.time : 'Invalid Date')
  })

  for (const [name, defaults] of Object.entries(LOCALE_DEFAULTS)) {
    installPrototypeMethod(name, 0, ({ args, thisHandle }) => {
      const instant = readInstant(thisHandle)
      if (Number.isNaN(instant)) return ctx.newString('Invalid Date')
      const locales = localeArgument(bridge.value(args, 0)) ?? profile.language
      const requested = componentOptions(bridge.value(args, 1))
      const formatter = new Intl.DateTimeFormat(locales, {
        timeZone: profile.timezone,
        ...(Object.keys(requested).length > 0 ? requested : defaults),
      })
      return ctx.newString(formatter.format(new Date(instant)))
    })
  }

  // ---- constructor ---------------------------------------------------------

  const nowFn = bridge.fn('now', 0, () => ctx.newNumber(clock.now()))

  const createFn = bridge.fn('fromInstant', 1, ({ args }) => createDate(bridge.num(args, 0, NaN)))

  /** `Date()` called as a function: the current time as a string. */
  const textFn = bridge.fn('instantText', 1, ({ args }) =>
    ctx.newString(instantText(bridge.num(args, 0, NaN))),
  )

  /**
   * `new Date(y, m, d, h, mi, s, ms)` — the only form whose arguments are local
   * time, hence the only form the host alone cannot answer.
   */
  const fromLocalFn = bridge.fn('fromLocal', 8, ({ args }) => {
    const count = bridge.num(args, FIELD_COUNT, 0)
    const fields = FIELD_DEFAULTS.slice()
    for (let index = 0; index < FIELD_COUNT; index += 1) {
      if (index < count) fields[index] = toGuestNumber(args[index])
    }
    fields[FIELD_YEAR] = expandTwoDigitYear(fields[FIELD_YEAR])
    return createDate(instantFromLocalFields(profile.timezone, fields))
  })

  /**
   * `new Date(value)` for one argument. Strings without an explicit zone are
   * profile-local (ES2020 §21.4.3.2); everything else is the engine's job.
   */
  const argumentFn = bridge.fn('dateArgument', 1, ({ args }) => {
    const type = args[0] ? ctx.typeof(args[0]) : 'undefined'
    if (type === 'string') {
      const text = ctx.getString(args[0])
      const local = parseProfileLocalString(text, profile.timezone)
      if (local !== null) return ctx.newNumber(local)
    }
    const result = ctx.callFunction(constructDate, ctx.undefined, [OriginalDate, args[0]])
    if (result.error) throw takeError(result.error)
    try {
      const time = ctx.callFunction(originalGetTime, result.value, [])
      if (time.error) throw takeError(time.error)
      const instant = ctx.getNumber(time.value)
      time.value.dispose()
      return ctx.newNumber(instant)
    } finally {
      result.value.dispose()
    }
  })

  /** `Date.parse` with the same local-string rule as the constructor. */
  const parseFn = bridge.fn('parse', 1, ({ args }) => {
    const type = args[0] ? ctx.typeof(args[0]) : 'undefined'
    if (type === 'string') {
      const text = ctx.getString(args[0])
      const local = parseProfileLocalString(text, profile.timezone)
      if (local !== null) return ctx.newNumber(local)
    }
    const result = ctx.callFunction(originalParse, OriginalDate, [args[0] ?? ctx.undefined])
    if (result.error) throw takeError(result.error)
    try {
      return ctx.newNumber(ctx.getNumber(result.value))
    } finally {
      result.value.dispose()
    }
  })

  const factory = ctx.evalCode(CONSTRUCTOR_SHIM, 'ai4r-internal:time')
  if (factory.error) throw takeError(factory.error)
  let dateConstructor
  try {
    const bound = ctx.callFunction(factory.value, ctx.undefined, [
      nowFn,
      createFn,
      fromLocalFn,
      textFn,
      OriginalDate,
      datePrototype,
      originalParse,
      originalUtc,
      argumentFn,
      parseFn,
    ])
    if (bound.error) throw takeError(bound.error)
    dateConstructor = bound.value
  } finally {
    factory.value.dispose()
  }

  bridge.adopt(dateConstructor, 'Date')
  bridge.install(bridge.global, 'Date', dateConstructor, GLOBAL_FLAGS)
  bridge.install(datePrototype, 'constructor', dateConstructor, PROTOTYPE_FLAGS)
  dateConstructor.dispose()

  bridge.emit('sandbox', 'emit', {
    event: 'time.virtualized',
    locale: profile.language,
    timezone: profile.timezone,
    timezoneOffsetMinutes: anchorOffsetMinutes,
    gmtOffset: anchorOffsetText,
    instant: isoText(clock.now()),
  })
}

/** Local fields `[year, month, date, hours, minutes, seconds, ms]` of a local Date. */
function localFieldsOf(local) {
  return [
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate(),
    local.getUTCHours(),
    local.getUTCMinutes(),
    local.getUTCSeconds(),
    local.getUTCMilliseconds(),
  ]
}

/**
 * Epoch milliseconds for local wall-clock fields, using MakeDay semantics:
 * years 0..99 stay literal (unlike `Date.UTC`, which maps them into 1900..1999).
 * Any NaN field makes the whole value NaN, as the spec requires.
 * @param {number[]} fields
 */
function utcFromFields(fields) {
  const probe = new Date(0)
  probe.setUTCFullYear(fields[0], fields[1], fields[2])
  probe.setUTCHours(fields[3], fields[4], fields[5], fields[6])
  return probe.getTime()
}

/**
 * Parse an ISO-8601-like string without a timezone designator as profile-local.
 * Date-only forms (`YYYY-MM-DD`) are already UTC per spec and are left to the
 * engine. Returns null when the string is not a local date-time form.
 * @param {string} text
 * @param {string} timeZone
 * @returns {number|null}
 */
function parseProfileLocalString(text, timeZone) {
  const match =
    /^\s*(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?\s*$/.exec(text)
  if (!match) return null
  const fields = [
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6] ?? 0),
    Number((match[7] ?? '0').padEnd(3, '0')),
  ]
  return instantFromLocalFields(timeZone, fields)
}

/** `setYear`/constructor year mapping: 0..99 means 1900..1999. */
function expandTwoDigitYear(year) {
  const value = Number.isFinite(year) ? Math.trunc(year) : year
  return value >= 0 && value <= 99 ? 1900 + value : value
}

/** Zero-padded unsigned field. */
function pad2(value) {
  return String(Math.trunc(Math.abs(value))).padStart(2, '0')
}

/** `toString` year: at least four digits, extensions printed as-is. */
function yearText(year) {
  if (!Number.isFinite(year)) return 'NaN'
  return year >= 0 && year <= 9999 ? String(year).padStart(4, '0') : String(year)
}

/** `GMT+0800`: the UTC offset implied by the JS minutes-behind-UTC value. */
function gmtOffsetText(minutesBehindUtc) {
  const sign = minutesBehindUtc > 0 ? '-' : '+'
  const total = Math.abs(minutesBehindUtc)
  return `GMT${sign}${pad2(Math.floor(total / 60))}${pad2(total % 60)}`
}

/** First `toLocale*` argument, when it is a usable BCP-47 locale tag. */
function localeArgument(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value
  return undefined
}

/** Second `toLocale*` argument, when it is a plain options object. */
function componentOptions(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}
