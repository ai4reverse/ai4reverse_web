/**
 * Rule loading from disk.
 *
 * Targets may be a single `.yml`/`.yaml`/`.json` file, a YAML bundle holding
 * several `---` documents, or a directory of rule files. Directory traversal is
 * recursive and sorted so the compiled rule order (and therefore the CLI output)
 * is reproducible across machines.
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { compileRuleText } from './rules.js'

const RULE_EXTENSIONS = /\.(?:ya?ml|json)$/i

async function collectRuleFiles(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await collectRuleFiles(path)))
    else if (entry.isFile() && RULE_EXTENSIONS.test(entry.name)) files.push(path)
  }
  return files.sort()
}

/**
 * Load and compile every rule reachable from `target`.
 *
 * @param {string} target file or directory
 * @returns {Promise<{compiled: object[], sources: {path: string, rules: number}[]}>}
 */
export async function loadRules(target) {
  const info = await stat(target)
  const files = info.isDirectory() ? await collectRuleFiles(target) : [target]
  const compiled = []
  const sources = []
  const seen = new Map()
  for (const file of files) {
    const text = await readFile(file, 'utf8')
    const rules = compileRuleText(text, file)
    for (const entry of rules) {
      if (seen.has(entry.rule.id)) {
        throw new Error(`duplicate rule id "${entry.rule.id}" in ${seen.get(entry.rule.id)} and ${file}`)
      }
      seen.set(entry.rule.id, file)
    }
    compiled.push(...rules)
    sources.push({ path: file, rules: rules.length })
  }
  return { compiled, sources }
}
