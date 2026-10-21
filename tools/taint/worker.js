import { createRequire } from 'node:module'
import { parentPort, workerData } from 'node:worker_threads'
import { buildTaintConfig } from './config.js'
import { projectTaintIR } from './report.js'

// Only installed parser assets and the caller's source bytes are consumed.
// File names are metadata, never module imports or paths to samples to execute.
async function run() {
  const engine = await import('circle-ir')
  engine.setLogLevel('silent')
  const version = createRequire(import.meta.url)('circle-ir/package.json').version
  const config = buildTaintConfig(engine, workerData.options.config, workerData.options.useDefaultConfig)
  const ir = await engine.analyze(workerData.source, workerData.options.filename, workerData.options.language, {
    taintConfig: config,
    speculativeParamSources: workerData.options.speculativeParamSources,
  })
  return projectTaintIR(ir, { ...workerData.options, engineVersion: version })
}

if (parentPort) {
  run().then(
    (report) => parentPort.postMessage({ report }),
    (error) => parentPort.postMessage({ error: { code: 'TAINT_ENGINE', message: String(error?.message ?? error).slice(0, 4096) } }),
  )
}
