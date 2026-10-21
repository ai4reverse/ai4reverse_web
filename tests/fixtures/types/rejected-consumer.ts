import { assemble, buildVM, createArtifactStore, createTraceRecorder } from 'ai4reverse-web'
import type { EnvironmentInstallResult } from 'ai4reverse-web/sandbox'

const vm = buildVM([])
// @ts-expect-error buildVM returns an artifact, not source text.
const source: string = vm
// @ts-expect-error Host execution requires explicit trust acknowledgement.
vm.run()
// @ts-expect-error Only the literal host trust acknowledgement is valid.
vm.run({ trust: 'guest' })
// @ts-expect-error buildVM accepts readable instructions, not an assembled program.
buildVM(assemble([]))
// @ts-expect-error A callback is not a write-object sink.
createTraceRecorder({ sink: () => undefined })

const trace = createTraceRecorder()
// @ts-expect-error Snapshot arrays are readonly.
trace.events.push({ seq: 1, t: 0, wall: 0, kind: 'api', phase: 'emit', actor: 'test' })
// @ts-expect-error Snapshot array elements cannot be overwritten.
trace.events[0] = trace.events[1]
// @ts-expect-error Child snapshot arrays are readonly too.
trace.child('api').events.pop()

const store = createArtifactStore()
// @ts-expect-error The store does not implement get.
store.get('missing')
// @ts-expect-error Summaries intentionally omit artifact text.
const text: string = store.summary()[0].text

function rejectPhantomEnvironmentFields(result: EnvironmentInstallResult): void {
  // @ts-expect-error Failures use missing records, not a phantom failed list.
  result.failed
  // @ts-expect-error There is no skipped list.
  result.skipped
  // @ts-expect-error Missing entries are structured id/reason records.
  const missing: string[] = result.missing
  void missing
}

import { analyzeTaint } from 'ai4reverse-web/taint'
// @ts-expect-error The taint component accepts source bytes, not a file object.
analyzeTaint({ file: 'sample.js' })
// @ts-expect-error Only JS/TS/TSX parsers are exposed by this adapter.
analyzeTaint('42', { language: 'python' })
// @ts-expect-error Limit values must be numbers.
analyzeTaint('42', { limits: { timeoutMs: '1000' } })
// @ts-expect-error Sink patterns must state their argument positions.
analyzeTaint('42', { config: { sinks: [{ method: 'sink', type: 'xss', cwe: 'CWE-79', severity: 'high' }] } })

void [source, text, rejectPhantomEnvironmentFields]
