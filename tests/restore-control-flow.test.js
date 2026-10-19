import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'

import { parse } from '../tools/restore/parse.js'
import { generate } from '../tools/restore/generate.js'
import { runPass } from '../tools/restore/pass-context.js'
import * as controlFlow from '../tools/restore/passes/control-flow.js'

/**
 * Run the pass over `source` and return the regenerated code plus the pass report.
 * @param {string} source
 * @returns {{code: string, changed: boolean, notes: string[]}}
 */
function transform(source) {
  const { ast } = parse(source)
  const result = runPass(controlFlow, ast, {})
  return { code: generate(ast).code, changed: result.changed, notes: result.notes }
}

/**
 * Execute a self-contained snippet in a fresh Node context and return the value
 * of its trailing `__out` expression.
 * @param {string} source
 * @returns {unknown}
 */
function runScript(source) {
  return vm.runInNewContext(`${source}\n__out;`, {}, { timeout: 2000 })
}

test('flattens a string-sequence dispatch loop in the sequence order', () => {
  const source = `
var out = [];
var order = '3|1|2|0'.split('|'), idx = 0;
while (true) {
  switch (order[idx++]) {
    case '0': out.push(0); continue;
    case '1': out.push(1); continue;
    case '2': out.push(2); continue;
    case '3': out.push(3); continue;
  }
  break;
}
var __out = out.join(',');
`
  const result = transform(source)
  assert.equal(result.changed, true)
  assert.ok(!result.code.includes('switch'), 'switch dispatch loop must be gone')
  assert.ok(!result.code.includes('order[idx++]'), 'discriminant must be gone')
  assert.equal(runScript(source), '3,1,2,0')
  assert.equal(runScript(result.code), runScript(source))
})

test('flattens numeric case labels with an array sequence and for(;;)', () => {
  const source = `
var out = [];
var seq = [2, 0, 1], i = 0;
for (;;) {
  switch (seq[i++]) {
    case 0: out.push('a'); continue;
    case 1: out.push('b'); continue;
    case 2: out.push('c'); continue;
  }
  break;
}
var __out = out.join('');
`
  const result = transform(source)
  assert.equal(result.changed, true)
  assert.equal(runScript(source), 'cab')
  assert.equal(runScript(result.code), runScript(source))
})

test('recognises the while (!![]) spelling of an infinite loop test', () => {
  const source = `
var out = [];
var order = '1|0'.split('|'), idx = 0;
while (!![]) {
  switch (order[idx++]) {
    case '0': out.push('second'); continue;
    case '1': out.push('first'); continue;
  }
  break;
}
var __out = out.join(' ');
`
  const result = transform(source)
  assert.equal(result.changed, true)
  assert.deepEqual(runScript(result.code), 'first second')
})

test('keeps a dispatch loop whose case body reads idx', () => {
  const source = `
var out = [];
var order = '0|1'.split('|'), idx = 0;
while (true) {
  switch (order[idx++]) {
    case '0': out.push('a' + idx); continue;
    case '1': out.push('b'); continue;
  }
  break;
}
var __out = out.join('');
`
  const result = transform(source)
  assert.equal(result.changed, false)
  assert.equal(result.notes.length, 1)
  assert.match(result.notes[0], /left untouched/)
  assert.match(result.notes[0], /idx/)
  assert.equal(runScript(result.code), runScript(source))
})

test('keeps a dispatch loop whose case declares let/const', () => {
  const source = `
var order = '0'.split('|'), idx = 0;
while (true) {
  switch (order[idx++]) {
    case '0': let scoped = 1; continue;
  }
  break;
}
var __out = 'done';
`
  const result = transform(source)
  assert.equal(result.changed, false)
  assert.match(result.notes.join('\n'), /let\/const/)
  assert.equal(runScript(result.code), 'done')
})

test('keeps a dispatch loop without the trailing break', () => {
  const source = `
var order = '0'.split('|'), idx = 0;
while (true) {
  switch (order[idx++]) {
    case '0': continue;
  }
}
var __out = 'unreachable';
`
  const result = transform(source)
  assert.equal(result.changed, false)
  assert.match(result.notes.join('\n'), /trailing break/)
})

test('keeps a case body that falls through to the next case', () => {
  const source = `
var out = [];
var order = '0|1'.split('|'), idx = 0;
while (true) {
  switch (order[idx++]) {
    case '0': out.push('a');
    case '1': out.push('b'); continue;
  }
  break;
}
var __out = out.join('');
`
  const result = transform(source)
  assert.equal(result.changed, false)
  assert.match(result.notes.join('\n'), /falls through/)
  assert.equal(runScript(result.code), runScript(source))
})

test('keeps a case body that breaks out of the switch', () => {
  const source = `
var out = [];
var order = '0|1'.split('|'), idx = 0;
while (true) {
  switch (order[idx++]) {
    case '0': { out.push('a'); break; }
    case '1': out.push('b'); continue;
  }
  break;
}
var __out = out.join('');
`
  const result = transform(source)
  assert.equal(result.changed, false)
  assert.match(result.notes.join('\n'), /untouched/)
  assert.equal(runScript(result.code), runScript(source))
})

test('allows an inner loop break inside a case body', () => {
  const source = `
var out = [];
var order = '1|0'.split('|'), idx = 0;
while (true) {
  switch (order[idx++]) {
    case '0':
      for (var j = 0; j < 3; j++) { if (j === 1) break; out.push('j' + j); }
      continue;
    case '1': out.push('start'); continue;
  }
  break;
}
var __out = out.join('');
`
  const result = transform(source)
  assert.equal(result.changed, true)
  assert.equal(runScript(result.code), runScript(source))
})

test('keeps a loop whose body has statements besides the switch', () => {
  const source = `
var order = '0'.split('|'), idx = 0;
while (true) {
  before();
  switch (order[idx++]) {
    case '0': continue;
  }
  break;
}
function before() {}
var __out = 'unchanged';
`
  const result = transform(source)
  assert.equal(result.changed, false)
  assert.equal(result.notes.length, 0, 'ordinary loops must not produce noise')
})

test('keeps a dispatch loop whose order binding is reassigned', () => {
  const source = `
var order = '0|1'.split('|'), idx = 0;
while (true) {
  switch (order[idx++]) {
    case '0': order = '1|0'.split('|'); continue;
    case '1': continue;
  }
  break;
}
var __out = 'x';
`
  const result = transform(source)
  assert.equal(result.changed, false)
  assert.match(result.notes.join('\n'), /reassigned/)
})

test('ignores ordinary loops silently', () => {
  const result = transform('var total = 0; while (total < 3) { total++; } var __out = total;')
  assert.equal(result.changed, false)
  assert.deepEqual(result.notes, [])
  assert.equal(runScript(result.code), 3)
})

test('flattens nested dispatch loops whose bindings are declared inside a case', () => {
  const source = `
var out = [];
var outerOrder = '1|0'.split('|'), outerIdx = 0;
while (true) {
  switch (outerOrder[outerIdx++]) {
    case '0': out.push('tail'); continue;
    case '1':
      var innerOrder = '0'.split('|'), innerIdx = 0;
      while (true) {
        switch (innerOrder[innerIdx++]) {
          case '0': out.push('inner'); continue;
        }
        break;
      }
      out.push('head');
      continue;
  }
  break;
}
var __out = out.join(',');
`
  const result = transform(source)
  assert.equal(result.changed, true)
  assert.ok(!result.code.includes('switch'), 'both levels must be flattened')
  assert.deepEqual(result.notes, [], 'a hoisted var declarator is not a reassignment')
  assert.equal(runScript(source), 'inner,head,tail')
  assert.equal(runScript(result.code), runScript(source))
})

test('keeps var declarations from a case body visible after the loop', () => {
  const source = `
var out = [];
var order = '1|0'.split('|'), idx = 0;
while (true) {
  switch (order[idx++]) {
    case '0': var tail = out.length; continue;
    case '1': var head = out.length; out.push('h'); continue;
  }
  break;
}
var __out = [typeof head, typeof tail, out.length].join(',');
`
  const result = transform(source)
  assert.equal(result.changed, true)
  assert.equal(runScript(result.code), 'number,number,1')
  assert.equal(runScript(result.code), runScript(source))
})

test('flattens a dispatch loop in a single-statement position', () => {
  const source = `
var out = [];
var order = '0|1'.split('|'), idx = 0;
if (out.length === 0) while (true) {
  switch (order[idx++]) {
    case '0': out.push('x'); continue;
    case '1': out.push('y'); continue;
  }
  break;
}
var __out = out.join('');
`
  const result = transform(source)
  assert.equal(result.changed, true)
  assert.equal(runScript(result.code), 'xy')
  assert.equal(runScript(result.code), runScript(source))
})

test('is idempotent', () => {
  const source = `
var out = [];
var order = '1|0'.split('|'), idx = 0;
while (true) {
  switch (order[idx++]) {
    case '0': out.push('b'); continue;
    case '1': out.push('a'); continue;
  }
  break;
}
var __out = out.join('');
`
  const first = transform(source)
  assert.equal(first.changed, true)
  const second = transform(first.code)
  assert.equal(second.changed, false)
  assert.equal(second.code, first.code)
})
