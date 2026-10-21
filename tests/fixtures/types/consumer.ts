import * as api from 'ai4reverse-web'
import * as sandbox from 'ai4reverse-web/sandbox'
import * as instrumentation from 'ai4reverse-web/instrumentation'
import * as hook from 'ai4reverse-web/hook'
import * as restore from 'ai4reverse-web/restore'
import * as analysis from 'ai4reverse-web/analysis'
import * as jsvmp from 'ai4reverse-web/jsvmp'
import * as constraint from 'ai4reverse-web/constraint'
import * as logging from 'ai4reverse-web/logging'
import * as invocation from 'ai4reverse-web/invocation'
import * as util from 'ai4reverse-web/util'
import * as cli from 'ai4reverse-web/cli'

const vmOptions: jsvmp.BuildVMOptions = { seed: 1, name: 'testVm', obfuscate: true }
const vm: jsvmp.VMArtifact = jsvmp.buildVM(jsvmp.buildSampleProgram(), vmOptions)
const source: string = vm.code
const opcode: number = vm.opcodes[0].code
const caseLine: number = vm.dispatchTable['1'].caseLine
const mappedLine: number = vm.sourceMap[0].line
const bytecodeArgs: unknown[] = vm.bytecode[0].args
const hostResult: unknown = vm.run({ trust: 'host', args: [42] })
const rootSource: string = api.buildVM([]).code
const constraintReport: constraint.ConstraintReport = await constraint.analyzeConstraints('if (1) { 0 }')
const opaqueCount: number = constraintReport.stats.opaque
const sat = await constraint.solveConstraints(['x * 2 === 42'])
const solved: number | string | undefined = sat.model?.x
const proof = await constraint.provePredicate('(x & 1) === 0 || (x & 1) === 1')
const proven: boolean = proof.proved
const translation: constraint.SafeTranslation = constraint.translateExpression(
  {}, {}, { type: 'NumericLiteral', value: 1 },
)
const rendered: string = constraint.renderConstraintReport(constraintReport)

const trace = instrumentation.createTraceRecorder({
  sink: { write(event) { const seq: number = event.seq; void seq } },
})
const events: ReadonlyArray<api.TraceEvent> = trace.events
const childEvents: ReadonlyArray<api.TraceEvent> = trace.child('api').events
const drained: api.TraceEvent[] = trace.drain()
const logger = logging.createLogger({ level: 'silent' })
const sink = logging.createEventSink({ logger })
api.createTraceRecorder({ sink })
sink.writeAll(events)
analysis.extractFromEvents(events)
analysis.extractStagedPayloads(events)
analysis.summarizeBehavior(events)
instrumentation.summarizeOpcodeTrace(events)

function consumeEnvironment(result: sandbox.EnvironmentInstallResult): void {
  const elapsed: number = result.tookMs
  const complete: boolean = result.complete
  const requested: string[] = result.requested
  const installMs: number = result.installed[0].ms
  const missingReason: string = result.missing[0].reason
  void [elapsed, complete, requested, installMs, missingReason]
}

const store = analysis.createArtifactStore()
const artifact = store.add({ kind: 'eval-payload', data: '42' })
const artifactId: string | undefined = artifact?.id
const artifacts = store.addAll([{ kind: 'decoded-string', data: new Uint8Array([65]) }])
const text: string = artifacts[0].text
const summaries = store.summary()
const hash: string = summaries[0].sha256
const count: number = store.stats().count
const bytes: number = store.stats().bytes
const listed: string = store.list()[0].text

const hasListeners: boolean = hook.createHookBus().hasListeners('api:*')
function consumeRuntimeChanges(
  options: Parameters<typeof invocation.createInvoker>[0],
  settle: sandbox.SandboxSettleDrained,
): void {
  invocation.createInvoker({ ...options, limitReason: () => 'timeout' })
  const timedOut: boolean = settle.timedOut
  void timedOut
}

void [hasListeners, consumeRuntimeChanges, source, opcode, caseLine, mappedLine, bytecodeArgs, hostResult, rootSource,
  events, childEvents, drained, consumeEnvironment, artifactId, text, hash, count, bytes, listed,
  sandbox, hook, restore, invocation, util, cli, opaqueCount, solved, proven, translation, rendered]
