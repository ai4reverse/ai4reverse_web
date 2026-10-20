import { createPolicyEngine } from './src/index.js'

const engine = createPolicyEngine({
  defaultEffect: 'deny',
  roleGraph: { admin: ['editor'], editor: ['viewer'] },
  rules: [
    { id: 'deny-suspended', effect: 'deny', priority: 100, subjects: ['*'], actions: ['*'], resources: ['*'], conditions: [{ attribute: 'subject.status', op: 'eq', value: 'suspended' }] },
    { id: 'admin-write', effect: 'allow', priority: 10, subjects: ['role:admin'], actions: ['write'], resources: ['doc:*'] },
    { id: 'viewer-read', effect: 'allow', priority: 1, subjects: ['role:viewer'], actions: ['read'], resources: ['*'] },
  ],
})

const subject = { id: 'alice', roles: ['admin'] }
const allow = engine.explain({ subject, action: 'write', resource: { type: 'doc', id: 'runbook' } })
const deny = engine.explain({ subject: { ...subject, attributes: { status: 'suspended' } }, action: 'write', resource: 'doc:runbook' })
console.log('allow:', allow.decision, 'via', allow.matchedRule, 'roles', allow.roles.join(','))
console.log('deny:', deny.decision, 'via', deny.matchedRule, 'reason', deny.reason)
console.log('trace length:', allow.evaluated)
