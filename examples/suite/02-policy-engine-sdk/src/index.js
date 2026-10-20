/**
 * Policy Engine SDK — deterministic RBAC/ABAC evaluation with deny-overrides.
 *
 * A policy is a declarative document: an ordered set of rules (subject, action,
 * resource, conditions) plus a role inheritance graph. Evaluation is pure and
 * side-effect free: the same policy + request always produces the same decision
 * and the same explanation trace, independent of key order in the JSON.
 *
 * Conditions use a small, closed operator DSL (no eval, no dynamic code), which
 * keeps policy documents auditable and safe to load from untrusted storage.
 */

export const VERSION = '1.0.0'
export const POLICY_SCHEMA = 'ai4r.policy/v1'
export const EFFECTS = Object.freeze(['allow', 'deny'])
export const DEFAULT_EFFECT = 'deny'

/** @typedef {'allow' | 'deny'} Effect */
/** @typedef {{attribute: string, op: string, value?: unknown}} Condition */
/** @typedef {{id: string, effect: Effect, priority: number, subjects: string[], actions: string[], resources: string[], conditions: Condition[], description: string}} Rule */
/** @typedef {{subject: unknown, action: string, resource: unknown, context?: Record<string, unknown>}} AccessRequest */

export class PolicyError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {unknown} [details]
   */
  constructor(code, message, details) {
    super(message)
    this.name = 'PolicyError'
    this.code = code
    this.details = details
  }
}

export class PolicyValidationError extends PolicyError {
  /** @param {{code: string, message: string, ruleId?: string | null, field?: string | null}[]} errors */
  constructor(errors) {
    super('POLICY_INVALID', `policy has ${errors.length} validation error(s)`, errors)
    this.name = 'PolicyValidationError'
    this.errors = errors
  }
}

/** @param {unknown} value */
function stableValue(value) {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => stableValue(item)).join(',')}]`
  return `{${Object.keys(/** @type {Record<string, unknown>} */ (value))
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableValue(/** @type {any} */ (value)[key])}`)
    .join(',')}}`
}

/**
 * Resolve a dotted attribute path (`subject.department`, `resource.owner`) from
 * an evaluation scope. Missing segments resolve to `undefined` rather than throw.
 * @param {unknown} source
 * @param {string} path
 */
export function readPath(source, path) {
  let current = source
  for (const segment of path.split('.')) {
    if (current === null || current === undefined) return undefined
    current = /** @type {any} */ (current)[segment]
  }
  return current
}

/**
 * Closed condition operator table. Each implementation is total: it returns a
 * boolean for any input and never throws on type mismatches.
 * @type {Record<string, (actual: unknown, expected: unknown) => boolean>}
 */
export const OPERATORS = Object.freeze({
  eq: (actual, expected) => stableValue(actual) === stableValue(expected),
  neq: (actual, expected) => stableValue(actual) !== stableValue(expected),
  in: (actual, expected) => Array.isArray(expected) && expected.some((item) => stableValue(item) === stableValue(actual)),
  nin: (actual, expected) => Array.isArray(expected) && !expected.some((item) => stableValue(item) === stableValue(actual)),
  lt: (actual, expected) => compareOrdered(actual, expected) < 0,
  lte: (actual, expected) => compareOrdered(actual, expected) <= 0,
  gt: (actual, expected) => compareOrdered(actual, expected) > 0,
  gte: (actual, expected) => compareOrdered(actual, expected) >= 0,
  contains: (actual, expected) =>
    Array.isArray(actual) ? actual.some((item) => stableValue(item) === stableValue(expected)) : typeof actual === 'string' && actual.includes(String(expected)),
  startsWith: (actual, expected) => typeof actual === 'string' && actual.startsWith(String(expected)),
  endsWith: (actual, expected) => typeof actual === 'string' && actual.endsWith(String(expected)),
  regex: (actual, expected) => {
    if (typeof actual !== 'string' || typeof expected !== 'string') return false
    try {
      return new RegExp(expected, 'u').test(actual)
    } catch {
      return false
    }
  },
  exists: (actual, expected) => (actual !== undefined && actual !== null) === (expected !== false),
})

export const OPERATOR_NAMES = Object.freeze(Object.keys(OPERATORS))

/**
 * @param {unknown} actual
 * @param {unknown} expected
 */
function compareOrdered(actual, expected) {
  if (typeof actual === 'number' && typeof expected === 'number') return actual < expected ? -1 : actual > expected ? 1 : 0
  if (typeof actual === 'string' && typeof expected === 'string') return actual < expected ? -1 : actual > expected ? 1 : 0
  return Number.NaN
}

/**
 * Compile a `*` wildcard selector into an anchored RegExp. Wildcards are the
 * only metacharacter; everything else is escaped so patterns cannot inject regex.
 * @param {string} pattern
 * @returns {RegExp}
 */
export function compileGlob(pattern) {
  if (typeof pattern !== 'string' || pattern.length === 0) throw new PolicyError('BAD_PATTERN', 'pattern must be a non-empty string')
  const source = pattern
    .split('*')
    .map((segment) => segment.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${source}$`, 'u')
}

/**
 * @param {string} pattern
 * @param {string} value
 */
export function globMatch(pattern, value) {
  if (pattern === '*') return true
  try {
    return compileGlob(pattern).test(value)
  } catch {
    return false
  }
}

/**
 * Expand roles through the inheritance graph (`admin -> editor -> viewer`).
 * Cycles are tolerated: the visited set makes expansion terminate deterministically.
 * @param {Iterable<string>} roles
 * @param {Record<string, string[]>} [roleGraph]
 * @returns {string[]} sorted role list, including inherited roles
 */
export function expandRoles(roles, roleGraph = {}) {
  const seen = new Set()
  const queue = [...roles].filter((role) => typeof role === 'string' && role.length > 0)
  while (queue.length > 0) {
    const role = /** @type {string} */ (queue.shift())
    if (seen.has(role)) continue
    seen.add(role)
    for (const inherited of roleGraph[role] ?? []) if (!seen.has(inherited)) queue.push(inherited)
  }
  return [...seen].sort()
}

/**
 * @typedef {{id: string, roles: string[], attributes: Record<string, unknown>}} Subject
 */

/**
 * Normalize a subject (string id or `{id, roles, attributes}`) and expand roles.
 * @param {unknown} subject
 * @param {Record<string, string[]>} [roleGraph]
 * @returns {Subject}
 */
export function normalizeSubject(subject, roleGraph = {}) {
  if (typeof subject === 'string' && subject.length > 0) {
    return { id: subject, roles: [], attributes: {} }
  }
  if (!subject || typeof subject !== 'object') throw new PolicyError('BAD_REQUEST', 'subject must be a string id or an object')
  const record = /** @type {Record<string, any>} */ (subject)
  if (typeof record.id !== 'string' || record.id.length === 0) throw new PolicyError('BAD_REQUEST', 'subject.id is required')
  const roles = Array.isArray(record.roles) ? record.roles.filter((role) => typeof role === 'string') : []
  const attributes = record.attributes && typeof record.attributes === 'object' ? record.attributes : {}
  return { id: record.id, roles: expandRoles(roles, roleGraph), attributes }
}

/**
 * Subject selectors: `*`, `role:<name>`, `user:<glob>`, or a bare id/role name.
 * @param {string} selector
 * @param {Subject} subject
 */
export function matchSubject(selector, subject) {
  if (selector === '*') return true
  if (selector.startsWith('role:')) return subject.roles.includes(selector.slice(5))
  if (selector.startsWith('user:')) return globMatch(selector.slice(5), subject.id)
  return subject.id === selector || subject.roles.includes(selector)
}

/**
 * @param {unknown} resource
 * @returns {{id: string, type: string | null, attributes: Record<string, unknown>}}
 */
function normalizeResource(resource) {
  if (typeof resource === 'string' && resource.length > 0) return { id: resource, type: null, attributes: {} }
  if (!resource || typeof resource !== 'object') throw new PolicyError('BAD_REQUEST', 'resource must be a string or an object')
  const record = /** @type {Record<string, any>} */ (resource)
  const id = typeof record.id === 'string' ? record.id : record.name
  if (typeof id !== 'string' || id.length === 0) throw new PolicyError('BAD_REQUEST', 'resource.id is required')
  const type = typeof record.type === 'string' ? record.type : null
  const attributes = record.attributes && typeof record.attributes === 'object' ? record.attributes : {}
  const rest = { ...record }
  delete rest.id
  delete rest.type
  delete rest.attributes
  return { id, type, attributes: { ...rest, ...attributes } }
}

/**
 * @param {{resource: ReturnType<typeof normalizeResource>}} scope
 */
function resourceCandidates(scope) {
  const { id, type } = scope.resource
  return [type ? `${type}:${id}` : id, id]
}

/**
 * Build the immutable attribute scope used by conditions.
 * @param {AccessRequest} request
 * @param {Subject} subject
 */
function buildScope(request, subject) {
  const resource = normalizeResource(request.resource)
  return {
    subject: { id: subject.id, roles: subject.roles, ...subject.attributes },
    resource: { ...resource, ...resource.attributes },
    action: request.action,
    context: request.context ?? {},
  }
}

/**
 * @param {Condition} condition
 * @param {ReturnType<typeof buildScope>} scope
 */
function evaluateCondition(condition, scope) {
  const actual = readPath(scope, condition.attribute)
  const operator = OPERATORS[condition.op]
  let ok = false
  let error = null
  try {
    ok = operator ? operator(actual, condition.value) : false
  } catch (caught) {
    error = /** @type {Error} */ (caught).message
  }
  return {
    attribute: condition.attribute,
    op: condition.op,
    expected: condition.value === undefined ? null : condition.value,
    actual: actual === undefined ? null : actual,
    ok,
    ...(error ? { error } : {}),
  }
}

/** @param {Rule} left @param {Rule} right */
function compareRules(left, right) {
  if (right.priority !== left.priority) return right.priority - left.priority
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
}

/**
 * Validate a policy document. Returns every problem instead of stopping at the
 * first one so authors can fix a policy in a single pass.
 * @param {unknown} policy
 * @returns {{valid: boolean, errors: {code: string, message: string, ruleId: string | null, field: string | null}[]}}
 */
export function validatePolicy(policy) {
  /** @type {{code: string, message: string, ruleId: string | null, field: string | null}[]} */
  const errors = []
  const push = (code, message, ruleId = null, field = null) => errors.push({ code, message, ruleId, field })
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    push('POLICY_SHAPE', 'policy must be an object')
    return { valid: false, errors }
  }
  const document = /** @type {Record<string, any>} */ (policy)
  if (document.defaultEffect !== undefined && !EFFECTS.includes(document.defaultEffect)) {
    push('DEFAULT_EFFECT', 'defaultEffect must be allow or deny', null, 'defaultEffect')
  }
  if (document.roleGraph !== undefined) {
    if (!document.roleGraph || typeof document.roleGraph !== 'object' || Array.isArray(document.roleGraph)) {
      push('ROLE_GRAPH_SHAPE', 'roleGraph must be an object mapping role to inherited roles', null, 'roleGraph')
    } else {
      for (const [role, inherited] of Object.entries(document.roleGraph)) {
        if (!Array.isArray(inherited) || inherited.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
          push('ROLE_GRAPH_ENTRY', `role ${role} must map to an array of role names`, null, 'roleGraph')
        }
      }
    }
  }
  if (!Array.isArray(document.rules)) {
    push('RULES_SHAPE', 'rules must be an array', null, 'rules')
    return { valid: false, errors }
  }
  const seen = new Set()
  document.rules.forEach((rule, index) => {
    const label = rule && typeof rule === 'object' && typeof rule.id === 'string' ? rule.id : `#${index}`
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
      push('RULE_SHAPE', `rule ${label} must be an object`, label)
      return
    }
    if (typeof rule.id !== 'string' || rule.id.length === 0) push('RULE_ID', `rule ${label} needs a non-empty id`, label, 'id')
    else if (seen.has(rule.id)) push('RULE_ID_DUPLICATE', `duplicate rule id ${rule.id}`, rule.id, 'id')
    else seen.add(rule.id)
    if (!EFFECTS.includes(rule.effect)) push('RULE_EFFECT', `rule ${label} effect must be allow or deny`, label, 'effect')
    if (rule.priority !== undefined && !Number.isFinite(rule.priority)) push('RULE_PRIORITY', `rule ${label} priority must be a finite number`, label, 'priority')
    for (const field of ['subjects', 'actions', 'resources']) {
      const value = rule[field]
      if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
        push('RULE_SELECTOR', `rule ${label} ${field} must be a non-empty array of strings`, label, field)
      }
    }
    if (rule.conditions !== undefined && !Array.isArray(rule.conditions)) {
      push('RULE_CONDITIONS', `rule ${label} conditions must be an array`, label, 'conditions')
    }
    const conditions = Array.isArray(rule.conditions) ? rule.conditions : []
    conditions.forEach((condition, conditionIndex) => {
      if (!condition || typeof condition !== 'object' || typeof condition.attribute !== 'string' || condition.attribute.length === 0) {
        push('CONDITION_ATTRIBUTE', `rule ${label} condition #${conditionIndex} needs an attribute path`, label, 'conditions')
        return
      }
      if (!OPERATOR_NAMES.includes(condition.op)) {
        push('CONDITION_OPERATOR', `rule ${label} condition ${condition.attribute} uses unknown operator ${condition.op}`, label, 'conditions')
        return
      }
      if (condition.op === 'regex' && (typeof condition.value !== 'string' || condition.value.length > 512)) {
        push('CONDITION_REGEX', `rule ${label} regex must be a string under 512 chars`, label, 'conditions')
      } else if (condition.op === 'regex') {
        try {
          new RegExp(condition.value, 'u')
        } catch {
          push('CONDITION_REGEX', `rule ${label} regex does not compile: ${condition.value}`, label, 'conditions')
        }
      } else if (['in', 'nin'].includes(condition.op) && !Array.isArray(condition.value)) {
        push('CONDITION_VALUE', `rule ${label} operator ${condition.op} requires an array value`, label, 'conditions')
      } else if (['contains', 'startsWith', 'endsWith'].includes(condition.op) && typeof condition.value !== 'string') {
        push('CONDITION_VALUE', `rule ${label} operator ${condition.op} requires a string value`, label, 'conditions')
      } else if (condition.op === 'exists' && typeof condition.value !== 'boolean') {
        push('CONDITION_VALUE', `rule ${label} operator exists requires a boolean value`, label, 'conditions')
      } else if (!['regex', 'in', 'nin', 'contains', 'startsWith', 'endsWith', 'exists'].includes(condition.op) && !('value' in condition)) {
        push('CONDITION_VALUE', `rule ${label} condition ${condition.attribute} is missing value`, label, 'conditions')
      }
    })
  })
  return { valid: errors.length === 0, errors }
}

/**
 * @param {Rule | Record<string, any>} rule
 * @returns {Rule}
 */
function normalizeRule(rule) {
  return {
    id: rule.id,
    effect: rule.effect,
    priority: Number.isFinite(rule.priority) ? rule.priority : 0,
    subjects: [...rule.subjects],
    actions: [...rule.actions],
    resources: [...rule.resources],
    conditions: (rule.conditions ?? []).map((condition) => ({
      attribute: condition.attribute,
      op: condition.op,
      ...(condition.value === undefined ? {} : { value: condition.value }),
    })),
    description: typeof rule.description === 'string' ? rule.description : '',
  }
}

/**
 * Deterministic policy evaluation engine.
 */
export class PolicyEngine {
  /** @type {Rule[]} */
  #rules
  /** @type {Record<string, string[]>} */
  #roleGraph
  /** @type {Effect} */
  #defaultEffect
  /** @type {Map<string, RegExp[]>} */
  #actionMatchers = new Map()
  /** @type {Map<string, RegExp[]>} */
  #resourceMatchers = new Map()

  /** @param {unknown} policy */
  constructor(policy) {
    const validation = validatePolicy(policy)
    if (!validation.valid) throw new PolicyValidationError(validation.errors)
    const document = /** @type {Record<string, any>} */ (policy)
    this.#rules = document.rules.map(normalizeRule).sort(compareRules)
    this.#roleGraph = document.roleGraph ?? {}
    this.#defaultEffect = document.defaultEffect ?? DEFAULT_EFFECT
    for (const rule of this.#rules) {
      this.#actionMatchers.set(rule.id, rule.actions.map(compileGlob))
      this.#resourceMatchers.set(rule.id, rule.resources.map(compileGlob))
    }
  }

  /** @param {string} json */
  static fromJSON(json) {
    let parsed
    try {
      parsed = JSON.parse(json)
    } catch (error) {
      throw new PolicyError('POLICY_JSON', 'policy is not valid JSON', /** @type {Error} */ (error).message)
    }
    return new PolicyEngine(parsed)
  }

  /** @returns {Record<string, unknown>} */
  toJSON() {
    return {
      schema: POLICY_SCHEMA,
      defaultEffect: this.#defaultEffect,
      roleGraph: Object.fromEntries(
        Object.entries(this.#roleGraph)
          .sort(([left], [right]) => (left < right ? -1 : 1))
          .map(([role, inherited]) => [role, [...inherited]]),
      ),
      rules: this.#rules.map((rule) => ({ ...rule, conditions: rule.conditions.map((condition) => ({ ...condition })) })),
    }
  }

  /** @returns {string} */
  serialize() {
    return JSON.stringify(this.toJSON())
  }

  get ruleCount() {
    return this.#rules.length
  }

  get defaultEffect() {
    return this.#defaultEffect
  }

  /**
   * Evaluate a request and return the complete explanation.
   * @param {AccessRequest} request
   */
  explain(request) {
    if (!request || typeof request.action !== 'string' || request.action.length === 0) {
      throw new PolicyError('BAD_REQUEST', 'request.action is required')
    }
    const subject = normalizeSubject(request.subject, this.#roleGraph)
    const scope = buildScope(request, subject)
    const resourceValues = resourceCandidates(scope)
    /** @type {Record<string, any>[]} */
    const trace = []
    /** @type {Rule[]} */
    const matchedRules = []
    for (const rule of this.#rules) {
      const subjectsMatched = rule.subjects.some((selector) => matchSubject(selector, subject))
      const actionMatched = (this.#actionMatchers.get(rule.id) ?? []).some((matcher) => matcher.test(request.action))
      const resourceMatched = (this.#resourceMatchers.get(rule.id) ?? []).some((matcher) =>
        resourceValues.some((value) => matcher.test(value)),
      )
      const conditions = subjectsMatched && actionMatched && resourceMatched
        ? rule.conditions.map((condition) => evaluateCondition(condition, scope))
        : []
      const conditionsMatched = conditions.length === rule.conditions.length && conditions.every((entry) => entry.ok)
      const matched = subjectsMatched && actionMatched && resourceMatched && conditionsMatched
      trace.push({
        ruleId: rule.id,
        effect: rule.effect,
        priority: rule.priority,
        description: rule.description,
        subjectsMatched,
        actionMatched,
        resourceMatched,
        conditionsMatched,
        conditions,
        matched,
      })
      if (matched) matchedRules.push(rule)
    }
    const denied = matchedRules.filter((rule) => rule.effect === 'deny')
    const allowed = matchedRules.filter((rule) => rule.effect === 'allow')
    let decision
    let reason
    let matchedRule = null
    if (denied.length > 0) {
      decision = 'deny'
      reason = 'explicit-deny'
      matchedRule = denied[0].id
    } else if (allowed.length > 0) {
      decision = 'allow'
      reason = 'explicit-allow'
      matchedRule = allowed[0].id
    } else {
      decision = this.#defaultEffect
      reason = `default-${this.#defaultEffect}`
    }
    return {
      decision,
      reason,
      matchedRule,
      evaluated: trace.length,
      roles: subject.roles,
      trace,
    }
  }

  /**
   * Evaluate a request. Pass `{explain: true}` to include the rule trace.
   * @param {AccessRequest} request
   * @param {{explain?: boolean}} [options]
   */
  evaluate(request, options = {}) {
    const explanation = this.explain(request)
    if (options.explain) return explanation
    return {
      decision: explanation.decision,
      reason: explanation.reason,
      matchedRule: explanation.matchedRule,
      evaluated: explanation.evaluated,
    }
  }

  /**
   * Boolean convenience wrapper.
   * @param {unknown} subject
   * @param {string} action
   * @param {unknown} resource
   * @param {Record<string, unknown>} [context]
   */
  can(subject, action, resource, context = {}) {
    return this.evaluate({ subject, action, resource, context }).decision === 'allow'
  }
}

/**
 * @param {unknown} policy
 * @returns {PolicyEngine}
 */
export function createPolicyEngine(policy) {
  return new PolicyEngine(policy)
}
