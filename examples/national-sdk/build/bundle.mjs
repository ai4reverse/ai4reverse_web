/**
 * Minimal ESM bundler for the SDK's own source.
 *
 * The SDK is written as ordinary ES modules so every file can be tested in
 * isolation. The protected artifact must be one self-contained script (a browser
 * SDK cannot use `import` in a dynamically injected tag), so the build wraps
 * each module in an IIFE and returns its exports:
 *
 *     var __nsdk_m_3 = (function () { ...; return { x1a2: a, x3b4: b }; })();
 *
 * Export names are remapped to per-build random identifiers, so a static reader
 * cannot recover internal API names from the bundle's module boundaries. The
 * importer destructures the same keys, which keeps the bundle correct without
 * any renaming tool.
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { createPrng } from '../src/core/prng.js'

const IMPORT_NAMED = /^import\s*\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"];?[ \t]*$/gm
const IMPORT_NAMESPACE = /^import\s*\*\s*as\s+(\w+)\s+from\s*['"]([^'"]+)['"];?[ \t]*$/gm
const IMPORT_DEFAULT = /^import\s+(\w+)\s+from\s*['"]([^'"]+)['"];?[ \t]*$/gm
const EXPORT_DECL = /^export\s+(async\s+)?(function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm
const EXPORT_LIST = /^export\s*\{([^}]*)\}\s*;?[ \t]*$/gm
const EXPORT_FROM = /^export\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"];?[ \t]*$/gm

const KEY_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'

/**
 * @param {{entry: string, root?: string, seed?: string|number, randomizeExports?: boolean}} options
 * @returns {Promise<{code: string, modules: string[], files: Array<{id:number,file:string}>, entryId: number}>}
 */
export async function bundle(options) {
  const root = options.root ?? process.cwd()
  const entry = path.resolve(root, options.entry)
  const randomizeExports = options.randomizeExports !== false
  const prng = createPrng(options.seed ?? 'bundle-seed', 'bundle-exports')
  const modulePrefix = `__${Array.from({ length: 7 }, () => KEY_ALPHABET[prng.int(KEY_ALPHABET.length)]).join('')}_`
  /** @type {Map<string, {id: number, file: string, source: string, dir: string}>} */
  const modules = new Map()
  const order = []
  /** @type {Map<number, Map<string, string>>} module id -> exported name -> bundle key */
  const exportKeys = new Map()

  async function load(file) {
    const resolved = path.resolve(file)
    if (modules.has(resolved)) return modules.get(resolved)
    const source = await readFile(resolved, 'utf8')
    const record = { id: modules.size, file: resolved, source, dir: path.dirname(resolved) }
    modules.set(resolved, record)
    const specs = []
    for (const regex of [IMPORT_NAMED, IMPORT_NAMESPACE, IMPORT_DEFAULT, EXPORT_FROM]) {
      regex.lastIndex = 0
      for (const match of source.matchAll(regex)) {
        const spec = match[match.length - 1]
        if (!spec.startsWith('.')) throw new Error(`${resolved}: non-relative import '${spec}' is not bundleable`)
        specs.push(spec)
      }
    }
    for (const spec of specs) await load(resolveSpecifier(record.dir, spec))
    order.push(record)
    return record
  }

  const entryRecord = await load(entry)

  /** @param {number} id @param {string} name */
  function keyFor(id, name) {
    if (!randomizeExports) return name
    let map = exportKeys.get(id)
    if (!map) {
      map = new Map()
      exportKeys.set(id, map)
    }
    if (!map.has(name)) {
      const used = new Set(map.values())
      for (;;) {
        let key = 'x'
        for (let index = 0; index < 5; index += 1) key += KEY_ALPHABET[prng.int(KEY_ALPHABET.length)]
        if (!used.has(key)) {
          map.set(name, key)
          break
        }
      }
    }
    return map.get(name)
  }

  const chunks = []
  for (const record of order) {
    const keyForModule = (id, name) => (id === entryRecord.id ? name : keyFor(id, name))
    chunks.push(renderModule(record, modules, keyForModule, modulePrefix))
  }
  const code = [
    '(function () {',
    "'use strict';",
    ...chunks,
    `globalThis.NSDK = ${modulePrefix}${entryRecord.id};`,
    '})();',
    '',
  ].join('\n')
  return {
    code,
    modules: order.map((record) => path.relative(root, record.file)),
    files: order.map((record) => ({ id: record.id, file: path.relative(root, record.file) })),
    entryId: entryRecord.id,
  }
}

/** @param {string} dir @param {string} spec */
function resolveSpecifier(dir, spec) {
  const base = path.resolve(dir, spec)
  return base.endsWith('.js') ? base : `${base}.js`
}

/**
 * @param {{id: number, source: string, file: string}} record
 * @param {Map<string, {id: number}>} modules
 * @param {(id: number, name: string) => string} keyFor
 * @param {string} modulePrefix
 */
function renderModule(record, modules, keyFor, modulePrefix) {
  let source = record.source
  const self = record.id

  const dependencyId = (spec) => {
    const resolved = resolveSpecifier(path.dirname(record.file), spec)
    const dependency = modules.get(resolved)
    if (!dependency) throw new Error(`${record.file}: unresolved import ${spec}`)
    return dependency.id
  }

  source = source.replace(IMPORT_NAMED, (_match, bindings, spec) => {
    const id = dependencyId(spec)
    const mapping = bindings
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const [name, alias] = entry.split(/\s+as\s+/)
        const local = alias ?? name
        return `${keyFor(id, name)}: ${local}`
      })
      .join(', ')
    return `var { ${mapping} } = ${modulePrefix}${id};`
  })
  source = source.replace(IMPORT_NAMESPACE, (_match, name, spec) => `var ${name} = ${modulePrefix}${dependencyId(spec)};`)
  source = source.replace(IMPORT_DEFAULT, (_match, name, spec) => `var ${name} = ${modulePrefix}${dependencyId(spec)}.default;`)

  const exported = new Set()
  source = source.replace(EXPORT_FROM, (_match, bindings, spec) => {
    const id = dependencyId(spec)
    const mapping = bindings
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const [name, alias] = entry.split(/\s+as\s+/)
        const exportedName = alias ?? name
        exported.add(exportedName)
        return `${keyFor(id, name)}: ${keyFor(self, exportedName)}`
      })
      .join(', ')
    // Local aliases are not needed: the object literal returns the dependency's
    // value directly under this module's export key.
    return `var __reexport_${id} = ${modulePrefix}${id};`
  })
  // Re-export values are injected into the exports object by name lookup.
  const reexportLines = []
  source = source.replace(/^var __reexport_(\d+) = __nsdk_m_\d+;$/gm, '')
  // Re-scan for `export ... from` so aliases resolve to dependency keys.
  for (const match of record.source.matchAll(EXPORT_FROM)) {
    const [, bindings, spec] = match
    const id = dependencyId(spec)
    for (const entry of bindings.split(',').map((value) => value.trim()).filter(Boolean)) {
      const [name, alias] = entry.split(/\s+as\s+/)
      const exportedName = alias ?? name
      reexportLines.push(`${JSON.stringify(keyFor(self, exportedName))}: ${modulePrefix}${id}[${JSON.stringify(keyFor(id, name))}]`)
    }
  }

  source = source.replace(EXPORT_DECL, (_match, asyncKeyword, kind, name) => {
    exported.add(name)
    return `${asyncKeyword ?? ''}${kind} ${name}`
  })
  source = source.replace(EXPORT_LIST, (_match, list) => {
    for (const entry of list.split(',').map((value) => value.trim()).filter(Boolean)) {
      const [name, alias] = entry.split(/\s+as\s+/)
      exported.add(alias ?? name)
      reexportLines.push(`${JSON.stringify(keyFor(self, alias ?? name))}: ${name}`)
    }
    return ''
  })
  if (/^\s*export\s/m.test(source)) throw new Error(`${record.file}: unsupported export form left after transform`)
  if (/^\s*import\s/m.test(source)) throw new Error(`${record.file}: unsupported import form left after transform`)

  // Declarations are exported under their generated keys; `export { ... }` and
  // `export ... from` entries are emitted as explicit key/value pairs.
  const declarationExports = Array.from(exported)
    .filter((name) => !reexportLines.some((line) => line.startsWith(JSON.stringify(keyFor(self, name)))))
    .map((name) => `${JSON.stringify(keyFor(self, name))}: ${name}`)
  const exportsObject = [...declarationExports, ...reexportLines].join(', ')
  return `var ${modulePrefix}${self} = (function () {\n${source}\nreturn { ${exportsObject} };\n})();`
}

/**
 * Convenience for tests: bundle an entry and return only its code.
 * @param {string} entry
 * @param {string} [root]
 */
export async function bundleFile(entry, root) {
  const result = await bundle({ entry, root })
  return result.code
}
