import assert from 'node:assert/strict'
import {
  OPERATORS,
  PolicyEngine,
  PolicyError,
  PolicyValidationError,
  createPolicyEngine,
  expandRoles,
  globMatch,
  validatePolicy,
} from './src/index.js'

let passed = 0
let total = 0
async function check(name, fn) {
  total += 1
  try {
    await fn()
    passed += 1
  } catch (error) {
    console.error(`FAIL ${name}: ${error.message}`)
    throw error
  }
}

const policy = {
  defaultEffect: 'deny',
  roleGraph: { admin: ['editor'], editor: ['viewer'], viewer: [] },
  rules: [
    {
      id: 'deny-suspended',
      effect: 'deny',
      priority: 100,
      subjects: ['*'],
      actions: ['*'],
      resources: ['*'],
      conditions: [{ attribute: 'subject.status', op: 'eq', value: 'suspended' }],
      description: 'suspended principals lose every permission',
    },
    {
      id: 'deny-large-invoice',
      effect: 'deny',
      priority: 60,
      subjects: ['*'],
      actions: ['approve'],
      resources: ['invoice:*'],
      conditions: [{ attribute: 'resource.amount', op: 'gte', value: 100000 }],
    },
    {
      id: 'admin-all',
      effect: 'allow',
      priority: 50,
      subjects: ['role:admin'],
      actions: ['*'],
      resources: ['*'],
    },
    {
      id: 'finance-approve',
      effect: 'allow',
      priority: 20,
      subjects: ['role:finance'],
      actions: ['approve'],
      resources: ['invoice:*'],
      conditions: [
        { attribute: 'resource.amount', op: 'lt', value: 10000 },
        { attribute: 'context.ip', op: 'regex', value: '^10\\.' },
      ],
    },
    {
      id: 'editor-write',
      effect: 'allow',
      priority: 10,
      subjects: ['role:editor'],
      actions: ['write'],
      resources: ['doc:*'],
      conditions: [{ attribute: 'context.mfa', op: 'eq', value: true }],
    },
    {
      id: 'alice-own-read',
      effect: 'allow',
      priority: 5,
      subjects: ['user:alice'],
      actions: ['read'],
      resources: ['doc:*'],
      conditions: [{ attribute: 'resource.owner', op: 'eq', value: 'alice' }],
    },
    {
      id: 'viewer-read',
      effect: 'allow',
      priority: 1,
      subjects: ['role:viewer'],
      actions: ['read'],
      resources: ['*'],
    },
  ],
}

const engine = createPolicyEngine(policy)
const alice = { id: 'alice', roles: ['admin'] }
const bob = { id: 'bob', roles: ['viewer'] }
const finance = { id: 'fiona', roles: ['finance'] }

await check('valid policy passes validation', () => {
  const result = validatePolicy(policy)
  assert.equal(result.valid, true, JSON.stringify(result.errors))
  assert.equal(result.errors.length, 0)
  assert.equal(engine.ruleCount, 7)
  assert.deepEqual(expandRoles(['admin'], policy.roleGraph), ['admin', 'editor', 'viewer'])
})

await check('validation reports every structural error', () => {
  const invalid = {
    defaultEffect: 'maybe',
    roleGraph: { admin: 'editor' },
    rules: [
      { id: 'dup', effect: 'permit', priority: Number.NaN, subjects: [], actions: [], resources: [], conditions: [{ attribute: '', op: 'nope' }] },
      { id: 'dup', effect: 'allow', subjects: ['*'], actions: ['*'], resources: ['*'], conditions: [{ attribute: 'a.b', op: 'in', value: 'not-array' }, { attribute: 'a.c', op: 'nope' }] },
      { id: 'regex', effect: 'allow', subjects: ['*'], actions: ['*'], resources: ['*'], conditions: [{ attribute: 'a.b', op: 'regex', value: '(' }] },
      { id: 'missing', effect: 'allow', subjects: ['*'], actions: ['*'], resources: ['*'], conditions: [{ attribute: 'a.b', op: 'eq' }] },
    ],
  }
  const { valid, errors } = validatePolicy(invalid)
  assert.equal(valid, false)
  const codes = new Set(errors.map((error) => error.code))
  for (const code of ['DEFAULT_EFFECT', 'ROLE_GRAPH_ENTRY', 'RULE_EFFECT', 'RULE_PRIORITY', 'RULE_SELECTOR', 'RULE_ID_DUPLICATE', 'CONDITION_ATTRIBUTE', 'CONDITION_OPERATOR', 'CONDITION_VALUE', 'CONDITION_REGEX']) {
    assert.ok(codes.has(code), `missing validation code ${code}`)
  }
  assert.throws(() => new PolicyEngine(invalid), (error) => error instanceof PolicyValidationError && error.errors.length === errors.length)
  assert.equal(validatePolicy(null).valid, false)
})

await check('role inheritance grants inherited permissions', () => {
  assert.equal(engine.can(alice, 'read', { type: 'doc', id: 'd1' }), true)
  assert.equal(engine.can(bob, 'read', 'doc:d2'), true)
  assert.equal(engine.can({ id: 'carol', roles: [] }, 'read', 'doc:d2'), false)
  assert.deepEqual(engine.evaluate({ subject: alice, action: 'read', resource: 'doc:d1' }), {
    decision: 'allow',
    reason: 'explicit-allow',
    matchedRule: 'admin-all',
    evaluated: 7,
  })
})

await check('deny-overrides wins regardless of allow priority', () => {
  const suspended = { id: 'alice', roles: ['admin'], attributes: { status: 'suspended' } }
  const decision = engine.evaluate({ subject: suspended, action: 'read', resource: 'doc:d1' })
  assert.equal(decision.decision, 'deny')
  assert.equal(decision.reason, 'explicit-deny')
  assert.equal(decision.matchedRule, 'deny-suspended')
  const large = engine.evaluate({ subject: finance, action: 'approve', resource: { type: 'invoice', id: 'INV-9', amount: 200000 }, context: { ip: '10.0.0.7' } })
  assert.equal(large.decision, 'deny')
  assert.equal(large.matchedRule, 'deny-large-invoice')
})

await check('abac conditions gate the finance approval path', () => {
  const resource = { type: 'invoice', id: 'INV-1', amount: 500 }
  const allowed = engine.evaluate({ subject: finance, action: 'approve', resource, context: { ip: '10.1.2.3' } })
  assert.equal(allowed.decision, 'allow')
  assert.equal(allowed.matchedRule, 'finance-approve')
  const wrongNetwork = engine.evaluate({ subject: finance, action: 'approve', resource, context: { ip: '192.168.1.9' } })
  assert.equal(wrongNetwork.decision, 'deny')
  const tooLarge = engine.evaluate({ subject: finance, action: 'approve', resource: { ...resource, amount: 20000 }, context: { ip: '10.1.2.3' } })
  assert.equal(tooLarge.decision, 'deny')
})

await check('missing attributes are false, never exceptions', () => {
  const editor = { id: 'erin', roles: ['editor'] }
  const result = engine.explain({ subject: editor, action: 'write', resource: 'doc:x' })
  assert.equal(result.decision, 'deny')
  assert.equal(result.reason, 'default-deny')
  const editorRule = result.trace.find((entry) => entry.ruleId === 'editor-write')
  assert.equal(editorRule.conditionsMatched, false)
  assert.deepEqual(editorRule.conditions, [
    { attribute: 'context.mfa', op: 'eq', expected: true, actual: null, ok: false },
  ])
  assert.equal(engine.can(editor, 'write', 'doc:x', { mfa: true }), true)
  const wrongOwner = engine.explain({ subject: { id: 'alice', roles: [] }, action: 'read', resource: { type: 'doc', id: 'd1', owner: 'bob' } })
  assert.equal(wrongOwner.decision, 'deny')
})

await check('resource globs match type:id and bare ids', () => {
  assert.equal(globMatch('doc:*', 'doc:123'), true)
  assert.equal(globMatch('doc:*', 'doc'), false)
  assert.equal(globMatch('*', 'anything'), true)
  assert.equal(globMatch('a.b', 'a.b'), true)
  assert.equal(globMatch('a.b', 'axb'), false)
  assert.equal(engine.can(bob, 'read', { type: 'doc', id: 'd7', owner: 'someone' }), true)
})

await check('evaluation is deterministic for shuffled input order', () => {
  const shuffled = { ...policy, rules: [...policy.rules].reverse() }
  const reordered = createPolicyEngine(shuffled)
  const request = { subject: alice, action: 'write', resource: 'doc:d1', context: { mfa: true } }
  const first = engine.explain(request)
  const second = reordered.explain(request)
  assert.equal(first.decision, second.decision)
  assert.equal(first.matchedRule, second.matchedRule)
  assert.deepEqual(first.trace.map((entry) => entry.ruleId), second.trace.map((entry) => entry.ruleId))
  assert.deepEqual(first.trace, second.trace)
  assert.deepEqual(first.roles, ['admin', 'editor', 'viewer'])
})

await check('explain exposes the matched rule and condition evidence', () => {
  const result = engine.explain({ subject: finance, action: 'approve', resource: { type: 'invoice', id: 'INV-1', amount: 500 }, context: { ip: '10.9.9.9' } })
  assert.equal(result.reason, 'explicit-allow')
  const matched = result.trace.filter((entry) => entry.matched).map((entry) => entry.ruleId)
  assert.deepEqual(matched, ['finance-approve'])
  assert.equal(result.trace.length, 7)
  assert.equal(result.evaluated, 7)
  const condition = result.trace.find((entry) => entry.ruleId === 'finance-approve').conditions[0]
  assert.equal(condition.actual, 500)
  assert.equal(condition.ok, true)
})

await check('condition operator DSL covers the documented matrix', () => {
  assert.equal(OPERATORS.eq({ a: 1, b: 2 }, { b: 2, a: 1 }), true)
  assert.equal(OPERATORS.neq('a', 'b'), true)
  assert.equal(OPERATORS.in('eu', ['eu', 'us']), true)
  assert.equal(OPERATORS.nin('ap', ['eu', 'us']), true)
  assert.equal(OPERATORS.lt(3, 5), true)
  assert.equal(OPERATORS.gt('b', 'a'), true)
  assert.equal(OPERATORS.contains('hello world', 'world'), true)
  assert.equal(OPERATORS.startsWith('prod-eu-1', 'prod-'), true)
  assert.equal(OPERATORS.endsWith('report.pdf', '.pdf'), true)
  assert.equal(OPERATORS.regex('token-42', '^token-\\d+$'), true)
  assert.equal(OPERATORS.exists(0, true), true)
  assert.equal(OPERATORS.exists(null, true), false)
  assert.equal(OPERATORS.exists(undefined, false), true)
  assert.equal(OPERATORS.in(undefined, 'not-an-array'), false)
})

await check('default effect is configurable and reasoned', () => {
  const open = createPolicyEngine({ defaultEffect: 'allow', rules: [] })
  const decision = open.evaluate({ subject: 'guest', action: 'read', resource: 'public' })
  assert.equal(decision.decision, 'allow')
  assert.equal(decision.reason, 'default-allow')
  assert.equal(decision.matchedRule, null)
  assert.equal(engine.can('guest', 'read', 'public'), false)
})

await check('serialization round-trips to an equivalent engine', () => {
  const json = engine.serialize()
  const restored = PolicyEngine.fromJSON(json)
  assert.deepEqual(restored.toJSON(), engine.toJSON())
  const request = { subject: alice, action: 'write', resource: 'doc:d1', context: { mfa: true } }
  assert.deepEqual(restored.explain(request), engine.explain(request))
  assert.equal(JSON.parse(restored.serialize()).schema, 'ai4r.policy/v1')
  assert.throws(() => PolicyEngine.fromJSON('{bad json'), (error) => error.code === 'POLICY_JSON')
  assert.throws(() => engine.evaluate({ subject: alice, resource: 'doc:d1' }), (error) => error instanceof PolicyError && error.code === 'BAD_REQUEST')
})

console.log(`checks: ${passed}/${total}`)
