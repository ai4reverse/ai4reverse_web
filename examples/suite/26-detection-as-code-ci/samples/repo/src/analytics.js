// Benign analytics module: no indicators, no dynamic code.
export function track(event, payload) {
  return { event, payload, at: performance.now() }
}
