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
      }),
    )
  }
  return formatterCache.get(timeZone)
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
  const asUtc = Date.UTC(
    Number(fields.year),
    Number(fields.month) - 1,
    Number(fields.day),
    Number(fields.hour) % 24,
    Number(fields.minute),
    Number(fields.second),
  )
  const secondFloor = Math.floor(instant / 1000) * 1000
  const offsetAheadMinutes = Math.round((asUtc - secondFloor) / 60_000)
  return -offsetAheadMinutes
}

/**
 * Convert profile-local wall-clock fields to an instant, iterating once so DST
 * boundaries resolve the way a browser resolves them.
 * @param {string} timeZone
 * @param {number[]} fields [year, month, date, hours, minutes, seconds, ms]
 * @returns {number} epoch milliseconds
 */
export function instantFromLocalFields(timeZone, fields) {
  const asUtc = Date.UTC(fields[0], fields[1], fields[2], fields[3], fields[4], fields[5], fields[6])
  if (!Number.isFinite(asUtc)) return NaN
  const firstGuess = timezoneOffsetMinutesAt(timeZone, asUtc)
  let instant = asUtc + firstGuess * 60_000
  const secondGuess = timezoneOffsetMinutesAt(timeZone, instant)
  if (secondGuess !== firstGuess) instant = asUtc + secondGuess * 60_000
  return instant
}
