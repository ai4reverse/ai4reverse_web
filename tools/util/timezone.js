/**
 * Timezone offset lookup with full IANA/DST data from the host ICU database.
 *
 * The sandbox used to pin one offset per profile. That is deterministic but
 * wrong for any DST zone: `new Date(0).getTimezoneOffset()` would disagree with
 * the named zone's actual offset, and the long zone name from ICU would
 * contradict the numeric label. Offsets are therefore derived per instant from
 * the same tzdata a browser ships, while the *profile* still chooses which zone
 * the guest sees.
 */

const formatterCache = new Map()

/** The proleptic Gregorian calendar repeats every 400 years. */
const GREGORIAN_CYCLE_YEARS = 400
/** Milliseconds in 146_097 days, one full Gregorian cycle. */
const GREGORIAN_CYCLE_MS = 146_097 * 86_400_000

/** @param {string} timeZone */
function formatterFor(timeZone) {
  if (!formatterCache.has(timeZone)) {
    formatterCache.set(
      timeZone,
      new Intl.DateTimeFormat('en-US', {
        timeZone,
        hour12: false,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        era: 'short',
      }),
    )
  }
  return formatterCache.get(timeZone)
}

/**
 * Build a UTC instant from calendar fields without `Date.UTC`'s legacy
 * 0..99 -> 1900..1999 year remapping. The Gregorian calendar repeats every
 * 400 years, so years 0..99 are shifted into 400..499 and the cycle length is
 * subtracted, preserving leap years and weekdays.
 * @param {number} year full proleptic-Gregorian year
 * @param {number} month zero-based month
 * @param {number} date day of month
 * @param {number} hours
 * @param {number} minutes
 * @param {number} seconds
 * @param {number} ms
 * @returns {number} epoch milliseconds
 */
function utcInstantFromFields(year, month, date, hours, minutes, seconds, ms) {
  if (year >= 0 && year <= 99) {
    const shifted = Date.UTC(
      year + GREGORIAN_CYCLE_YEARS,
      month,
      date,
      hours,
      minutes,
      seconds,
      ms,
    )
    return Number.isFinite(shifted) ? shifted - GREGORIAN_CYCLE_MS : shifted
  }
  return Date.UTC(year, month, date, hours, minutes, seconds, ms)
}

/**
 * Formatted years are era-relative: 1 BC is proleptic-Gregorian year 0, 2 BC
 * is -1. Without this correction BCE instants would be misread as AD.
 * @param {string|undefined} yearText
 * @param {string|undefined} eraText
 * @returns {number}
 */
function fullYearFromParts(yearText, eraText) {
  const year = Number(yearText)
  return /^B/i.test(eraText ?? '') ? 1 - year : year
}

/**
 * Offset in `Date.prototype.getTimezoneOffset()` sign convention (minutes to
 * add to local time to obtain UTC; positive west of Greenwich).
 * @param {string} timeZone IANA zone, e.g. 'Asia/Shanghai'
 * @param {number} instant epoch milliseconds
 * @returns {number} minutes, or NaN for an invalid instant
 */
export function timezoneOffsetMinutesAt(timeZone, instant) {
  if (!Number.isFinite(instant)) return NaN
  const parts = formatterFor(timeZone).formatToParts(new Date(instant))
  const fields = {}
  for (const part of parts) {
    if (part.type !== 'literal') fields[part.type] = part.value
  }
  const asUtc = utcInstantFromFields(
    fullYearFromParts(fields.year, fields.era),
    Number(fields.month) - 1,
    Number(fields.day),
    Number(fields.hour) % 24,
    Number(fields.minute),
    Number(fields.second),
    0,
  )
  const secondFloor = Math.floor(instant / 1000) * 1000
  const offsetAheadMinutes = Math.round((asUtc - secondFloor) / 60_000)
  // getTimezoneOffset returns +0 for zones at Greenwich, never -0.
  return offsetAheadMinutes === 0 ? 0 : -offsetAheadMinutes
}

/** Milliseconds in one minute. */
const MS_PER_MINUTE = 60_000
/** Probe distance on either side of a wall-clock instant; brackets any DST transition. */
const OFFSET_PROBE_WINDOW_MS = 24 * 60 * 60_000

/**
 * Offset to apply when converting wall-clock fields to an instant.
 *
 * A single lookup at the fields-as-UTC instant only sees one side of a DST
 * transition: east of UTC a spring-forward gap lands after the transition and
 * yields the post-transition offset (one hour early), and an east-of-UTC
 * fall-back overlap lands after the transition and yields the second
 * occurrence. Probing a day either side supplies both candidate offsets; a
 * candidate is viable only when the zone really has that offset at the
 * candidate instant.
 *
 * - Both viable: the wall time is ambiguous (fall-back). ECMAScript picks the
 *   earlier instant, so use the smaller candidate.
 * - One viable: the wall time exists once; use that offset.
 * - Neither viable: the wall time falls in a gap. ECMAScript keeps the offset
 *   in effect before the transition, which is the earlier probe's offset.
 *
 * @param {string} timeZone IANA zone
 * @param {number} asUtc wall-clock fields interpreted as UTC
 * @returns {number} minutes in `getTimezoneOffset()` convention
 */
function resolvingOffsetMinutesAt(timeZone, asUtc) {
  const beforeOffset = timezoneOffsetMinutesAt(timeZone, asUtc - OFFSET_PROBE_WINDOW_MS)
  const afterOffset = timezoneOffsetMinutesAt(timeZone, asUtc + OFFSET_PROBE_WINDOW_MS)
  if (beforeOffset === afterOffset) return beforeOffset

  const beforeCandidate = asUtc + beforeOffset * MS_PER_MINUTE
  const afterCandidate = asUtc + afterOffset * MS_PER_MINUTE
  const beforeViable = timezoneOffsetMinutesAt(timeZone, beforeCandidate) === beforeOffset
  const afterViable = timezoneOffsetMinutesAt(timeZone, afterCandidate) === afterOffset

  if (beforeViable && afterViable) {
    return beforeCandidate <= afterCandidate ? beforeOffset : afterOffset
  }
  if (beforeViable) return beforeOffset
  if (afterViable) return afterOffset
  return beforeOffset
}

/**
 * Convert profile-local wall-clock fields to an instant. ECMAScript resolves
 * local time by taking the offset at the fields interpreted as UTC
 * (ES2024 `UTC(t)` = `t - LocalTZA(t, true)`), which keeps the pre-transition
 * offset in a spring-forward gap and the first occurrence in a fall-back
 * overlap.
 * @param {string} timeZone
 * @param {number[]} fields [year, month, date, hours, minutes, seconds, ms]
 * @returns {number} epoch milliseconds
 */
export function instantFromLocalFields(timeZone, fields) {
  const asUtc = utcInstantFromFields(
    fields[0],
    fields[1],
    fields[2],
    fields[3],
    fields[4],
    fields[5],
    fields[6],
  )
  if (!Number.isFinite(asUtc)) return NaN
  return asUtc + resolvingOffsetMinutesAt(timeZone, asUtc) * MS_PER_MINUTE
}
