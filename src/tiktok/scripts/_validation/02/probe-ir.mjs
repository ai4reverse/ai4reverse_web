#!/usr/bin/env node
/** Inspect translateHandler's IR shape for a few simple opcodes. */
import _generate from '@babel/generator'
import { translateHandler } from '../../15-lift.mjs'

const generate = _generate.default ?? _generate

for (const [op, operands] of [
  [294, [4, 7]],
  [358, [7, 1, 8, 1]],
  [7, [9, 9, 23, 8, 16]],
  [2, [9, 71, 13]],
  [355, [8, 7, 2923, 7, 7, 2936]],
  [234, [4809, 10, 4831, 7, 10, 8]],
  [239, [4909]],
  [316, [4909, 4918, 10]],
]) {
  try {
    const ir = translateHandler(op, operands)
    console.log(`op${op} ${JSON.stringify(operands)} jump=${JSON.stringify(ir.jump)} consumed=${ir.operandsConsumed}`)
    for (const s of ir.statements ?? []) console.log('   ', generate(s).code)
  } catch (err) {
    console.log(`op${op}: refused: ${err.message}`)
  }
}
