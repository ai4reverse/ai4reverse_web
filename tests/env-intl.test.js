import test from 'node:test'
import assert from 'node:assert/strict'
import { createHarness } from './helpers/harness.js'

/**
 * `Intl` and locale-aware built-in methods.
 *
 * The contract these tests enforce is *host agreement*: quickjs has no ICU, so
 * every localised string the guest produces must equal what Node's own `Intl`
 * produces for the profile locale, the profile time zone and the guest's own
 * argument. Anything else is a fabrication a sample could detect.
 */

/** Fixed epoch of the default profile (2026-10-19T07:20:00Z). */
const EPOCH = 1792394400000
const DATE_OPTIONS = { year: 'numeric', month: '2-digit', day: '2-digit' }

/** A sandbox with the Intl surface installed for one profile locale. */
async function open(locale) {
  return createHarness({ modules: ['globals', 'console', 'intl'], profile: { locale } })
}

/** Evaluate guest code and return its value, failing loudly on a guest error. */
function evaluate(harness, code) {
  const result = harness.run(code)
  assert.equal(result.ok, true, `guest threw for ${code}: ${JSON.stringify(result.error)}`)
  return result.value
}

/** Host rendering the guest must reproduce, in the profile's time zone. */
function hostDate(harness, method, locale, options = {}) {
  const merged = { timeZone: harness.profile.timezone, ...options }
  return new Date(EPOCH)[method](locale, merged)
}

test('Intl is a non-enumerable global with non-enumerable members', async (t) => {
  const harness = await open('en-US')
  t.after(() => harness.dispose())

  assert.equal(evaluate(harness, 'typeof Intl'), 'object')
  // ECMA-402 defines the members as non-enumerable, so `Object.keys` is empty in
  // every browser and the member *count* has to come from getOwnPropertyNames.
  assert.ok(evaluate(harness, 'Object.getOwnPropertyNames(Intl).length') > 5)
  assert.equal(evaluate(harness, 'Object.keys(Intl).length'), 0)

  assert.equal(evaluate(harness, 'Object.getOwnPropertyDescriptor(globalThis, "Intl").enumerable'), false)
  assert.equal(evaluate(harness, 'Object.getOwnPropertyDescriptor(globalThis, "Intl").writable'), true)
  assert.equal(evaluate(harness, 'Object.getOwnPropertyDescriptor(globalThis, "Intl").configurable'), true)
  assert.equal(evaluate(harness, 'Object.keys(globalThis).indexOf("Intl")'), -1)
  assert.equal(evaluate(harness, 'Object.prototype.toString.call(Intl)'), '[object Intl]')
  assert.equal(evaluate(harness, 'typeof Intl.DateTimeFormat'), 'function')
})

test('DateTimeFormat resolves the profile time zone, locale and calendar', async (t) => {
  for (const locale of ['zh-CN', 'en-US']) {
    const harness = await open(locale)
    t.after(() => harness.dispose())

    const resolved = evaluate(harness, 'new Intl.DateTimeFormat().resolvedOptions()')
    assert.equal(resolved.timeZone, harness.profile.timezone, `${locale} timeZone`)
    assert.equal(resolved.locale, harness.profile.language, `${locale} locale`)
    assert.equal(resolved.calendar, 'gregory', `${locale} calendar`)
    assert.equal(resolved.numberingSystem, harness.profile.numberingSystem, `${locale} numberingSystem`)
  }
})

test('DateTimeFormat formats dates through host ICU', async (t) => {
  const harness = await open('zh-CN')
  t.after(() => harness.dispose())

  const options = JSON.stringify(DATE_OPTIONS)
  const formatted = evaluate(
    harness,
    `new Intl.DateTimeFormat('zh-CN', ${options}).format(${EPOCH})`,
  )
  const expected = hostDate(harness, 'toLocaleDateString', 'zh-CN', DATE_OPTIONS)
  assert.equal(formatted, expected)

  const parts = evaluate(harness, `new Intl.DateTimeFormat('zh-CN', ${options}).formatToParts(${EPOCH})`)
  const year = parts.find((part) => part.type === 'year')
  assert.ok(year, 'formatToParts reports a year part')
  assert.equal(year.value, '2026')
  // Part values concatenate to the formatted string, as in a browser.
  assert.equal(parts.map((part) => part.value).join(''), formatted)

  // An explicit timeZone still wins over the profile default.
  const utcOptions = JSON.stringify({ ...DATE_OPTIONS, timeZone: 'UTC' })
  const explicit = evaluate(harness, `new Intl.DateTimeFormat('en-US', ${utcOptions}).format(${EPOCH})`)
  assert.equal(explicit, new Date(EPOCH).toLocaleDateString('en-US', { ...DATE_OPTIONS, timeZone: 'UTC' }))
})

test('DateTimeFormat supports dateStyle and timeStyle', async (t) => {
  const harness = await open('en-US')
  t.after(() => harness.dispose())

  const formatted = evaluate(
    harness,
    `new Intl.DateTimeFormat('en-US', { dateStyle: 'full', timeStyle: 'short' }).format(${EPOCH})`,
  )
  const expected = hostDate(harness, 'toLocaleString', 'en-US', { dateStyle: 'full', timeStyle: 'short' })
  assert.equal(formatted, expected)

  const hour = evaluate(
    harness,
    `new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }).format(${EPOCH})`,
  )
  assert.equal(hour, hostDate(harness, 'toLocaleTimeString', 'en-US', { hour: '2-digit', minute: '2-digit', hour12: false }))
})

test('NumberFormat delegates decimal, percent, currency, unit and compact to host ICU', async (t) => {
  const harness = await open('en-US')
  t.after(() => harness.dispose())

  const currency = evaluate(harness, "new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(1234.5)")
  assert.equal(currency, new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(1234.5))
  assert.equal(currency, '$1,234.50')

  const percent = evaluate(harness, "new Intl.NumberFormat('en-US', { style: 'percent' }).format(0.256)")
  assert.equal(percent, new Intl.NumberFormat('en-US', { style: 'percent' }).format(0.256))

  const unit = evaluate(harness, "new Intl.NumberFormat('en-US', { style: 'unit', unit: 'kilometer' }).format(5)")
  assert.equal(unit, new Intl.NumberFormat('en-US', { style: 'unit', unit: 'kilometer' }).format(5))

  const compact = evaluate(harness, "new Intl.NumberFormat('en-US', { notation: 'compact' }).format(12345)")
  assert.equal(compact, new Intl.NumberFormat('en-US', { notation: 'compact' }).format(12345))

  const grouped = evaluate(
    harness,
    "new Intl.NumberFormat('en-US', { useGrouping: false, minimumFractionDigits: 2 }).format(1234.5)",
  )
  assert.equal(grouped, '1234.50')

  const resolved = evaluate(harness, "new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).resolvedOptions()")
  assert.equal(resolved.style, 'currency')
  assert.equal(resolved.currency, 'USD')
  assert.equal(resolved.locale, 'en-US')
})

test('Collator orders numerically for the profile locale', async (t) => {
  const harness = await open('en-US')
  t.after(() => harness.dispose())

  const sorted = evaluate(
    harness,
    "['10', '2', '1'].sort(new Intl.Collator('en-US', { numeric: true }).compare)",
  )
  assert.deepEqual(sorted, ['1', '2', '10'])

  const comparison = evaluate(harness, "new Intl.Collator('en-US').compare('a', 'b')")
  assert.equal(comparison, new Intl.Collator('en-US').compare('a', 'b'))

  // Same bound-function identity per instance, as in V8.
  assert.equal(evaluate(harness, 'var c = new Intl.Collator(); c.compare === c.compare'), true)
})

test('RelativeTimeFormat, ListFormat, PluralRules and DisplayNames', async (t) => {
  const harness = await open('en-US')
  t.after(() => harness.dispose())

  const relative = evaluate(harness, "new Intl.RelativeTimeFormat('en-US').format(-3, 'day')")
  assert.match(relative, /days ago/)

  const list = evaluate(harness, "new Intl.ListFormat('en-US').format(['a', 'b', 'c'])")
  assert.equal(list, 'a, b, and c')

  assert.equal(evaluate(harness, "new Intl.PluralRules('en-US').select(1)"), 'one')
  assert.equal(evaluate(harness, "new Intl.PluralRules('en-US').select(2)"), 'other')

  const region = evaluate(harness, "new Intl.DisplayNames('en-US', { type: 'region' }).of('US')")
  assert.equal(region, new Intl.DisplayNames('en-US', { type: 'region' }).of('US'))
  assert.equal(region, 'United States')
})

test('locale-aware prototype methods match host Node', async (t) => {
  const harness = await open('en-US')
  t.after(() => harness.dispose())

  assert.equal(evaluate(harness, "(1234.5).toLocaleString('en-US')"), (1234.5).toLocaleString('en-US'))
  assert.equal(
    evaluate(harness, "(1234.5).toLocaleString('en-US', { minimumFractionDigits: 2 })"),
    (1234.5).toLocaleString('en-US', { minimumFractionDigits: 2 }),
  )
  assert.equal(
    evaluate(harness, `new Date(${EPOCH}).toLocaleDateString('en-US')`),
    hostDate(harness, 'toLocaleDateString', 'en-US'),
  )
  assert.equal(
    evaluate(harness, `new Date(${EPOCH}).toLocaleString('en-US')`),
    hostDate(harness, 'toLocaleString', 'en-US'),
  )
  assert.equal(
    evaluate(harness, `new Date(${EPOCH}).toLocaleTimeString('en-US')`),
    hostDate(harness, 'toLocaleTimeString', 'en-US'),
  )
  assert.equal(
    evaluate(harness, "'10'.localeCompare('2', 'en-US', { numeric: true })"),
    '10'.localeCompare('2', 'en-US', { numeric: true }),
  )
  assert.equal(evaluate(harness, "[1, null, 3].toLocaleString('en-US')"), [1, null, 3].toLocaleString('en-US'))
  assert.equal(
    evaluate(harness, "[1234.5, 2].toLocaleString('en-US')"),
    [1234.5, 2].toLocaleString('en-US'),
  )
  assert.equal(
    evaluate(harness, "BigInt(1234567).toLocaleString('en-US')"),
    BigInt(1234567).toLocaleString('en-US'),
  )
  // The replacements are engine-level natives: no wrapper source, no `prototype`
  // own property, non-enumerable — indistinguishable from the original method.
  assert.match(
    evaluate(harness, 'Function.prototype.toString.call(Number.prototype.toLocaleString)'),
    /\[native code\]/,
  )
  assert.equal(evaluate(harness, "'prototype' in Number.prototype.toLocaleString"), false)
  assert.equal(evaluate(harness, 'Object.getOwnPropertyDescriptor(Date.prototype, "toLocaleString").enumerable'), false)
  assert.equal(evaluate(harness, 'Number.prototype.toLocaleString.name'), 'toLocaleString')

  // A receiver of the wrong type still throws, as it does in a browser.
  assert.equal(
    evaluate(harness, "(function(){ try { Date.prototype.toLocaleString.call({}) } catch (e) { return e.name } })()"),
    'TypeError',
  )
  assert.equal(
    evaluate(harness, "(function(){ try { Number.prototype.toLocaleString.call('x') } catch (e) { return e.name } })()"),
    'TypeError',
  )
})

test('native brand, arity and instance shape', async (t) => {
  const harness = await open('en-US')
  t.after(() => harness.dispose())

  assert.match(evaluate(harness, 'String(Intl.DateTimeFormat)'), /\[native code\]/)
  assert.match(evaluate(harness, 'String(Intl.NumberFormat)'), /\[native code\]/)
  assert.match(evaluate(harness, 'Function.prototype.toString.call(Intl.DateTimeFormat.prototype.resolvedOptions)'), /\[native code\]/)

  assert.equal(evaluate(harness, 'new Intl.DateTimeFormat() instanceof Intl.DateTimeFormat'), true)
  assert.equal(evaluate(harness, 'Intl.DateTimeFormat.prototype.constructor === Intl.DateTimeFormat'), true)
  assert.equal(evaluate(harness, 'Intl.DateTimeFormat.name'), 'DateTimeFormat')
  assert.equal(evaluate(harness, 'Intl.DateTimeFormat.length'), 0)
  assert.equal(evaluate(harness, 'Object.prototype.toString.call(new Intl.DateTimeFormat())'), '[object Intl.DateTimeFormat]')
  // Prototype methods are non-enumerable data properties; `format` is an accessor.
  assert.deepEqual(evaluate(harness, 'Object.keys(Intl.DateTimeFormat.prototype)'), [])
  assert.equal(evaluate(harness, 'Object.getOwnPropertyDescriptor(Intl.DateTimeFormat.prototype, "format").enumerable'), false)
  assert.equal(evaluate(harness, 'typeof new Intl.DateTimeFormat().format'), 'function')
  assert.equal(evaluate(harness, 'Object.getOwnPropertyDescriptor(Intl.DateTimeFormat.prototype, "format").get.name'), 'get format')
  assert.equal(evaluate(harness, 'var f = new Intl.DateTimeFormat(); f.format === f.format'), true)
})

test('Intl statics and Locale', async (t) => {
  const harness = await open('en-US')
  t.after(() => harness.dispose())

  assert.deepEqual(
    evaluate(harness, "Intl.getCanonicalLocales(['zh-cn', 'EN-us'])"),
    Intl.getCanonicalLocales(['zh-cn', 'EN-us']),
  )
  for (const key of ['calendar', 'collation', 'currency', 'numberingSystem', 'timeZone', 'unit']) {
    const values = evaluate(harness, `Intl.supportedValuesOf('${key}')`)
    assert.deepEqual(values, Intl.supportedValuesOf(key), `supportedValuesOf('${key}') matches host ICU`)
  }
  assert.ok(evaluate(harness, `Intl.supportedValuesOf('timeZone').includes('${harness.profile.timezone}')`))
  assert.deepEqual(evaluate(harness, "Intl.DateTimeFormat.supportedLocalesOf(['en-US', 'zz-ZZ'])"), ['en-US'])

  assert.equal(evaluate(harness, "new Intl.Locale('en-US').region"), 'US')
  assert.equal(evaluate(harness, "new Intl.Locale('en-US').language"), 'en')
  assert.equal(evaluate(harness, "new Intl.Locale('zh').maximize().toString()"), new Intl.Locale('zh').maximize().toString())
  assert.equal(evaluate(harness, "new Intl.Locale('zh-Hans-CN').minimize().toString()"), 'zh')
  assert.deepEqual(evaluate(harness, 'Object.keys(new Intl.Locale("en-US"))'), [])
})

test('format() without an argument uses virtual time, not host time', async (t) => {
  const harness = await open('en-US')
  t.after(() => harness.dispose())

  const implicit = evaluate(harness, "new Intl.DateTimeFormat('en-US').format()")
  const explicit = evaluate(harness, `new Intl.DateTimeFormat('en-US').format(${EPOCH})`)
  assert.equal(implicit, explicit)
  // Default DateTimeFormat options are date-only, formatted in the profile zone.
  assert.equal(
    implicit,
    new Intl.DateTimeFormat('en-US', { timeZone: harness.profile.timezone }).format(EPOCH),
  )
})

test('formatting is deterministic across runs', async (t) => {
  const expressions = [
    "new Intl.DateTimeFormat('en-US', { dateStyle: 'full' }).format(1792394400000)",
    "new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(1234.5)",
    "new Intl.RelativeTimeFormat('en-US').format(-3, 'day')",
    "new Date(1792394400000).toLocaleString('zh-CN')",
    "new Intl.ListFormat('en-US').format(['a', 'b'])",
  ]
  const first = await open('en-US')
  const second = await open('en-US')
  t.after(() => {
    first.dispose()
    second.dispose()
  })

  const runAll = (harness) => expressions.map((code) => evaluate(harness, code))
  assert.deepEqual(runAll(first), runAll(second))
})
