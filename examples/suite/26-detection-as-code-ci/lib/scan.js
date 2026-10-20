/**
 * Repository scanning.
 *
 * Every JavaScript file below the repository root is analysed once. The result
 * is a flat sample record carrying the triage verdict plus a *match haystack*:
 * the original source, the restored source, captured artifact previews and every
 * recovered indicator. Content rules must match that haystack, which is why a
 * fileless sample (payload assembled at runtime) is still detectable from its
 * recovered strings.
 */

import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { analyzeSample } from '../../../../tools/index.js'

const SKIP_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', 'detections'])
const SOURCE_EXTENSIONS = /\.(?:js|mjs|cjs)$/i
const MAX_FILE_BYTES = 2_000_000
const MAX_HAYSTACK_CHARS = 1_500_000

/** Sorted, deterministic list of candidate sample files. */
export async function collectSamples(root) {
  const files = []
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue
        await walk(path)
      } else if (entry.isFile() && SOURCE_EXTENSIONS.test(entry.name)) {
        files.push(path)
      }
    }
  }
  await walk(root)
  return files.sort()
}

function indicatorValues(report) {
  const values = []
  for (const [category, list] of Object.entries(report?.static?.iocs ?? {})) {
    if (category === 'meta' || !Array.isArray(list)) continue
    for (const entry of list) {
      if (typeof entry?.value === 'string') values.push(entry.value)
      if (typeof entry?.decodedPreview === 'string') values.push(entry.decodedPreview)
    }
  }
  for (const artifact of report?.artifacts ?? []) {
    if (typeof artifact?.preview === 'string') values.push(artifact.preview)
  }
  return values
}

/** Build the haystack content rules match against. */
export function buildHaystack(source, report) {
  const parts = [source]
  if (typeof report?.static?.restoration?.code === 'string') parts.push(report.static.restoration.code)
  parts.push(...indicatorValues(report))
  const unique = [...new Set(parts.filter((part) => typeof part === 'string' && part.length > 0))]
  return unique.join('\n').slice(0, MAX_HAYSTACK_CHARS)
}

/** Flat field record used by behavioural (Sigma) rules. */
function buildRecord(source, report, haystack) {
  const iocs = report?.static?.iocs ?? {}
  const urls = (iocs.urls ?? []).map((entry) => entry.value).filter(Boolean)
  const domains = [
    ...(iocs.domains ?? []).map((entry) => entry.value),
    ...urls.map((url) => /^[a-z]+:\/\/([^/:?#]+)/i.exec(url)?.[1]).filter(Boolean),
  ].filter(Boolean)
  const techniques = report?.static?.techniques ?? []
  const stages = (report?.dynamic?.behavior?.killChain ?? []).map((stage) => stage?.stage).filter(Boolean)
  const kinds = Object.keys(report?.dynamic?.counts?.byKind ?? {})
  const actions = [...new Set((report?.dynamic?.events ?? []).map((event) => event?.event).filter(Boolean))]
  const suspiciousTld = ['urls', 'domains'].some((category) => (iocs[category] ?? []).some((entry) => entry?.suspiciousTld === true))
  return {
    text: haystack.toLowerCase(),
    source: source.toLowerCase(),
    url: urls.join(' ').toLowerCase(),
    domain: [...new Set(domains)].join(' ').toLowerCase(),
    technique: techniques.join(' ').toLowerCase(),
    stage: stages.join(' ').toLowerCase(),
    kind: kinds.join(' ').toLowerCase(),
    action: actions.join(' ').toLowerCase(),
    suspiciousTld: suspiciousTld ? 'true' : 'false',
  }
}

/**
 * Analyse every JavaScript file below `root`.
 *
 * @param {string} root repository directory
 * @param {{failOn?: 'malicious'|'suspicious', minScore?: number, seed?: number}} [options]
 */
export async function scanRepo(root, options = {}) {
  const files = await collectSamples(root)
  const samples = []
  for (const path of files) {
    const info = await stat(path)
    if (!info.isFile() || info.size > MAX_FILE_BYTES) continue
    const source = await readFile(path, 'utf8')
    const analysis = await analyzeSample(source, {
      name: path,
      logLevel: 'silent',
      seed: options.seed ?? 0x5eed,
      network: { policy: 'deny' },
    })
    const report = analysis.report
    const haystack = buildHaystack(source, report)
    samples.push({
      path,
      relative: relative(root, path),
      size: info.size,
      sha256: createHash('sha256').update(source).digest('hex'),
      verdict: report.verdict.level,
      score: report.verdict.score,
      families: report.verdict.families,
      techniques: report.static.techniques,
      haystack,
      record: buildRecord(source, report, haystack),
      report,
    })
  }
  return { root, scanned: samples.length, samples }
}
