import test from 'node:test'
import assert from 'node:assert/strict'
import { createHarness } from './helpers/harness.js'
import { instantFromLocalFields, timezoneOffsetMinutesAt } from '../tools/util/timezone.js'

/**
 * Virtual `Date` behaviour: one clock (the virtual one) and one timezone (the
 * profile's) for every guest-visible time API.
 */

const MODULES = Object.freeze(['globals', 'console', 'time'])
/** 2026-10-19T07:20:00.000Z — 15:20 in Asia/Shanghai, 03:20 in America/New_York. */
const EPOCH = 1792394400000

/**
 * Run one test against a fresh harness.
 * @param {object} profile profile overrides
 * @param {(harness: object) => Promise<void>|void} body
 */
async function withHarness(profile, body) {
  const harness = await createHarness({ modules: [...MODULES], profile })
  try {
    await body(harness)
  } finally {
    harness.dispose()
  }
}

/** Evaluate guest code and fail the test when it throws. */
function evaluate(harness, code) {
  const result = harness.run(code)
  assert.equal(result.ok, true, `guest evaluation failed: ${JSON.stringify(result.error)}`)
  return result.value
}

/**
 * Build an instant from full proleptic-Gregorian fields without `Date.UTC`'s
 * 0..99 -> 1900..1999 year mapping.
 * @param {number} year
 * @param {number} month zero-based
 * @param {number} date
 * @returns {number} epoch milliseconds
 */
function utcInstant(year, month, date) {
  const moment = new Date(0)
  moment.setUTCFullYear(year, month, date)
  moment.setUTCHours(0, 0, 0, 0)
  return moment.getTime()
}

/**
 * Offset oracle that does not reconstruct wall-clock fields: ICU's
 * `longOffset` zone name states the raw UTC offset at an instant.
 * @param {string} timeZone
 * @param {number} instant epoch milliseconds
 * @returns {number} `getTimezoneOffset()`-style minutes (may be fractional)
 */
function referenceOffsetMinutes(timeZone, instant) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' }).formatToParts(
    new Date(instant),
  )
  const name = parts.find((part) => part.type === 'timeZoneName').value
  const match = /^GMT(?:([+-])(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?)?$/.exec(name)
  assert.ok(match, `unexpected longOffset zone name: ${name}`)
  if (match[1] === undefined) return 0
  const sign = match[1] === '-' ? 1 : -1
  return sign * (Number(match[2]) * 60 + Number(match[3] ?? 0) + Number(match[4] ?? 0) / 60)
}

test('Date.now() and new Date() read the virtual clock', async () => {
  await withHarness({ locale: 'zh-CN' }, (harness) => {
    const before = harness.clock.now()
    const nowValue = evaluate(harness, 'Date.now()')
    const constructed = evaluate(harness, 'new Date().getTime()')
    const after = harness.clock.now()

    assert.equal(typeof nowValue, 'number')
    assert.ok(nowValue >= before && nowValue <= after, `Date.now() ${nowValue} outside [${before}, ${after}]`)
    assert.ok(Math.abs(constructed - harness.clock.now()) <= 1, `new Date() ${constructed} is not the virtual now`)
  })
})

test('zh-CN profile reports Asia/Shanghai local fields', async () => {
  await withHarness({ locale: 'zh-CN' }, (harness) => {
    const fields = evaluate(
      harness,
      `[new Date(${EPOCH}).getHours(),
        new Date(${EPOCH}).getMinutes(),
        new Date(${EPOCH}).getTimezoneOffset(),
        new Date(${EPOCH}).getFullYear(),
        new Date(${EPOCH}).getMonth(),
        new Date(${EPOCH}).getDate(),
        new Date(${EPOCH}).getDay()]`,
    )
    assert.deepEqual(fields, [15, 20, -480, 2026, 9, 19, 1])
  })
})

test('en-US profile reports America/New_York local fields', async () => {
  await withHarness({ locale: 'en-US' }, (harness) => {
    const fields = evaluate(
      harness,
      `[new Date(${EPOCH}).getHours(),
        new Date(${EPOCH}).getTimezoneOffset(),
        new Date(${EPOCH}).getFullYear(),
        new Date(${EPOCH}).getDate()]`,
    )
    assert.deepEqual(fields, [3, 240, 2026, 19])
  })
})

test('multi-argument constructor interprets fields in the profile timezone', async () => {
  await withHarness({ locale: 'zh-CN' }, (harness) => {
    const epochMs = evaluate(harness, 'new Date(2026, 9, 19, 15, 20, 0).getTime()')
    assert.equal(epochMs, EPOCH)

    const sixField = evaluate(harness, 'new Date(2026, 9, 19, 15, 20).getTime()')
    assert.equal(sixField, EPOCH)

    // Missing fields keep their spec defaults (day 1, time 00:00:00.000).
    const firstOfMonth = evaluate(harness, 'new Date(2026, 9).getTime()')
    assert.equal(firstOfMonth, Date.UTC(2026, 9, 1) + -480 * 60_000)

    // Two-digit years keep the constructor mapping (26 -> 1926).
    const shortYear = evaluate(harness, 'new Date(26, 0, 1).getFullYear()')
    assert.equal(shortYear, 1926)
  })
})

test('Date.parse, Date.UTC and toISOString stay native', async () => {
  await withHarness({ locale: 'zh-CN' }, (harness) => {
    const values = evaluate(
      harness,
      `[new Date(${EPOCH}).toISOString(),
        Date.parse('2026-10-19T07:20:00.000Z'),
        Date.UTC(2026, 9, 19, 7, 20),
        new Date(${EPOCH}).toUTCString()]`,
    )
    assert.equal(values[0], '2026-10-19T07:20:00.000Z')
    assert.equal(values[1], EPOCH)
    assert.equal(values[2], EPOCH)
    assert.equal(values[3], 'Mon, 19 Oct 2026 07:20:00 GMT')
  })
})

test('new Date() reflects clock advancement', async () => {
  await withHarness({ locale: 'zh-CN' }, (harness) => {
    const first = evaluate(harness, 'var first = new Date(); first.getTime()')
    harness.clock.advance(5000)
    const delta = evaluate(harness, 'new Date().getTime() - first')
    // Interrupt checks add a fraction of a millisecond of virtual time
    // (limits.interruptQuantumMs), so the step may round up by 1 ms.
    assert.ok(delta >= 5000 && delta <= 5001, `expected a 5000 ms step, saw ${delta}`)
  })
})

test('setHours round-trips through the profile timezone', async () => {
  await withHarness({ locale: 'zh-CN' }, (harness) => {
    const fields = evaluate(
      harness,
      `var d = new Date(${EPOCH});
       d.setHours(9);
       [d.getHours(), d.getMinutes(), d.getTime()]`,
    )
    assert.deepEqual(fields, [9, 20, EPOCH - 6 * 3_600_000])
  })
})

test('instances stay real Dates and the constructor looks native', async () => {
  await withHarness({ locale: 'zh-CN' }, (harness) => {
    const facts = evaluate(
      harness,
      `var d = new Date(${EPOCH});
       [d instanceof Date,
        Date.prototype.constructor === Date,
        String(Date).includes('[native code]'),
        Function.prototype.toString.call(Date).includes('[native code]'),
        Date.name,
        Date.length,
        Date.prototype.getHours.name,
        Date.prototype.getHours.length,
        Date.prototype.getHours.toString().includes('[native code]'),
        Object.prototype.toString.call(d),
        typeof d.getTime(),
        d.valueOf()]`,
    )
    assert.deepEqual(facts, [
      true,
      true,
      true,
      true,
      'Date',
      7,
      'getHours',
      0,
      true,
      '[object Date]',
      'number',
      EPOCH,
    ])
  })
})

test('toString matches the browser format for the profile timezone', async () => {
  await withHarness({ locale: 'zh-CN' }, (harness) => {
    const text = evaluate(harness, `new Date(${EPOCH}).toString()`)
    assert.match(text, /GMT\+0800 \(China Standard Time\)/)
    assert.equal(text, 'Mon Oct 19 2026 15:20:00 GMT+0800 (China Standard Time)')

    const parts = evaluate(harness, `[new Date(${EPOCH}).toDateString(), new Date(${EPOCH}).toTimeString()]`)
    assert.deepEqual(parts, ['Mon Oct 19 2026', '15:20:00 GMT+0800 (China Standard Time)'])
  })
})

test('toLocaleString follows the profile locale and timezone', async () => {
  await withHarness({ locale: 'zh-CN' }, (harness) => {
    const zhText = evaluate(harness, `new Date(${EPOCH}).toLocaleString()`)
    assert.equal(zhText, '2026/10/19 15:20:00')
  })

  await withHarness({ locale: 'en-US' }, (harness) => {
    const enText = evaluate(harness, `new Date(${EPOCH}).toLocaleString()`)
    assert.equal(enText, '10/19/2026, 3:20:00 AM')
    const enDate = evaluate(harness, `new Date(${EPOCH}).toLocaleDateString()`)
    assert.equal(enDate, '10/19/2026')
  })
})

test('local-time methods reject a non-Date receiver', async () => {
  await withHarness({ locale: 'zh-CN' }, (harness) => {
    const result = harness.run('Date.prototype.getHours.call({})')
    assert.equal(result.ok, false)
    assert.equal(result.error.name, 'TypeError')
    assert.doesNotMatch(String(result.error.stack ?? ''), /tools\/|node_modules/)
  })
})

test('invalid dates format as Invalid Date', async () => {
  await withHarness({ locale: 'zh-CN' }, (harness) => {
    const texts = evaluate(
      harness,
      `[new Date(NaN).toString(),
        String(new Date(NaN)),
        new Date(NaN).getHours() !== new Date(NaN).getHours(),
        new Date(NaN).getTimezoneOffset() !== new Date(NaN).getTimezoneOffset()]`,
    )
    assert.equal(texts[0], 'Invalid Date')
    assert.equal(texts[1], 'Invalid Date')
    assert.equal(texts[2], true) // NaN, reported as "not equal to itself"
    assert.equal(texts[3], true)
  })
})

test('same profile seed produces identical local fields', async () => {
  const sample = `[new Date(${EPOCH}).toString(),
                   new Date(${EPOCH}).getHours(),
                   new Date(${EPOCH}).getTimezoneOffset(),
                   new Date(${EPOCH}).toLocaleString()]`

  let first
  await withHarness({ locale: 'zh-CN', seed: 0x5eed }, (harness) => {
    first = evaluate(harness, sample)
  })
  await withHarness({ locale: 'zh-CN', seed: 0x5eed }, (harness) => {
    assert.deepEqual(evaluate(harness, sample), first)
  })
  assert.equal(first[1], 15)
  assert.equal(first[2], -480)
})

test('the default profile drives the guest clock and timezone', async () => {
  await withHarness({}, (harness) => {
    const offsetMinutes = harness.profile.timezoneOffsetMinutes
    const expectedHour = new Date(EPOCH - offsetMinutes * 60_000).getUTCHours()

    const before = harness.clock.now()
    const facts = evaluate(
      harness,
      `[new Date().getTime(),
        new Date(${EPOCH}).getHours(),
        new Date(${EPOCH}).getTimezoneOffset(),
        new Date(${EPOCH}).toISOString()]`,
    )
    const after = harness.clock.now()

    assert.ok(facts[0] >= before && facts[0] <= after, 'new Date() must read the virtual clock')
    assert.equal(facts[1], expectedHour)
    assert.equal(facts[2], offsetMinutes)
    assert.equal(facts[3], '2026-10-19T07:20:00.000Z')

    const text = evaluate(harness, `new Date(${EPOCH}).toString()`)
    const sign = offsetMinutes > 0 ? '-' : '+'
    assert.match(text, new RegExp(`GMT\\${sign}\\d{4} \\(.+\\)$`))

    const localeText = evaluate(harness, `new Date(${EPOCH}).toLocaleString()`)
    assert.ok(
      localeText.includes(`${expectedHour}:20`),
      `toLocaleString ${localeText} does not show the profile-local ${expectedHour}:20`,
    )
  })
})

test('the applied timezone is traced once', async () => {
  await withHarness({ locale: 'zh-CN' }, (harness) => {
    const events = harness.trace.events.filter((event) => event.kind === 'sandbox' && event.event === 'time.virtualized')
    assert.equal(events.length, 1)
    assert.equal(events[0].timezone, 'Asia/Shanghai')
    assert.equal(events[0].timezoneOffsetMinutes, -480)
    assert.equal(events[0].gmtOffset, 'GMT+0800')
    assert.equal(events[0].instant, new Date(EPOCH).toISOString())
  })
})

test('a spring-forward gap keeps the pre-transition offset', async () => {
  // 02:30 does not exist on 2024-03-10 in New York. ECMAScript resolves it
  // with the offset still in effect before the transition (EST, UTC-5), so the
  // engine reports 07:30Z and 03:30 local — not 06:30Z under EDT.
  assert.equal(
    instantFromLocalFields('America/New_York', [2024, 2, 10, 2, 30, 0, 0]),
    Date.UTC(2024, 2, 10, 7, 30),
  )

  await withHarness({ locale: 'en-US' }, (harness) => {
    const fields = evaluate(
      harness,
      `var d = new Date(2024, 2, 10, 2, 30, 0);
       [d.toISOString(), d.getHours(), d.getMinutes()]`,
    )
    assert.deepEqual(fields, ['2024-03-10T07:30:00.000Z', 3, 30])
  })
})

test('a fall-back overlap resolves to the first occurrence', async () => {
  // 01:30 occurs twice on 2024-11-03 in New York; ECMAScript picks the
  // pre-transition (EDT, UTC-4) instance.
  assert.equal(
    instantFromLocalFields('America/New_York', [2024, 10, 3, 1, 30, 0, 0]),
    Date.UTC(2024, 10, 3, 5, 30),
  )

  await withHarness({ locale: 'en-US' }, (harness) => {
    const iso = evaluate(harness, 'new Date(2024, 10, 3, 1, 30, 0).toISOString()')
    assert.equal(iso, '2024-11-03T05:30:00.000Z')
  })
})

test('spring-forward gaps resolve to the pre-transition offset in both hemispheres', () => {
  // Expected instants measured from Node with TZ set to each zone:
  //   TZ=<zone> node -e 'new Date(y, m, d, h, min).toISOString()'
  const gaps = [
    ['America/New_York', [2024, 2, 10, 2, 30, 0, 0], '2024-03-10T07:30:00.000Z'],
    ['Europe/London', [2024, 2, 31, 1, 30, 0, 0], '2024-03-31T01:30:00.000Z'],
    ['Europe/Berlin', [2024, 2, 31, 2, 30, 0, 0], '2024-03-31T01:30:00.000Z'],
    ['Australia/Sydney', [2024, 9, 6, 2, 30, 0, 0], '2024-10-05T16:30:00.000Z'],
  ]

  for (const [zone, fields, expected] of gaps) {
    assert.equal(
      new Date(instantFromLocalFields(zone, fields)).toISOString(),
      expected,
      `${zone} ${fields.slice(0, 5).join('-')}`,
    )
  }
})

test('fall-back overlaps resolve to the first occurrence east and west of UTC', () => {
  // Expected instants measured from Node with TZ set to each zone; the first
  // occurrence uses the pre-transition offset, which is also the earlier
  // instant.
  const overlaps = [
    ['America/New_York', [2024, 10, 3, 1, 30, 0, 0], '2024-11-03T05:30:00.000Z'],
    ['Europe/London', [2024, 9, 27, 1, 30, 0, 0], '2024-10-27T00:30:00.000Z'],
    ['Europe/Berlin', [2024, 9, 27, 2, 30, 0, 0], '2024-10-27T00:30:00.000Z'],
    ['Australia/Sydney', [2024, 3, 7, 2, 30, 0, 0], '2024-04-06T15:30:00.000Z'],
  ]

  for (const [zone, fields, expected] of overlaps) {
    assert.equal(
      new Date(instantFromLocalFields(zone, fields)).toISOString(),
      expected,
      `${zone} ${fields.slice(0, 5).join('-')}`,
    )
  }
})

test('years 0 through 99 stay literal instead of 1900 through 1999', () => {
  for (const year of [0, 1, 26, 50, 99]) {
    assert.equal(
      instantFromLocalFields('UTC', [year, 0, 1, 0, 0, 0, 0]),
      utcInstant(year, 0, 1),
      `year ${year} must not be remapped`,
    )
  }
})

test('timezoneOffsetMinutesAt is sane for years 0..99 and BCE', () => {
  const zone = 'America/New_York'
  for (const year of [-1, 0, 1, 50, 99]) {
    const instant = utcInstant(year, 5, 1)
    const offset = timezoneOffsetMinutesAt(zone, instant)
    assert.equal(offset, Math.round(referenceOffsetMinutes(zone, instant)), `year ${year} offset`)
    assert.ok(Math.abs(offset) <= 24 * 60, `year ${year} offset ${offset} is implausible`)
  }

  // Modern instants keep their DST-aware offsets.
  assert.equal(timezoneOffsetMinutesAt(zone, Date.UTC(2024, 0, 15)), 300)
  assert.equal(timezoneOffsetMinutesAt(zone, Date.UTC(2024, 6, 15)), 240)
})

test('zero-offset zones report positive zero', () => {
  for (const zone of ['UTC', 'Africa/Abidjan']) {
    const offset = timezoneOffsetMinutesAt(zone, EPOCH)
    assert.equal(offset, 0, `${zone} should be zero`)
    assert.equal(Object.is(offset, -0), false, `${zone} must not report -0`)
  }
})
