/**
 * Bot / Fraud Detection SDK — behavioural risk scoring.
 *
 * Ingests interaction events (pointer, keyboard, focus, form timing, automation
 * flags) and produces a transparent 0..100 score with named reasons. Rules are
 * additive and explainable; no network or hidden state is used.
 */
export const VERSION = '1.0.0'

export const RULES = Object.freeze({
  webdriver: { weight: 35, label: 'navigator.webdriver is true' },
  noPointer: { weight: 20, label: 'form submitted with no pointer activity' },
  linearPointer: { weight: 18, label: 'pointer path is perfectly linear' },
  instantForm: { weight: 25, label: 'form filled faster than humanly possible' },
  noKeyboard: { weight: 15, label: 'text entered with no keyboard events' },
  honeypot: { weight: 30, label: 'hidden honeypot field was filled' },
  roboticTiming: { weight: 12, label: 'key timing has no variance' },
  headlessUa: { weight: 20, label: 'headless user-agent marker' },
  noFocus: { weight: 8, label: 'document never received focus' },
})

export function createDetector(options = {}) {
  const state = {
    automationFlags: { webdriver: false, headless: false, ...(options.automation ?? {}) },
    events: [],
    honeypotFilled: false,
    formStartedAt: null,
    formSubmittedAt: null,
    focusSeen: false,
    pointerPoints: [],
    keyTimes: [],
    keyboardCount: 0,
    pointerCount: 0,
    resetAt: options.now ?? Date.now(),
  }

  const api = {
    ingest(event = {}) {
      state.events.push(event)
      if (event.type === 'pointer') {
        state.pointerCount += 1
        if (typeof event.x === 'number' && typeof event.y === 'number') state.pointerPoints.push([event.x, event.y])
      } else if (event.type === 'key') {
        state.keyboardCount += 1
        if (typeof event.at === 'number') state.keyTimes.push(event.at)
      } else if (event.type === 'focus') {
        state.focusSeen = true
      } else if (event.type === 'form:start') {
        state.formStartedAt = event.at ?? null
      } else if (event.type === 'form:submit') {
        state.formSubmittedAt = event.at ?? null
      } else if (event.type === 'honeypot') {
        state.honeypotFilled = Boolean(event.filled)
      } else if (event.type === 'automation') {
        state.automationFlags = { ...state.automationFlags, ...event.flags }
      }
      return api
    },

    setAutomation(flags) {
      state.automationFlags = { ...state.automationFlags, ...flags }
      return api
    },

    score() {
      const reasons = []
      if (state.automationFlags.webdriver) reasons.push('webdriver')
      if (state.automationFlags.headless) reasons.push('headlessUa')
      if (state.pointerCount === 0 && state.formSubmittedAt) reasons.push('noPointer')
      if (state.pointerPoints.length >= 3 && isLinear(state.pointerPoints)) reasons.push('linearPointer')
      if (state.formStartedAt !== null && state.formSubmittedAt !== null) {
        const duration = state.formSubmittedAt - state.formStartedAt
        if (duration >= 0 && duration < 800) reasons.push('instantForm')
      }
      if (state.keyboardCount === 0 && state.formSubmittedAt) reasons.push('noKeyboard')
      if (state.honeypotFilled) reasons.push('honeypot')
      if (state.keyTimes.length >= 3) {
        const intervals = state.keyTimes.slice(1).map((time, index) => time - state.keyTimes[index])
        if (variance(intervals) < 1) reasons.push('roboticTiming')
      }
      if (!state.focusSeen && state.formSubmittedAt) reasons.push('noFocus')
      const total = Math.min(100, reasons.reduce((sum, key) => sum + RULES[key].weight, 0))
      return { score: total, reasons }
    },

    verdict() {
      const { score } = api.score()
      return score >= 60 ? 'bot' : score >= 30 ? 'suspicious' : 'human'
    },

    explain() {
      const { score, reasons } = api.score()
      return { score, verdict: api.verdict(), reasons: reasons.map((key) => ({ key, weight: RULES[key].weight, label: RULES[key].label })) }
    },

    reset() {
      api.__state.automationFlags = { webdriver: false, headless: false }
      api.__state.events = []
      api.__state.pointerPoints = []
      api.__state.keyTimes = []
      api.__state.keyboardCount = 0
      api.__state.pointerCount = 0
      api.__state.formStartedAt = null
      api.__state.formSubmittedAt = null
      api.__state.focusSeen = false
      api.__state.honeypotFilled = false
      return api
    },

    /** @internal exposed for tests */
    __state: state,
  }
  return api
}

function isLinear(points) {
  const [x0, y0] = points[0]
  const [x1, y1] = points[points.length - 1]
  if (x0 === x1 && y0 === y1) return false
  for (const [x, y] of points.slice(1, -1)) {
    const cross = (x1 - x0) * (y - y0) - (y1 - y0) * (x - x0)
    if (Math.abs(cross) > 1) return false
  }
  return true
}

function variance(values) {
  if (values.length < 2) return Infinity
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  return values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length
}

export function scoreEvents(events, automation = {}) {
  const detector = createDetector({ automation })
  for (const event of events) detector.ingest(event)
  return detector.score()
}
