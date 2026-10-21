const SEVERITIES = ['critical', 'high', 'medium', 'low']
const LANGUAGES = ['javascript', 'typescript', 'tsx']

function invalid(message) {
  throw new TypeError(`invalid taint config: ${message}`)
}

/** Validate caller-supplied patterns, without loading Circle-IR in the host. */
export function validateTaintConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) invalid('expected an object')
  const keys = ['sources', 'sinks', 'sanitizers']
  for (const key of Object.keys(config)) if (!keys.includes(key)) invalid(`unknown key ${key}`)
  for (const key of keys) {
    if (config[key] === undefined) continue
    if (!Array.isArray(config[key]) || config[key].length > 500) invalid(`${key} must be an array of at most 500 patterns`)
    for (const rule of config[key]) {
      if (!rule || typeof rule !== 'object' || Array.isArray(rule)) invalid(`${key} patterns must be objects`)
      const allowed = key === 'sources'
        ? ['method', 'class', 'property', 'object', 'annotation', 'method_annotation', 'type', 'severity', 'return_tainted', 'param_tainted', 'property_tainted', 'languages', 'note']
        : key === 'sinks'
          ? ['method', 'class', 'type', 'cwe', 'severity', 'arg_positions', 'languages', 'exclude_languages', 'note', 'allow_unresolved_receiver', 'safe_if_class_literal_at', 'safe_if_string_literal_at', 'safe_if_stream_arg_at']
          : ['method', 'class', 'annotation', 'removes', 'note']
      for (const [name, value] of Object.entries(rule)) {
        if (!allowed.includes(name)) invalid(`unknown ${key} pattern key ${name}`)
        if (['languages', 'exclude_languages'].includes(name)) {
          if (!Array.isArray(value) || value.length === 0 || value.length > LANGUAGES.length || !value.every((item) => LANGUAGES.includes(item))) {
            invalid(`${name} must contain javascript, typescript or tsx`)
          }
        } else if (name === 'arg_positions') {
          if (!Array.isArray(value) || value.length > 20 || !value.every((item) => Number.isSafeInteger(item) && item >= 0 && item <= 100)) {
            invalid('arg_positions must contain at most 20 argument indexes from 0 to 100')
          }
        } else if (['safe_if_class_literal_at', 'safe_if_string_literal_at', 'safe_if_stream_arg_at'].includes(name)) {
          if (!Number.isSafeInteger(value) || value < 0 || value > 100) {
            invalid(`${name} must be an argument index from 0 to 100`)
          }
        } else if (name === 'removes') {
          if (!Array.isArray(value) || value.length === 0 || value.length > 40 || !value.every((item) => typeof item === 'string' && item.length > 0 && item.length <= 100)) {
            invalid('removes must contain sink type names')
          }
        } else if (['return_tainted', 'param_tainted', 'property_tainted', 'allow_unresolved_receiver'].includes(name)) {
          if (typeof value !== 'boolean') invalid(`${name} must be boolean`)
        } else if (typeof value !== 'string' || value.length === 0 || value.length > 1024) {
          invalid(`${name} must be a non-empty string of at most 1024 characters`)
        }
      }
      if (key === 'sources' && !rule.method && !rule.property && !rule.annotation && !rule.method_annotation) {
        invalid('a source needs method, property or annotation')
      }
      if (key === 'sources' && rule.property && !rule.object) invalid('a property source needs object')
      if (key === 'sinks' && (!rule.method || !rule.cwe || !rule.arg_positions)) invalid('a sink needs method, cwe and arg_positions')
      if (key === 'sanitizers' && ((!rule.method && !rule.annotation) || !rule.removes)) invalid('a sanitizer needs method or annotation, and removes')
      if (key !== 'sanitizers' && (!rule.type || !SEVERITIES.includes(rule.severity))) invalid('sources and sinks need type and severity')
    }
  }
}

/** Fresh per-request patterns; never mutate the library's shared defaults. */
export function buildTaintConfig(engine, custom = {}, useDefaults = true) {
  const defaults = engine.getDefaultConfig()
  // `useDefaultConfig:false` drops the pattern lists but keeps the sink
  // semantics registry: it is a reporting gate for engine defaults, not a
  // source of sources/sinks a caller opted out of.
  const base = useDefaults
    ? defaults
    : {
        sources: [],
        sinks: [],
        sanitizers: [],
        ...(defaults.sinkSemantics ? { sinkSemantics: defaults.sinkSemantics } : {}),
      }
  for (const rule of custom.sources ?? []) {
    if (!engine.SOURCE_TYPES.includes(rule.type)) invalid(`unknown source type ${rule.type}`)
  }
  for (const rule of custom.sinks ?? []) {
    if (!engine.SINK_TYPES.includes(rule.type)) invalid(`unknown sink type ${rule.type}`)
  }
  for (const rule of custom.sanitizers ?? []) {
    if (!rule.removes.every((type) => engine.SINK_TYPES.includes(type))) invalid('unknown sanitizer sink type')
  }
  return structuredClone({
    ...base,
    sources: [...base.sources, ...(custom.sources ?? [])].map((rule) => ({
      ...rule,
      // Circle-IR only matches a method source when return_tainted is true and
      // an annotated parameter when param_tainted is true. Coercing the
      // documented intent is better than accepting a pattern that never fires.
      ...(rule.method && rule.return_tainted === undefined ? { return_tainted: true } : {}),
      ...(rule.annotation && rule.param_tainted === undefined ? { param_tainted: true } : {}),
      ...(rule.property && rule.object && rule.property_tainted === undefined ? { property_tainted: true } : {}),
    })),
    sinks: [...base.sinks, ...(custom.sinks ?? [])],
    sanitizers: [...base.sanitizers, ...(custom.sanitizers ?? [])],
  })
}
