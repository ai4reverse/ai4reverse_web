#!/usr/bin/env bash
# CLI cookbook: every command runs offline with no host side effects.
set -euo pipefail
cd "$(dirname "$0")/.."

section() {
  printf '\n=== %s ===\n' "$1"
}

section "list restoration passes"
node tools/cli.js passes

section "version"
node tools/cli.js version

section "analyze a malicious loader (Markdown report)"
node tools/cli.js analyze examples/sample-loader.js --log-level silent | head -20

section "machine-readable verdict and IOCs"
node tools/cli.js analyze examples/sample-loader.js --json --log-level silent \
  | node -e 'let raw="";process.stdin.on("data",c=>raw+=c).on("end",()=>{const r=JSON.parse(raw);console.log({verdict:r.verdict,urls:r.static.iocs.urls.map(u=>u.value),artifacts:r.artifacts.map(a=>a.kind)})})'

section "benign control sample"
node tools/cli.js analyze examples/benign.js --json --log-level silent \
  | node -e 'let raw="";process.stdin.on("data",c=>raw+=c).on("end",()=>{const r=JSON.parse(raw);console.log(r.verdict.level, r.verdict.score)})'

section "restore an obfuscated sample"
node tools/cli.js restore examples/string-array-obfuscated.js --exclude rename | head -20

section "restore with a pass subset"
node tools/cli.js restore examples/control-flow-flattened.js --passes control-flow,dead-code --json --log-level silent \
  | node -e 'let raw="";process.stdin.on("data",c=>raw+=c).on("end",()=>{const r=JSON.parse(raw);console.log(r.passes.filter(p=>p.changed).map(p=>p.id))})'

section "single dynamic run with the raw trace"
node tools/cli.js run examples/anti-analysis.js --events | head -5

section "constraint solving (opaque predicates and dead arms)"
node tools/cli.js constraint examples/control-flow-flattened.js

section "JSVMP tracing summary"
node tools/cli.js analyze examples/jsvmp-sample.js --json --log-level silent \
  | node -e 'let raw="";process.stdin.on("data",c=>raw+=c).on("end",()=>{const r=JSON.parse(raw);console.log(r.tracing.jsvmp)})'

section "static taint evidence (no execution)"
node tools/cli.js taint examples/sample-loader.js --json \
  | node -e 'let raw="";process.stdin.on("data",c=>raw+=c).on("end",()=>{const r=JSON.parse(raw);console.log({ok:r.ok,engine:r.engine,flows:r.flows.length,sinks:r.stats.sinks})})'
node tools/cli.js analyze examples/sample-loader.js --no-dynamic --no-taint --json --log-level silent \
  | node -e 'let raw="";process.stdin.on("data",c=>raw+=c).on("end",()=>{const r=JSON.parse(raw);if(r.static.taint.enabled!==false)throw new Error("static.taint.enabled should be false");console.log({taint:{enabled:r.static.taint.enabled,flows:r.static.taint.flows.length}})})'

section "write a report to a file"
tmp_report="${TMPDIR:-/tmp}/ai4reverse-example-report.md"
node tools/cli.js analyze examples/network-c2.js --out "$tmp_report" --log-level silent
wc -c "$tmp_report"

section "static-only analysis (never executes the sample)"
node tools/cli.js analyze examples/anti-analysis.js --no-dynamic --json --log-level silent \
  | node -e 'let raw="";process.stdin.on("data",c=>raw+=c).on("end",()=>{const r=JSON.parse(raw);console.log({executed:r.dynamic.ok,techniques:r.static.techniques})})'
