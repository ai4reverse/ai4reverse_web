import assert from 'node:assert/strict'
import {
  ALGORITHM,
  SCHEMA,
  SEVERITY_BY_TYPE,
  IntegrityError,
  assessTiming,
  buildIntegrityReport,
  canonicalJson,
  captureBaseline,
  capturePrototypeSnapshot,
  createIntegrityMonitor,
  createTelemetryEvent,
  createTimingProfile,
  generateTelemetryKeys,
  hashFunctionSource,
  normalizeTargets,
  prototypeFingerprint,
  sha256Hex,
  signIntegrityReport,
  verifyIntegrityReport,
} from './src/index.js'

let passed = 0
let total = 0
async function check(name, fn) {
  total += 1
  try {
    await fn()
    passed += 1
  } catch (error) {
    console.error(`FAIL ${name}: ${error.message}`)
    throw error
  }
}

const now = 1_800_000_000_000
const game = {
  fireWeapon(shots) {
    return shots * 2
  },
  applyPhysics(delta) {
    return delta * 9.81
  },
}
function renderFrame(frame) {
  return frame + 1
}
const targets = [
  { name: 'game.fireWeapon', fn: game.fireWeapon, owner: game, key: 'fireWeapon' },
  { name: 'game.applyPhysics', fn: game.applyPhysics, owner: game, key: 'applyPhysics' },
  { name: 'renderFrame', fn: renderFrame },
]
const baseline = captureBaseline(targets, { now })
const typesIn = (findings) => findings.map((finding) => finding.type)

await check('baseline captures sources, descriptors and prototypes', () => {
  assert.equal(baseline.v, 1)
  assert.equal(baseline.functions.length, 3)
  assert.equal(baseline.functions[0].sourceHash, hashFunctionSource(game.fireWeapon))
  assert.equal(baseline.functions[0].descriptor.writable, true)
  assert.equal(baseline.functions[0].descriptor.enumerable, true)
  assert.equal(baseline.functions[2].descriptor, null)
  assert.equal(baseline.functions[0].protoName, 'Function')
  assert.ok(baseline.prototypes['Object.prototype'].keys.includes('hasOwnProperty'))
  assert.ok(baseline.prototypes['Function.prototype'].keys.includes('apply'))
  assert.equal(baseline.toStringHash, hashFunctionSource(Function.prototype.toString))
  assert.equal(JSON.parse(JSON.stringify(baseline)).functions[0].sourceHash, baseline.functions[0].sourceHash)
  assert.equal(SEVERITY_BY_TYPE.HOT_PATCH, 'critical')
  assert.throws(() => normalizeTargets({}), (error) => error.code === 'BAD_TARGETS')
  assert.throws(() => normalizeTargets({ notAFunction: 42 }), (error) => error.code === 'BAD_TARGETS')
  assert.throws(() => normalizeTargets([targets[0], targets[0]]), (error) => error.code === 'BAD_TARGETS')
})

await check('clean sampled checks produce no findings', () => {
  const monitor = createIntegrityMonitor({ targets, baseline, sampleRate: 0.3, maxInterval: 5, seed: 7 })
  let findings = 0
  for (let tick = 0; tick < 200; tick += 1) findings += monitor.check({ now }).findings.length
  assert.equal(findings, 0)
  assert.ok(monitor.stats.checks > 0)
  assert.ok(monitor.stats.skips > 0)
  assert.equal(monitor.stats.ticks, 200)
  assert.equal(monitor.findings().length, 0)
})

await check('hot-patched game functions are detected and recovery is clean', () => {
  const monitor = createIntegrityMonitor({ targets, baseline, sampleRate: 1, seed: 8 })
  assert.equal(monitor.check({ force: true, now }).findings.length, 0)
  const original = game.fireWeapon
  game.fireWeapon = () => Infinity
  try {
    const result = monitor.check({ force: true, now })
    assert.ok(typesIn(result.findings).includes('HOT_PATCH'))
    const finding = result.findings.find((entry) => entry.type === 'HOT_PATCH')
    assert.equal(finding.target, 'game.fireWeapon')
    assert.equal(finding.severity, 'critical')
    assert.equal(finding.evidence.expected.length, 64)
    assert.equal(finding.evidence.actual.length, 64)
  } finally {
    game.fireWeapon = original
  }
  assert.equal(monitor.check({ force: true, now }).findings.length, 0)
  assert.equal(monitor.findings().length, 1)
  assert.equal(monitor.findings()[0].count, 1)
})

await check('replaced functions and own-property tampering are detected', () => {
  const monitor = createIntegrityMonitor({ targets, baseline, sampleRate: 1, seed: 9 })
  const original = game.applyPhysics
  game.applyPhysics = 'patched out'
  try {
    assert.ok(typesIn(monitor.check({ force: true, now }).findings).includes('FUNCTION_REPLACED'))
  } finally {
    game.applyPhysics = original
  }
  Object.defineProperty(game.fireWeapon, 'cheat', { value: true, configurable: true })
  try {
    assert.ok(typesIn(monitor.check({ force: true, now }).findings).includes('DESCRIPTOR_TAMPER'))
  } finally {
    delete game.fireWeapon.cheat
  }
  assert.equal(monitor.check({ force: true, now }).findings.length, 0)
})

await check('property descriptor tampering is detected', () => {
  const api = {}
  Object.defineProperty(api, 'score', { value: function score() { return 1 }, writable: true, enumerable: false, configurable: true })
  const target = { name: 'api.score', fn: api.score, owner: api, key: 'score' }
  const monitor = createIntegrityMonitor({ targets: [target], sampleRate: 1, seed: 10, now })
  assert.equal(monitor.check({ force: true, now }).findings.length, 0)
  Object.defineProperty(api, 'score', { value: api.score, writable: true, enumerable: true, configurable: true })
  try {
    const findings = monitor.check({ force: true, now }).findings
    assert.ok(typesIn(findings).includes('DESCRIPTOR_TAMPER'))
    assert.equal(findings.find((entry) => entry.type === 'DESCRIPTOR_TAMPER').evidence.actual.enumerable, true)
  } finally {
    Object.defineProperty(api, 'score', { value: api.score, writable: true, enumerable: false, configurable: true })
  }
  assert.equal(monitor.check({ force: true, now }).findings.length, 0)
})

await check('prototype pollution is detected and cleanup restores the baseline', () => {
  const monitor = createIntegrityMonitor({ targets: { noop: function noop() {} }, sampleRate: 1, seed: 11 })
  assert.equal(monitor.check({ force: true, now }).findings.length, 0)
  Object.prototype.cheatMode = true
  try {
    const findings = monitor.check({ force: true, now }).findings
    const pollution = findings.find((entry) => entry.type === 'PROTOTYPE_POLLUTION')
    assert.ok(pollution)
    assert.equal(pollution.target, 'Object.prototype')
    assert.deepEqual(pollution.evidence.added, ['cheatMode'])
    assert.equal(pollution.severity, 'critical')
  } finally {
    delete Object.prototype.cheatMode
  }
  assert.equal(monitor.check({ force: true, now }).findings.length, 0)
})

await check('custom prototype tampering is detected', () => {
  const playerPrototype = { alpha() { return 'a' }, beta() { return 'b' } }
  const monitor = createIntegrityMonitor({
    targets: { run: function run() {} },
    prototypes: [{ name: 'Player.prototype', object: playerPrototype }],
    sampleRate: 1,
    seed: 12,
  })
  assert.ok(monitor.baseline.prototypes['Player.prototype'].keys.includes('beta'))
  const originalBeta = playerPrototype.beta
  delete playerPrototype.beta
  try {
    const findings = monitor.check({ force: true, now }).findings
    const tamper = findings.find((entry) => entry.type === 'PROTOTYPE_TAMPER')
    assert.ok(tamper)
    assert.deepEqual(tamper.evidence.removed, ['beta'])
  } finally {
    playerPrototype.beta = originalBeta
  }
  const snapshot = capturePrototypeSnapshot([{ name: 'Player.prototype', object: playerPrototype }])
  assert.equal(snapshot['Player.prototype'].fingerprint, monitor.baseline.prototypes['Player.prototype'].fingerprint)
  assert.equal(monitor.check({ force: true, now }).findings.length, 0)
})

await check('Function.prototype.toString tampering is detected', () => {
  const monitor = createIntegrityMonitor({ targets: { compute: function compute() { return 1 } }, sampleRate: 1, seed: 13 })
  const saved = Function.prototype.toString
  try {
    Function.prototype.toString = function toString() {
      return 'function compute() { return 0 }'
    }
    const findings = monitor.check({ force: true, now }).findings
    assert.ok(typesIn(findings).includes('TO_STRING_TAMPER'))
    assert.ok(findings.some((entry) => entry.type === 'TO_STRING_TAMPER' && entry.severity === 'critical'))
  } finally {
    Function.prototype.toString = saved
  }
  assert.equal(monitor.check({ force: true, now }).findings.length, 0)
})

await check('timing profile separates jitter from anomalies', () => {
  const samples = Array.from({ length: 200 }, (_, index) => 12 + Math.sin(index * 0.9) * 1.4)
  const profile = createTimingProfile(samples)
  assert.ok(profile.budget >= 9)
  assert.equal(profile.sampleCount, 200)
  let falsePositives = 0
  for (let index = 0; index < 300; index += 1) {
    const benign = 12 + Math.sin(index * 1.7) * 1.6
    if (assessTiming(profile, benign).anomaly) falsePositives += 1
  }
  assert.equal(falsePositives, 0)
  const anomaly = assessTiming(profile, 120)
  assert.equal(anomaly.anomaly, true)
  assert.ok(anomaly.deviation > anomaly.budget)
  assert.throws(() => createTimingProfile([1, 2, 3]), (error) => error.code === 'BAD_TIMING')
  assert.throws(() => createTimingProfile([1, 2, 3, 4, Number.NaN]), (error) => error.code === 'BAD_TIMING')
  assert.throws(() => assessTiming(null, 1), (error) => error.code === 'BAD_TIMING')
})

await check('monitor stays below the false-positive budget across many samples', () => {
  const profile = createTimingProfile(Array.from({ length: 100 }, (_, index) => 8 + Math.sin(index) * 0.8))
  const monitor = createIntegrityMonitor({ targets, baseline, sampleRate: 0.25, maxInterval: 6, seed: 14, timingProfile: profile })
  let falsePositives = 0
  for (let tick = 0; tick < 250; tick += 1) {
    const benign = 8 + Math.sin(tick * 1.3) * 0.9
    const observed = monitor.timing(benign, { now })
    if (observed.anomaly) falsePositives += 1
    falsePositives += monitor.check({ now }).findings.length
  }
  assert.equal(falsePositives, 0)
  assert.ok(monitor.stats.checks > 0)
  assert.ok(monitor.stats.skips > 0)
  const attack = monitor.timing(140, { now, name: 'physics-step' })
  assert.equal(attack.anomaly, true)
  assert.equal(attack.finding.type, 'TIMING_ANOMALY')
  assert.equal(attack.finding.severity, 'medium')
  assert.equal(monitor.timing(8.1, { now }).finding, null)
})

await check('telemetry events bind findings with a stable digest', () => {
  const finding = { type: 'HOT_PATCH', severity: 'critical', target: 'game.fireWeapon', detail: 'source changed', evidence: { expected: 'aa', actual: 'bb' } }
  const event = createTelemetryEvent(finding, { sessionId: 'session-42', sequence: 7, now })
  assert.equal(event.schema, 'anti-cheat.event.v1')
  assert.equal(event.type, 'HOT_PATCH')
  assert.equal(event.sessionId, 'session-42')
  assert.equal(event.sequence, 7)
  assert.equal(event.digest.length, 64)
  assert.equal(event.id.length, 16)
  const repeat = createTelemetryEvent(finding, { sessionId: 'session-42', sequence: 7, now })
  assert.deepEqual(repeat, event)
  const body = { ...event }
  delete body.digest
  delete body.id
  assert.equal(event.digest, sha256Hex(canonicalJson(body)))
  assert.throws(() => createTelemetryEvent({ severity: 'high' }), (error) => error.code === 'BAD_FINDING')
})

await check('reports aggregate findings and are signed end to end', async () => {
  const findings = [
    { type: 'HOT_PATCH', severity: 'critical', target: 'game.fireWeapon', detail: 'source changed', evidence: {} },
    { type: 'TIMING_ANOMALY', severity: 'medium', target: 'physics-step', detail: 'slow', evidence: { deviation: 120 } },
  ]
  const report = buildIntegrityReport(findings, { sessionId: 'session-42', now })
  assert.equal(report.schema, SCHEMA)
  assert.equal(report.summary.total, 2)
  assert.equal(report.summary.bySeverity.critical, 1)
  assert.equal(report.summary.byType.HOT_PATCH, 1)
  assert.equal(report.digest.length, 64)
  const keys = await generateTelemetryKeys()
  const signed = await signIntegrityReport(report, keys)
  assert.equal(signed.alg, ALGORITHM)
  assert.equal(signed.keyId, keys.keyId)
  const verified = await verifyIntegrityReport(signed, { publicJwk: keys.publicJwk })
  assert.equal(verified.valid, true)
  assert.equal(verified.digest, report.digest)
  const other = await generateTelemetryKeys()
  await assert.rejects(() => verifyIntegrityReport(signed, { publicJwk: other.publicJwk }), (error) => error.code === 'BAD_SIGNATURE')
  const tampered = structuredClone(signed)
  tampered.report.findings[0].detail = 'nothing to see here'
  await assert.rejects(() => verifyIntegrityReport(tampered, { publicJwk: keys.publicJwk }), (error) => error.code === 'BAD_REPORT')
  await assert.rejects(() => signIntegrityReport(tampered.report, keys), (error) => error.code === 'BAD_REPORT')
})

await check('monitor reports aggregate unique findings with counts', () => {
  const monitor = createIntegrityMonitor({ targets, baseline, sampleRate: 1, seed: 15 })
  const original = game.fireWeapon
  game.fireWeapon = () => 0
  try {
    monitor.check({ force: true, now })
    monitor.check({ force: true, now })
  } finally {
    game.fireWeapon = original
  }
  const report = monitor.report({ sessionId: 'session-99', now })
  assert.equal(report.findings.length, 1)
  assert.equal(report.findings[0].count, 2)
  assert.equal(report.summary.total, 1)
  assert.equal(report.digest.length, 64)
  assert.equal(prototypeFingerprint(Object.prototype).length, 64)
  assert.equal(monitor.findings().length, 1)
  assert.throws(() => captureBaseline({}), (error) => error instanceof IntegrityError)
})

console.log(`checks: ${passed}/${total}`)
