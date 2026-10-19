import test from 'node:test'
import assert from 'node:assert/strict'
import { createHarness } from './helpers/harness.js'

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
