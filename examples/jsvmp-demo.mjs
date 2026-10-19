#!/usr/bin/env node
/**
 * JSVMP walkthrough: build a runnable (obfuscated) interpreter with the
 * platform's builder, analyse its dispatch loop statically, then execute it in
 * the sandbox with opcode-level tracing.
 *
 * Run: node examples/jsvmp-demo.mjs
 */
import {
  buildVM,
  buildSampleProgram,
  analyzeVM,
  summarizeVM,
  TracelessSandbox,
  summarizeOpcodeTrace,
  SEMANTICS,
} from '../tools/index.js'

const obfuscated = buildVM(buildSampleProgram(), { seed: 2026, name: '__vmp_run', obfuscate: true })
// The same program without the opcode cipher: case labels stay readable, which
// makes the devirtualised trace easier to read in this demo.
const vm = buildVM(buildSampleProgram(), { seed: 2026, name: '__vmp_run', obfuscate: false })
console.log('builder:', vm.opcodes.length, 'opcodes,', vm.bytecode.length, 'instructions')
console.log('host run (plain):', vm.run(), '| (obfuscated):', obfuscated.run())

const staticAnalysis = analyzeVM(obfuscated.code)
const summary = summarizeVM(staticAnalysis)
console.log('static detection (obfuscated build):', staticAnalysis.detected, '| kind:', staticAnalysis.kind, '| score:', staticAnalysis.score)
console.log('dispatch:', summary.dispatch.discriminant, '| cases:', summary.dispatch.caseCount)
console.log('opcodes:', summary.dispatch.opcodes.join(', '))
console.log('handler bodies recovered:', summary.handlers.length)
console.log('constant pool:', summary.consts.count, summary.consts.sample.slice(0, 6))

const sandbox = await TracelessSandbox.create({
  seed: 11,
  logLevel: 'silent',
  env: { strict: true },
  instrumentation: { jsvmp: true, code: { level: 'function' } },
})

try {
  const run = await sandbox.run(`${vm.code}\n__vmp_run()`, {
    filename: 'https://cdn.example.test/assets/vm-loader.js',
  })
  console.log('dynamic ok:', run.ok, '| result:', run.result?.value)
  console.log('runtime VM detection:', run.vm ? 'yes' : 'no', '| opcodes:', run.vm?.opcodes)
  const opcodeEvents = (run.events ?? []).filter((event) => event.event === 'jsvmp:opcode')
  console.log('opcode trace events:', opcodeEvents.length)
  console.log('first opcodes:', opcodeEvents.slice(0, 12).map((event) => event.opcode).join(' '))

  const traced = summarizeOpcodeTrace(run.events ?? [], { semantics: SEMANTICS })
  console.log('distinct opcodes executed:', traced.distinctOpcodes, '| steps:', traced.steps)
  console.log('top opcodes:', traced.opcodes.slice(0, 6).map((entry) => `${entry.opcode}×${entry.count}`).join(' '))
  console.log('interpretation:', traced.devirtualized.slice(0, 8).join(' ; '))
} finally {
  sandbox.dispose()
}
