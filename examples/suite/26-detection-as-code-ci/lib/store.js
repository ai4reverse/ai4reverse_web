/**
 * Detection repository I/O.
 *
 * A detection repository is a directory of `.yar` and `.yml` files grouped by
 * basename: `js_src_malicious_ab12cd34.yar` + `.yml` form one unit, but either
 * half may exist alone. Loading is tolerant by design: a malformed file becomes
 * an entry in `errors` rather than aborting the scan, so CI can report every
 * problem in one run.
 */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { parseSigma, parseYara, renderSigma, renderYara } from './rules.js'

const YARA_EXTENSION = /\.(?:yar|yara)$/i
const SIGMA_EXTENSION = /\.(?:yml|yaml)$/i

const baseName = (file) => basename(file).replace(/\.(?:yar|yara|yml|yaml)$/i, '')

/**
 * Load every rule file below `directory`.
 *
 * @param {string} directory
 * @returns {Promise<{detections: object[], errors: {file: string, message: string}[], files: string[]}>}
 */
export async function loadDetections(directory) {
  let names = []
  try {
    names = await readdir(directory)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return { detections: [], errors: [], files: [] }
  }
  const files = names
    .filter((name) => YARA_EXTENSION.test(name) || SIGMA_EXTENSION.test(name))
    .sort()
    .map((name) => join(directory, name))
  const detections = []
  const errors = []
  for (const file of files) {
    const text = await readFile(file, 'utf8')
    try {
      const rule = YARA_EXTENSION.test(file) ? parseYara(text) : parseSigma(text)
      detections.push({
        id: rule.id ?? rule.name ?? baseName(file),
        name: rule.name ?? rule.title,
        kind: rule.kind,
        unit: baseName(file),
        file,
        reference: rule.meta?.reference?.replace(/^sample:/, '') ?? null,
        rule,
      })
    } catch (error) {
      errors.push({ file, message: error.message })
    }
  }
  return { detections, errors, files }
}

/**
 * Write a generated detection unit, skipping halves that already exist.
 *
 * @param {string} directory
 * @param {object} unit detection unit from `buildDetectionUnit`
 * @returns {Promise<{written: string[], skipped: string[], name: string}>}
 */
export async function writeDetection(directory, unit) {
  await mkdir(directory, { recursive: true })
  const stem = unit.name.toLowerCase()
  const targets = []
  if (unit.strings.length > 0 && unit.condition) targets.push([join(directory, `${stem}.yar`), renderYara(unit)])
  if (unit.selections.length > 0 && unit.sigmaCondition) targets.push([join(directory, `${stem}.yml`), renderSigma(unit)])
  const written = []
  const skipped = []
  for (const [path, content] of targets) {
    try {
      await writeFile(path, content, { encoding: 'utf8', flag: 'wx' })
      written.push(path)
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      skipped.push(path)
    }
  }
  return { written, skipped, name: unit.name }
}
