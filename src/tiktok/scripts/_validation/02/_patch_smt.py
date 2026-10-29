p = 'src/tiktok/validation/02-semantics/smt-eval.mjs'
s = open(p).read()

s = s.replace(
    """  update(node) {
    if (node.argument.type !== 'Identifier') throw new Unsupported('update of a non-identifier')
    const name = node.argument.name
    const current = this.identifier(name)
    const next = this.binaryText(node.operator === '++' ? '+' : '-', current, {
      text: '1',
      type: 'int',
    })
    this.env.set(name, next)
    return node.prefix ? next : current
  }""",
    """  update(node) {
    if (node.argument.type !== 'Identifier') throw new Unsupported('update of a non-identifier')
    const name = node.argument.name
    const current = this.identifier(name)
    const next = this.binaryText(node.operator === '++' ? '+' : '-', current, {
      text: '1',
      type: 'int',
    })
    // Same rule as assignment(): a register-shaped name is a register write.
    const reg = Object.prototype.hasOwnProperty.call(PROLOGUE_REG, name)
      ? PROLOGUE_REG[name]
      : /^r(\\d+)$/.exec(name)?.[1]
    if (reg !== undefined) this.writeRegister(Number(reg), next)
    else this.env.set(name, next)
    return node.prefix ? next : current
  }""",
)
open(p, 'w').write(s)
print('patched', len(s))
