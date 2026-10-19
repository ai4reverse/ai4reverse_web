/**
 * The protected signing program, written in NSL (the VM subset).
 *
 * This is the code that runs *inside* the JSVMP. It performs the security-
 * relevant half of request signing:
 *
 *   - percent-encodes and sorts the query pairs (canonicalisation),
 *   - concatenates the signed header lines,
 *   - builds the canonical request and the signature base,
 *   - derives session material through the host KDF,
 *   - chooses the hybrid-envelope layer plan from that material,
 *   - derives the VM key id.
 *
 * It deliberately does not touch the SM2 private key: the VM returns the string
 * to sign, and the JS layer (itself white-box keyed) performs the signature.
 * That keeps the VM free of big-integer code and makes the VM's output
 * independently checkable against the reference canonicaliser — a mismatch
 * aborts signing.
 */

export const SIGNING_PROGRAM_SOURCE = String.raw`
function main(ctx) {
  var h = ctx.h
  var i = 0
  var j = 0
  var q = ctx.query
  var pairs = []
  for (i = 0; i < q.length; i = i + 1) {
    pairs.push([h.pct(q[i][0]), h.pct(q[i][1])])
  }
  for (i = 1; i < pairs.length; i = i + 1) {
    var item = pairs[i]
    j = i - 1
    while (j >= 0 && (pairs[j][0] > item[0] || (pairs[j][0] === item[0] && pairs[j][1] > item[1]))) {
      pairs[j + 1] = pairs[j]
      j = j - 1
    }
    pairs[j + 1] = item
  }
  var query = ""
  for (i = 0; i < pairs.length; i = i + 1) {
    if (i > 0) { query = query + "&" }
    query = query + pairs[i][0] + "=" + pairs[i][1]
  }
  var headerLines = ""
  var headers = ctx.headers
  for (i = 0; i < headers.length; i = i + 1) {
    if (i > 0) { headerLines = headerLines + "\n" }
    headerLines = headerLines + headers[i][0] + ":" + headers[i][1]
  }
  var canonical = ctx.method + "\n" + ctx.path + "\n" + query + "\n" + ctx.bodyHash + "\n" + headerLines + "\n"
  var material = h.kdf(ctx.sessionKey, "nsdk/sign/v1/vm/" + ctx.nonce, 32)
  var sigBase = h.sm3hex(canonical + "|" + ctx.ts + "|" + ctx.nonce + "|" + ctx.fp + "|" + ctx.risk)
  var pool = h.layers()
  var count = 3 + (h.byte(material, 0) % 3)
  var plans = []
  var attempts = 0
  while (plans.length < count && attempts < 64) {
    var candidate = pool[h.byte(material, (attempts % 30) + 1) % pool.length]
    var duplicate = false
    for (j = 0; j < plans.length; j = j + 1) {
      if (plans[j] === candidate) { duplicate = true }
    }
    if (duplicate === false) { plans.push(candidate) }
    attempts = attempts + 1
  }
  var kid = h.hexslice(material, 0, 8)
  return { canonical: canonical, sigBase: sigBase, layers: plans, kid: kid }
}
`
