/**
 * Type declarations for the `ai4reverse-web` public API.
 *
 * These declarations are hand-written against the implementation and the JSDoc
 * in `tools/`. They exist so a consumer can type-check against the package
 * without turning on `checkJs` for the whole tree (docs/EVALUATION-TOOLS.md
 * D9.4 chose this route; a `checkJs` gate still reports hundreds of diagnostics
 * in the internal modules).
 *
 * Honesty rules used here:
 *  - every name is exactly the name the runtime exports;
 *  - shapes that the implementation does not promise are typed as `unknown` or
 *    as a loose record instead of an invented precise shape;
 *  - fields the code *always* writes are declared, additive fields are optional.
 */

import type { QuickJSContext, QuickJSHandle, QuickJSRuntime, QuickJSWASMModule } from 'quickjs-emscripten'

export type { QuickJSContext, QuickJSHandle, QuickJSRuntime, QuickJSWASMModule }

/** Pino-compatible logger surface (the logger the platform creates and accepts). */
export interface Logger {
  level?: string
  fatal(obj: object, msg?: string, ...args: unknown[]): void
  error(obj: object, msg?: string, ...args: unknown[]): void
  warn(obj: object, msg?: string, ...args: unknown[]): void
  info(obj: object, msg?: string, ...args: unknown[]): void
  debug(obj: object, msg?: string, ...args: unknown[]): void
  trace(obj: object, msg?: string, ...args: unknown[]): void
  child(bindings: object): Logger
}

/* -------------------------------------------------------------------------- */
/* errors                                                                      */
/* -------------------------------------------------------------------------- */

export interface AnalyzerErrorOptions {
  code?: string
  cause?: unknown
  details?: object
}

/* -------------------------------------------------------------------------- */
/* profiles, limits, clocks                                                    */
/* -------------------------------------------------------------------------- */

export interface ScreenShape {
  width: number
  height: number
  availWidth: number
  availHeight: number
  colorDepth: number
  pixelDepth: number
  devicePixelRatio: number
}

export interface WindowShape {
  innerWidth: number
  innerHeight: number
  outerWidth: number
  outerHeight: number
  screenX: number
  screenY: number
  scrollX: number
  scrollY: number
}

/**
 * A seeded, internally consistent browser profile. `createProfile` returns many
 * more fields than the ones declared here (WebGL strings, plugins, fonts, ...);
 * the index signature keeps them reachable without pretending to pin them.
 */
export interface Profile {
  seed: string
  os: 'windows' | 'macos' | 'linux'
  osName: string
  browser: 'chrome' | 'firefox' | 'edge' | string
  browserName: string
  browserVersion: string
  browserMajor: number
  engine: string
  vendor: string
  mobile: boolean
  userAgent: string
  appVersion: string
  appName: string
  appCodeName: string
  product: string
  platform: string
  language: string
  languages: string[]
  timezone: string
  timezoneOffsetMinutes: number
  epoch: number
  screen: ScreenShape
  window: WindowShape
  hardwareConcurrency: number
  deviceMemory: number
  maxTouchPoints: number
  crossOriginIsolated: boolean
  [key: string]: unknown
}

export interface ProfileOptions {
  seed?: number | string
  os?: string
  browser?: string
  locale?: string
  screen?: object
  mobile?: boolean
  browserVersion?: string
  userAgent?: string
  host?: string
  epoch?: number
  crossOriginIsolated?: boolean
  [key: string]: unknown
}

/** Result of `consistencyReport`: `{ ok, problems }`. */
export interface ConsistencyReport {
  ok: boolean
  problems: string[]
}

export interface Limits {
  timeoutMs: number
  maxVirtualMs: number
  interruptQuantumMs: number
  memoryBytes: number
  stackBytes: number
  maxJobs: number
  maxTimerCallbacks: number
  maxTimers: number
  maxEvents: number
  maxSourceBytes: number
}

/** Limits that `limitMessage` knows how to describe. */
export type LimitKind = 'timeout' | 'virtual-time' | 'memory' | 'stack' | 'source-size'

export interface ClockStats {
  epoch: number
  elapsedMs: number
  pendingTimers: number
  timerErrors: number
  /** Schedules refused because `maxTimers` timers were already pending. */
  droppedTimers: number
}

/** One timer callback that threw, as the virtual clock records it. */
export interface TimerCallbackError {
  timerId: number
  message: string
  /**
   * The catch site saw the engine's host stack throw. This is the marker the
   * invoker classifies from; the message is diagnostic text only.
   */
  stackExhaustion: boolean
}

/** Outcome of one virtual-clock timer batch. */
export interface TimerBatchResult {
  executed: number
  advancedMs: number
  errors: TimerCallbackError[]
  /** A timer/virtual-time budget stopped the batch before the queue was empty. */
  exhausted: boolean
  /**
   * The batch stopped because a callback exhausted the engine stack. The
   * runtime is unrecoverable; callers must not run another turn on it.
   */
  stackExhaustion: boolean
}

export interface VirtualClock {
  now(): number
  setTimeout(fn: Function, delay?: number, ...args: unknown[]): number
  clearTimeout(id: number): boolean
  setInterval(fn: Function, delay?: number, ...args: unknown[]): number
  clearInterval(id: number): boolean
  /** Drain due timers, up to `maxCallbacks` per call. */
  runDue(options?: { maxCallbacks?: number; maxVirtualMs?: number }): TimerBatchResult
  advanceToNextTimer(capMs?: number): number
  nextDueIn(): number
  stats(): ClockStats
  dispose(): void
}

/* -------------------------------------------------------------------------- */
/* tracing                                                                     */
/* -------------------------------------------------------------------------- */

export interface TraceEvent {
  seq: number
  /** Virtual epoch ms. */
  t: number
  /** Host wall clock ms. */
  wall: number
  kind: string
  phase: string
  actor: string
  [key: string]: unknown
}

export interface TraceStats {
  total: number
  retained: number
  dropped: number
  byKind: Record<string, number>
}

export interface TraceRecorderChild {
  readonly events: ReadonlyArray<TraceEvent>
  emit(phase?: string, payload?: object): TraceEvent | null
  child(kind: string, phase?: string): TraceRecorderChild
  subscribe(listener: (event: TraceEvent) => void): () => void
  stats(): TraceStats
}

export interface TraceRecorder {
  /** Detached frozen array snapshot; event objects remain shallow and shared. */
  readonly events: ReadonlyArray<TraceEvent>
  readonly size: number
  readonly dropped: number
  readonly seq: number
  emit(kind: string, phase: string, payload?: object): TraceEvent | null
  child(kind: string, phase?: string): TraceRecorderChild
  drain(): TraceEvent[]
  subscribe(listener: (event: TraceEvent) => void): () => void
  stats(): TraceStats
  clear(): void
}

export interface TraceRecorderOptions {
  limit?: number
  clock?: () => number
  sink?: { write(event: TraceEvent): void } | null
  actor?: string
  strict?: boolean
}

/* -------------------------------------------------------------------------- */
/* hooks                                                                       */
/* -------------------------------------------------------------------------- */

export interface HookRegistration {
  id: string
  phase: string
  handler: (payload: unknown, context: unknown) => unknown
  priority: number
  once: boolean
  owner: string
  traceless: object
}

export interface HookRegisteredDescriptor {
  id: string
  phase: string
  priority: number
  owner: string
  enabled: boolean
  traceless: object
}

export interface HookErrorEntry {
  hook: string
  phase: string
  message: string
}

export interface HookStats {
  hooks: number
  dispatches: number
  errors: HookErrorEntry[]
  errorsTruncated: boolean
  byPhase: Record<string, number>
}

export interface HookDispatchResult {
  blocked: boolean
  value: unknown
  args: unknown[] | undefined
  stopped: boolean
  results: { id: string; result: unknown }[]
  phase: string
}

export interface HookBus {
  on(
    phase: string,
    handler: (payload: any, context: any) => any,
    opts?: {
      priority?: number
      id?: string
      once?: boolean
      owner?: string
      traceless?: object
      context?: object
    },
  ): () => void
  off(id: string): boolean
  clear(owner?: string): void
  setEnabled(id: string, enabled: boolean): boolean
  has(phase: string): boolean
  hasListeners(phase: string): boolean
  emit(phase: string, payload?: object, extraContext?: object): { phase: string; results: { id: string; result: unknown }[] }
  dispatch(phase: string, payload?: object, extraContext?: object): HookDispatchResult
  pipeline<T>(phase: string, initial: T, extraContext?: object): { value: T; changed: boolean; steps: object[] }
  describe(): HookRegisteredDescriptor[]
  stats(): HookStats
}

export interface HookBusOptions {
  logger?: Logger
  trace?: TraceRecorder
  strict?: boolean
  record?: boolean
  recordPhases?: string[] | null
}

/** A hook descriptor as produced by the default hook factories. */
export interface HookDescriptor {
  phase: string
  handler: (payload: any, context: any) => any
  id?: string
  owner?: string
  priority?: number
  once?: boolean
  traceless?: object
  context?: object
}

/* -------------------------------------------------------------------------- */
/* environment modules                                                         */
/* -------------------------------------------------------------------------- */

export interface EnvModuleMeta {
  id: string
  order: number
  requires: readonly string[]
}

export interface EnvModule {
  meta: EnvModuleMeta
  install(bridge: HostBridge): void
}

export interface EnvironmentInstallResult {
  installed: { id: string; order: number; ms: number }[]
  missing: { id: string; reason: string }[]
  requested: string[]
  tookMs: number
  complete: boolean
}

/* -------------------------------------------------------------------------- */
/* static analysis facts                                                       */
/* -------------------------------------------------------------------------- */

/** Counters produced by `analyzeSource` (see `instrumentation/ast.js`). */
export interface StaticFacts {
  functions: number
  asyncFunctions: number
  generatorFunctions: number
  strings: number
  stringsTotal: number
  uniqueStrings: number
  regexps: number
  memberAccesses: number
  calls: number
  hexIdentifiers: number
  uniqueIdentifiers: number
  unicodeEscapes: number
  hexEscapes: number
  stringArrayDeclarations: number
  dispatchSwitches: number
  charcodeCalls: number
  atobCalls: number
  evalLike: number
  timers: number
  stringTimerCallbacks: number
  jsfuckOperators: number
  longStringBlobs: number
  debuggerStatements: number
  withStatements: number
  awaits: number
  walletLikeStrings: number
  domains: string[]
  bytes?: number
  lines?: number
  parse?: { sourceType: string; errors: number }
  obfuscation?: { score: number; indicators: { id: string; weight: number; detail: string }[] }
  techniques?: string[]
  stringSamples?: string[]
  networkCalls?: number
  [key: string]: unknown
}

export interface ObfuscationScore {
  score: number
  indicators: { id: string; weight: number; detail: string }[]
}

export interface AnalyzeSourceOptions {
  filename?: string
  maxStrings?: number
  hooks?: HookBus
  trace?: TraceRecorder
  [key: string]: unknown
}

export type AnalyzeSourceResult =
  | { ok: true; facts: StaticFacts; ast: object; sourceType: 'script' | 'module' }
  | { ok: false; error: string; facts: StaticFacts }

/* -------------------------------------------------------------------------- */
/* instrumentation                                                             */
/* -------------------------------------------------------------------------- */

export interface InstrumentedCode {
  code: string
  plan: unknown
  stats: {
    insertions: number
    skipped: number
    level: string
    [key: string]: unknown
  }
}

export interface CodeInstrumenterStats {
  installed: boolean
  insertions: number
  events: number
  skipped: number
  [key: string]: unknown
}

export interface CodeInstrumenter {
  install(): CodeInstrumenterStats
  /** Marker-enclosed expression used to reach the trace channel from the guest. */
  channelExpression(): string | null
  mergePlan(plan: unknown): void
  instrument(
    source: string,
    options?: { filename?: string; level?: string; sourceType?: 'script' | 'module' },
  ): InstrumentedCode
  stats(): CodeInstrumenterStats
  dispose(): void
}

export interface ApiInstrumenterStats {
  targets: number
  calls: number
  mocked: number
  failed: number
  [key: string]: unknown
}

export interface ApiInstrumenter {
  install(targets?: string[]): { wrapped: (string | object)[]; stats: ApiInstrumenterStats }
  stats(): ApiInstrumenterStats
  dispose(): void
}

export interface ExceptionInstrumenter {
  install(): object
  stats(): object
  dispose(): void
  [key: string]: unknown
}

export interface InstrumentationDescribe {
  installed: boolean
  code: CodeInstrumenterStats
  api: ApiInstrumenterStats
  exceptions: object
  jsvmpDetections: number
  analyses: number
  lastVm: object | null
  environment: string[] | null
}

export interface InstrumentationPrepared {
  code: string
  plan: unknown
  facts: StaticFacts | null
  vm: object | null
  sourceChangedByHooks: boolean
  stats: InstrumentedCode['stats']
}

export interface Instrumentation {
  exceptions: ExceptionInstrumenter
  code: CodeInstrumenter
  api: ApiInstrumenter
  install(options?: { wrapApis?: boolean }): InstrumentationDescribe
  prepare(
    source: string,
    options?: { filename?: string; level?: string; sourceType?: 'script' | 'module'; traceCode?: boolean },
  ): InstrumentationPrepared
  analyze(source: string, options?: AnalyzeSourceOptions): AnalyzeSourceResult
  summarizeVm(events: readonly unknown[], semantics?: Record<string, string>): object
  describe(): InstrumentationDescribe
  stats(): InstrumentationDescribe
  dispose(): void
}

export interface InstrumentationConfig {
  code?: { level?: 'off' | 'function' | 'branch' | 'statement'; marker?: string; maxEvents?: number; maxInsertions?: number }
  api?: boolean | { targets?: string[] }
  jsvmp?: boolean | { marker?: string; binding?: string }
  ast?: boolean
}

/* -------------------------------------------------------------------------- */
/* sandbox                                                                     */
/* -------------------------------------------------------------------------- */

export interface SandboxDisposalError {
  stage: string
  message: string
}

/**
 * Teardown result attached to every run record.
 *
 * `errors` is always an array. `leaked`/`stage` are only present when a step
 * failed; `leaked` means the WASM heap itself was corrupted (handle leak or
 * stack exhaustion), which is what quarantines the module.
 */
export interface SandboxDisposal {
  ok: boolean
  errors: SandboxDisposalError[]
  leaked?: boolean
  stage?: string | null
  /**
   * The runtime was abandoned instead of disposed because a stack-limit breach
   * left handles on its GC list; disposing it would abort the WASM engine. The
   * module is quarantined and the next run recompiles it.
   */
  skipped?: boolean
}

/**
 * The event-loop failure that stopped settlement.
 *
 * `origin` names the callback class that recursed (`'timer'`, `'promise-job'`
 * or `'microtask'`), which is the only attribution available when the entry
 * script itself succeeded.
 */
export interface SandboxSettleError {
  origin: string
  name: string
  message: string
  stack?: string
}

/**
 * Settlement that actually drained the event loop.
 *
 * `limitsHit` is `[]` unless a callback exhausted the stack; a stack breach is
 * also the trigger for `SandboxDisposal.skipped`.
 */
export interface SandboxSettleDrained {
  jobs: number
  timerCallbacks: number
  promiseErrors: number
  /** A job/timer/virtual-time budget ran out before the queues were empty. */
  exhausted: boolean
  timedOut: boolean
  pendingTimers: number
  virtualMs: number
  limitsHit: string[]
  /**
   * Engine stack signal seen inside a callback. Additive explicit marker: the
   * sandbox abandons the runtime from this field (and from
   * `SandboxRunRecord.stackExhaustion`), never from `limitsHit` or a guest
   * message, so a sample cannot steer the disposal path.
   */
  stackExhaustion: boolean
  error: SandboxSettleError | null
}

/**
 * Settlement that never ran because the runtime was interrupted (`'timeout'`,
 * `'virtual-time'`, `'aborted'`). Only the reason is known, so nothing else is
 * promised.
 */
export interface SandboxSettleSkipped {
  skipped: true
  reason: string
}

/**
 * Outcome of the event-loop drain after the entry script returned.
 *
 * This is where a stack breach inside a timer or promise callback is recorded:
 * the script succeeded, so `SandboxRunRecord.ok` stays true while `limitsHit`
 * gains `'stack'` and the runtime is abandoned rather than disposed.
 */
export type SandboxSettle = SandboxSettleDrained | SandboxSettleSkipped

/** Per-run overrides for the event-loop budgets used by settlement. */
export interface SandboxSettleOptions {
  maxJobs?: number
  maxTimerCallbacks?: number
  maxVirtualMs?: number
}

export interface IntegritySnapshot {
  hash: string
  takenAt: number
  globals?: string[]
  intrinsics?: Record<string, unknown>
  natives?: Record<string, unknown>
  values?: Record<string, unknown>
  globalCount?: number
  nativeCount?: number
  error?: string
  sanitized?: boolean
  [key: string]: unknown
}

export interface IntegrityDiff {
  intact: boolean
  drift: object[]
  intrinsicDrift?: object[]
  addedGlobals?: string[]
  removedGlobals?: string[]
  beforeHash?: string
  afterHash?: string
  [key: string]: unknown
}

export interface ProfileSummary {
  seed: string
  os: string
  osName: string
  browser: string
  browserName: string
  browserVersion: string
  engine: string
  platform: string
  userAgent: string
  language: string
  languages: string[]
  timezone: string
  timezoneOffsetMinutes: number
  screen: ScreenShape
  window: WindowShape
  hardwareConcurrency: number
  deviceMemory: number
  webdriver: boolean
  webgl: object
  fonts: number
  consistency: ConsistencyReport
  [key: string]: unknown
}

/** One execution record. The failure shape is the same minus the success fields. */
export interface SandboxRunRecord {
  runId: string
  ok: boolean
  result: unknown
  error: { name: string; message: string; stack?: string } | null
  limitsHit: string[]
  /**
   * The engine itself signalled stack exhaustion (a host `RangeError` out of a
   * WASM call, or its own `InternalError`) in the script or in a callback. The
   * runtime is then abandoned rather than disposed, and a guest that merely
   * throws "stack overflow" never sets it.
   */
  stackExhaustion?: boolean
  timedOut?: boolean
  /**
   * Host-wall backstop. True when the host clock interrupted the run, so
   * observations may be incomplete. Absent on records that failed before the
   * success path.
   */
  provisional?: boolean
  filename?: string
  durationMs: number
  virtualMs: number
  /**
   * Event-loop outcome. Absent when the run never reached the event loop (a
   * failed run record), because no settlement was attempted.
   */
  settle?: SandboxSettle | null
  facts?: StaticFacts | null
  vm?: object | null
  instrumentation?: { stats: InstrumentedCode['stats'] | null; describe: InstrumentationDescribe } | object
  environment: EnvironmentInstallResult | null
  integrity: IntegrityDiff
  hooks: {
    registered: number
    defaultHooks?: boolean
    fired?: unknown[]
    describe: HookRegisteredDescriptor[]
    errors?: HookErrorEntry[]
  }
  runtime: object | null
  clock?: ClockStats
  stealth?: object
  profile: ProfileSummary | null
  events: TraceEvent[] | null
  traceStats: TraceStats
  disposal?: SandboxDisposal
}

export interface SandboxOptions {
  seed?: number | string
  profile?: ProfileOptions
  limits?: Partial<Limits>
  logger?: Logger
  logLevel?: 'silent' | 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace'
  instrumentation?: InstrumentationConfig
  hooks?: HookDescriptor[]
  env?: { strict?: boolean; only?: string[]; exclude?: string[] }
  ioc?: { extractIOCs: Function }
  defaultHooks?: boolean
}

export interface SandboxRunOptions {
  sourceUrl?: string
  filename?: string
  type?: 'script' | 'module'
  level?: 'off' | 'function' | 'branch' | 'statement'
  entry?: string
  args?: unknown[]
  keepTrace?: boolean
  mocks?: unknown[]
  network?: object
  settle?: SandboxSettleOptions
  hooks?: HookDescriptor[]
}

export declare class TracelessSandbox {
  constructor(options?: SandboxOptions)
  options: SandboxOptions
  seed: number | string
  profile: Profile
  limits: Limits
  logger: Logger
  module: QuickJSWASMModule | null
  runSeq: number
  lastRun: SandboxRunRecord | null
  disposed: boolean
  runHistory: { runId: string; ok: boolean; at: number; events: number; limitsHit: string[] }[]

  static create(options?: SandboxOptions): Promise<TracelessSandbox>
  init(): Promise<TracelessSandbox>
  profileSummary(): ProfileSummary
  run(source: string, runOptions?: SandboxRunOptions): Promise<SandboxRunRecord>
  analyze(source: string, options?: AnalyzeSourceOptions): AnalyzeSourceResult
  dispose(): void
}

/* -------------------------------------------------------------------------- */
/* host bridge                                                                 */
/* -------------------------------------------------------------------------- */

export interface HostCallContext {
  args: QuickJSHandle[]
  thisHandle: QuickJSHandle
  bag: HandleBag
  bridge: HostBridge
}

export interface HostBridge {
  ctx: QuickJSContext
  runtime: QuickJSRuntime
  sandbox: TracelessSandbox | null
  profile: Profile | null
  clock: VirtualClock | null
  trace: TraceRecorder | null
  logger: Logger | null
  stealth: Stealth | null
  global: QuickJSHandle
  stats: { calls: number; errors: number; conversions: number }
  readonly undefined: QuickJSHandle
  readonly null: QuickJSHandle
  fn(
    name: string,
    length: number,
    impl: (call: HostCallContext) => unknown,
    opts?: { isConstructor?: boolean },
  ): QuickJSHandle
  nativeConstructor(spec: {
    name: string
    arity?: number
    bindings?: Record<string, unknown>
    body: string
  }): QuickJSHandle
  accessor(target: QuickJSHandle, key: string, descriptor: object): void
  toGuest(value: unknown): QuickJSHandle
  fromGuest(handle: QuickJSHandle, depth?: number): unknown
  str(args: QuickJSHandle[], index: number, fallback?: string): string
  num(args: QuickJSHandle[], index: number, fallback?: number): number
  bool(args: QuickJSHandle[], index: number, fallback?: boolean): boolean
  onDispose(fn: () => void): void
  disposeAll(): void
}

export interface HostBridgeOptions {
  ctx: QuickJSContext
  runtime?: QuickJSRuntime
  sandbox?: TracelessSandbox | null
  profile?: Profile | null
  clock?: VirtualClock | null
  trace?: TraceRecorder | null
  logger?: Logger | null
  stealth?: Stealth | null
}

/* -------------------------------------------------------------------------- */
/* stealth / invocation                                                        */
/* -------------------------------------------------------------------------- */

export interface StealthStats {
  masked: number
  shims: number
  markers: number
  errors: number
  [key: string]: unknown
}

export interface Stealth {
  nonce: string
  /** Register a marker token so `Function.prototype.toString` strips its span. */
  registerMarker(token: string): void
  /** Report a shim's native-looking source text. */
  registerShim(source: string, nativeText?: string): void
  install(): object
  sanitizeText(text: string): string
  sanitizeError(error: { name?: string; message?: string; stack?: string }): {
    name: string
    message: string
    stack: string
  }
  /**
   * True only when the live guest value is the engine's own stack-overflow
   * error: a prototype-identity match against the captured intrinsic
   * `InternalError.prototype`, refused while the guest can still reach that
   * constructor itself. The handle stays owned by the caller.
   */
  isIntrinsicStackError(handle: object): boolean
  stats(): StealthStats
  dispose(): void
  [key: string]: unknown
}

export interface StealthOptions {
  nonce?: string
  trace?: TraceRecorder
  logger?: Logger
  maskToString?: boolean
}

export interface InvocationResult {
  ok: boolean
  result: unknown
  /** Dumped value for a successful run (the `result` summary is lossy). */
  value?: unknown
  error: { name: string; message: string; stack?: string } | null
  limitsHit: string[]
  /**
   * Explicit engine marker for stack exhaustion (see
   * `SandboxRunRecord.stackExhaustion`). Always present on the invocation
   * record, so consumers can distinguish a real stack breach from a guest
   * error that only says "stack overflow".
   */
  stackExhaustion?: boolean
  timedOut: boolean
  filename?: string
  durationMs?: number
  virtualMs?: number
  facts?: StaticFacts | null
  vm?: object | null
  prepared?: InstrumentationPrepared | null
  [key: string]: unknown
}

export interface Invoker {
  invoke(source: string, runOptions?: SandboxRunOptions): InvocationResult
  /** Normalise the guest-visible filename for one source text. */
  filenameFor(options?: { sourceUrl?: string; filename?: string; source?: string }): string
  stats(): object
  [key: string]: unknown
}

/* -------------------------------------------------------------------------- */
/* restore                                                                     */
/* -------------------------------------------------------------------------- */

export interface ParseResult {
  ast: object
  sourceType: 'script' | 'module'
  comments: object[]
  errors: object[]
}

export interface ParseOptions {
  sourceType?: 'script' | 'module' | 'unambiguous'
  allowReturnOutsideFunction?: boolean
  errorRecovery?: boolean
  plugins?: string[]
  ranges?: boolean
  filename?: string
}

export interface GenerateResult {
  code: string
  map: object | null
  rawMappings?: unknown
}

export interface PassMeta {
  id: string
  order: number
  description: string
  idempotent?: boolean
  deferred?: boolean
}

export interface RestorePass {
  meta: PassMeta
  run(ast: object, context: PassContext): { changed?: boolean; notes?: string[]; changes?: object[] } | void
}

export interface PassContext {
  types: typeof import('@babel/types')
  traverse: unknown
  template: unknown
  logger: Logger | null
  options: Record<string, unknown>
  report(change: object): void
  note(message: string): void
  replace(path: { replaceWith(node: object): void; skip?: () => void }, node: object): void
  notes: string[]
  changes: object[]
}

export interface PassRunReport {
  id: string
  changed: boolean
  notes: string[]
  changes: object[]
  durationMs: number
  error?: { message: string; stack?: string }
  /** True when the pass threw and strict mode did not rethrow. */
  failed?: boolean
}

export interface RestorePassReport {
  id: string
  changed: boolean
  notes: string[]
  durationMs: number
  rounds: number[]
  error: { message: string; stack?: string } | null
}

export interface RestoreStats {
  durationMs: number
  inputBytes: number
  outputBytes: number
  passCount: number
  changedPasses: number
  beforeHash: string
  afterHash: string
  fingerprint: string
}

export interface RestoreResult {
  code: string
  map: object | null
  sourceType: 'script' | 'module'
  parseErrors: object[]
  passes: RestorePassReport[]
  rounds: number
  changed: boolean
  /** False when the generated text failed the re-parse gate; the input is returned instead. */
  outputValid: boolean
  outputError: { message: string } | null
  notes: string[]
  stats: RestoreStats
  selection: string[]
}

export interface RestoreOptions {
  filename?: string
  sourceType?: 'script' | 'module' | 'unambiguous'
  logger?: Logger
  maxRounds?: number
  passOptions?: Record<string, unknown>
  generateOptions?: object
  strict?: boolean
  stopOnNoChange?: boolean
  hooks?: HookBus | null
  only?: string[]
  exclude?: string[]
  ids?: string[]
}

export interface PassListing {
  id: string
  order: number
  description: string
  idempotent: boolean
  deferred: boolean
}

/* -------------------------------------------------------------------------- */
/* analysis                                                                    */
/* -------------------------------------------------------------------------- */

export interface IocEntry {
  value: string
  source?: string
  count?: number
  sources?: string[]
  [key: string]: unknown
}

export interface IOCResult {
  urls?: IocEntry[]
  domains?: IocEntry[]
  ips?: IocEntry[]
  emails?: IocEntry[]
  hashes?: IocEntry[]
  wallets?: IocEntry[]
  mutexes?: IocEntry[]
  telegram?: IocEntry[]
  encoded?: IocEntry[]
  meta?: Record<string, unknown>
  [key: string]: unknown
}

export interface IocOptions {
  maxCandidates?: number
  /** Per-category match budget. Defaults to 800. */
  maxPerCategory?: number
  maxLength?: number
  decodeBase64?: boolean
  benignHosts?: string[]
}

export type ProvenanceRefKind = 'event' | 'ioc' | 'artifact' | 'stage' | 'killChain'

export interface ProvenanceRef {
  kind: ProvenanceRefKind
  id: string
  value?: string
  count?: number
  seq?: number
  offset?: number
  source?: string
}

export interface VerdictReason {
  code: string
  weight: number
  detail: string
  /** Evidence refs; every scored reason has at least one. */
  refs: ProvenanceRef[]
}

export interface ProvenanceEntry {
  reasonCode: string
  weight: number
  refs: ProvenanceRef[]
}

export interface Verdict {
  score: number
  level: 'benign' | 'suspicious' | 'malicious'
  confidence: number
  families: string[]
  reasons: VerdictReason[]
  /** Present on `scoreVerdict()` return; mirrored to report.provenance by buildReport. */
  provenance?: ProvenanceEntry[]
}

export interface AnalysisReport {
  meta: {
    tool: string
    version: string
    runId: string
    startedAt: string
    durationMs: number
    seed: number | string | null
    profile: ProfileSummary | object | null
    limits: object
  }
  sample: object
  verdict: Verdict
  /** Per-reason evidence chain (Wave 3 report-internal provenance). */
  provenance: ProvenanceEntry[]
  static: object
  /**
   * Normalised dynamic section. `provisional` mirrors the sandbox run;
   * `eventsTruncated` is set when the retained slice drops events or the run
   * is provisional. Other runtime fields stay on the index signature.
   */
  dynamic: {
    provisional?: boolean
    eventsTruncated?: boolean
    [key: string]: unknown
  }
  tracing: object
  hooks: object
  artifacts: object[]
  recommendations: object[]
  integrity: { intact: boolean; drift: object[] }
  [key: string]: unknown
}

export interface ArtifactInput {
  kind: string
  data: string | Uint8Array
  source?: string
  meta?: object
}

export interface ArtifactRecord {
  id: string
  kind: string
  sha256: string
  size: number
  source: string
  count: number
  preview: string
  text: string
  meta: object
}

export interface ArtifactStore {
  add(input: ArtifactInput): ArtifactRecord | null
  addAll(artifacts: ArtifactInput[]): ArtifactRecord[]
  list(): ArtifactRecord[]
  summary(): Omit<ArtifactRecord, 'text'>[]
  stats(): { count: number; bytes: number }
}

export interface AnalyzeSampleOptions extends SandboxOptions {
  name?: string
  sourceUrl?: string
  dynamic?: boolean
  restore?: boolean
  runRestored?: boolean
  sandbox?: TracelessSandbox
  entry?: string
  args?: unknown[]
  maxRounds?: number
  maxIocBytes?: number
  maxRetainedEvents?: number
  keepTrace?: boolean
  mocks?: unknown[]
  network?: object
  settle?: SandboxSettleOptions
  strictEnv?: boolean
  jsvmpAnalysis?: boolean
  constraints?: boolean | ConstraintAnalysisOptions
  generateOptions?: object
  restoreHooks?: HookBus | null
  filename?: string
  type?: 'script' | 'module'
  level?: 'off' | 'function' | 'branch' | 'statement'
  [key: string]: unknown
}

export interface AnalyzeSampleResult {
  report: AnalysisReport
  markdown: string
  run: SandboxRunRecord | null
  restoredRun: object | null
  restoration: RestoreResult | { code: string; passes: object[]; changed: boolean; error: { message: string }; stats: null } | null
  artifacts: object[]
  artifactStore: ArtifactStore
  behavior: object
  facts: StaticFacts | null
  iocs: IOCResult
  jsvmp: object | null
  vmAnalysis: object | null
  /** z3 constraint analysis; `null` only when the component was disabled. */
  constraint: ConstraintReport | null
}

/* -------------------------------------------------------------------------- */
/* constraint solving (z3)                                                     */
/* -------------------------------------------------------------------------- */

export interface ConstraintLimits {
  maxPredicates: number
  maxBranches: number
  maxPathConditions: number
  maxDepth: number
  maxNodes: number
  solverRlimit: number
  timeoutMs: number
  budgetMs: number
  maxTextLength: number
  maxFindings: number
  maxVariables: number
}

export interface ConstraintAnalysisOptions {
  filename?: string
  sourceType?: 'script' | 'module' | 'unambiguous'
  /** Allow proofs under the integer model (fraction/NaN/Infinity excluded). */
  assumeIntegers?: boolean
  /** Tie the Int and BitVec interpretations to signed 32-bit values. */
  assumeInt32?: boolean
  limits?: Partial<ConstraintLimits>
  maxPredicates?: number
  timeoutMs?: number
  solverRlimit?: number
  budgetMs?: number
  [key: string]: unknown
}

export interface ConstraintStats {
  candidates: number
  predicates: number
  proven: number
  opaque: number
  undecided: number
  unsupported: number
  inexact: number
  branches: number
  unreachable: number
  unsupportedBranches: number
  undecidedBranches: number
  simplifications: number
  solverCalls: number
}

export interface ConstraintFinding {
  kind: string
  role: string
  line: number | null
  column: number | null
  text: string
  variables: string[]
  exact: boolean
  pure: boolean
  assumptions: string[]
  proof: string
}

export interface ConstraintUnreachableBranch {
  kind: string
  line: number | null
  column: number | null
  text: string
  path: string[]
  variables: string[]
  exact: boolean
  pure: boolean
  assumptions: string[]
  proof: string
}

export interface ConstraintSimplification {
  role: string
  line: number | null
  column: number | null
  text: string
  simplified: string
  variables: string[]
  exact: boolean
  pure: boolean
  assumptions: string[]
  verification: string
}

export interface ConstraintReport {
  enabled: boolean
  ok: boolean
  engine: string
  engineVersion?: string | null
  parse: { ok: boolean; sourceType: string; errors: { message: string }[] }
  stats: ConstraintStats
  opaquePredicates: ConstraintFinding[]
  unreachableBranches: ConstraintUnreachableBranch[]
  simplifications: ConstraintSimplification[]
  assumptions: string[]
  limits: Partial<ConstraintLimits>
  truncated: boolean
  notes: string[]
  error: { message: string } | null
  elapsedMs: number
}

export interface ConstraintSolveOptions extends ConstraintAnalysisOptions {
  timeoutMs?: number
  assumeIntegers?: boolean
  assumeInt32?: boolean
  /** Babel scope for a single condition's binding identity. */
  scope?: object | null
  leftScope?: object | null
  rightScope?: object | null
}

export interface ConstraintSolveResult {
  ok: boolean
  status: 'sat' | 'unsat' | 'unknown' | 'error'
  satisfiable: boolean
  /** True when the solver model is a coherent JS-value assignment. */
  modelSafe?: boolean
  model: Record<string, number | string> | null
  modelBitVec?: Record<string, number | string> | null
  variables: string[]
  expressions: string[]
  assumptions: string[]
  elapsedMs: number
  reason: string | null
  error: { message: string; code?: string | null } | null
  [key: string]: unknown
}

export interface ConstraintProofResult {
  ok: boolean
  status: 'always-true' | 'always-false' | 'contingent' | 'unknown' | 'unsupported' | 'error'
  alwaysTrue: boolean
  alwaysFalse: boolean
  proved: boolean
  /** True when model/counterexample values are coherent witness assignments. */
  modelSafe?: boolean
  model: Record<string, number | string> | null
  counterexample: Record<string, number | string> | null
  variables: string[]
  expression: string
  exact: boolean
  assumptions: string[]
  elapsedMs: number
  reason: string | null
  error: { message: string; code?: string | null } | null
  [key: string]: unknown
}

export interface ConstraintEquivalenceResult {
  ok: boolean
  equivalent: boolean
  /** True only when the terms are exact; a model equivalence is not a JS proof. */
  proved: boolean
  status: 'equivalent' | 'different' | 'unknown' | 'unsupported' | 'error'
  left: string
  right: string
  modelSafe?: boolean
  counterexample: Record<string, number | string> | null
  exact: boolean
  assumptions: string[]
  variables: string[]
  elapsedMs: number
  reason: string | null
  error: { message: string; code?: string | null } | null
  [key: string]: unknown
}

export interface ConstraintSimplificationResult {
  ok: boolean
  status: string
  original: string
  simplified: string
  changed: boolean
  equivalent: boolean
  proved: boolean
  sort: string | null
  exact: boolean
  assumptions: string[]
  variables: string[]
  verification: string
  elapsedMs: number
  reason: string | null
  error: { message: string; code?: string | null } | null
  [key: string]: unknown
}

export declare const CONSTRAINT_LIMITS: Readonly<ConstraintLimits>

/**
 * Static, z3-backed constraint analysis. Never executes the sample.
 * Unsupported constructs and solver timeouts are counted outcomes, not errors.
 */
export declare function analyzeConstraints(source: string, options?: ConstraintAnalysisOptions): Promise<ConstraintReport>

/** Solve a conjunction of JS conditions and return one model when satisfiable. */
export declare function solveConstraints(
  constraints: string | object | Array<string | object>,
  options?: ConstraintSolveOptions,
): Promise<ConstraintSolveResult>

/** Prove whether a condition is true/false for every value in the modeled domain. */
export declare function provePredicate(condition: string | object, options?: ConstraintSolveOptions): Promise<ConstraintProofResult>

/** Prove `left === right` in the modeled domain. */
export declare function proveEquivalent(
  left: string | object,
  right: string | object,
  options?: ConstraintSolveOptions,
): Promise<ConstraintEquivalenceResult>

/** z3 normal form plus an equivalence check; the result is SMT-LIB text. */
export declare function simplifyExpression(
  expression: string | object,
  options?: ConstraintSolveOptions,
): Promise<ConstraintSimplificationResult>

/** Human-readable rendering of a constraint analysis report. */
export declare function renderConstraintReport(report: ConstraintReport | object): string

/* -------------------------------------------------------------------------- */
/* JSVMP                                                                       */
/* -------------------------------------------------------------------------- */

export interface OpcodeSpec {
  code: number
  name: string
  argc: number
  stack: { in: number | string; out: number }
  doc: string
}

export interface BuildVMOptions {
  seed?: number | string
  name?: string
  obfuscate?: boolean
}

export interface VMArtifact {
  code: string
  dispatchTable: Record<string, Omit<OpcodeSpec, 'doc'> & { caseLine: number; count: number }>
  opcodes: Omit<OpcodeSpec, 'doc'>[]
  sourceMap: { pc: number; code: number; name: string; line: number }[]
  bytecode: AssembledProgram['bytecode']
  /** Host execution requires explicit trust; use code in TracelessSandbox otherwise. */
  run(options: { trust: 'host'; args?: unknown[] }): unknown
}

export interface AssembledProgram {
  bytecode: { code: number; args: unknown[] }[]
  consts: unknown[]
}

/* -------------------------------------------------------------------------- */
/* logging                                                                     */
/* -------------------------------------------------------------------------- */

export interface LoggerOptions {
  level?: string
  pretty?: boolean
  destination?: NodeJS.WritableStream
  name?: string
  base?: object
  redact?: boolean
}

/** In-memory pino destination used by tests and by `--json` runs. */
export interface MemoryDestination {
  write(chunk: unknown): boolean
  lines: string[]
  records(): Record<string, any>[]
  clear(): void
  end(): void
}

/** Trace consumer that forwards every event to a logger. */
export interface EventSink {
  write(event: object): void
  writeAll(events: readonly object[]): void
  flush(): void
  counts(): Record<string, number>
  buffer: object[]
}

/* -------------------------------------------------------------------------- */
/* utility                                                                     */
/* -------------------------------------------------------------------------- */

export interface SeededRandom {
  next(): number
  int(min: number, max: number): number
  pick<T>(items: T[]): T
  bool(probability?: number): boolean
  [key: string]: unknown
}

/** Disposal bag for QuickJS handles; declared structurally so the declarations
 * do not depend on the class identity of `ai4reverse-web/util#HandleBag`. */
export interface HandleBag {
  readonly size: number
  add<H>(handle: H): H
  keep<H>(handle: H): H
  dispose(): void
}

/* -------------------------------------------------------------------------- */
/* constants                                                                   */
/* -------------------------------------------------------------------------- */

export declare const DEFAULT_LIMITS: Limits

export declare const ENV_MODULE_IDS: readonly string[]

export declare const TRACE_KINDS: readonly (
  | 'sandbox'
  | 'code'
  | 'api'
  | 'exception'
  | 'ast'
  | 'jsvmp'
  | 'dom'
  | 'net'
  | 'storage'
  | 'timer'
  | 'eval'
  | 'hook'
  | 'ioc'
  | 'restore'
)[]

export declare const HOOK_PHASES: readonly string[]

export declare const PASSES: readonly RestorePass[]

export declare const OPCODES: readonly OpcodeSpec[]

export declare const OPCODE_BY_NAME: ReadonlyMap<string, OpcodeSpec>

export declare const OPCODE_BY_CODE: ReadonlyMap<number, OpcodeSpec>

export declare const SEMANTICS: Readonly<Record<string, string>>

/* -------------------------------------------------------------------------- */
/* functions                                                                   */
/* -------------------------------------------------------------------------- */

/* sandbox ------------------------------------------------------------------ */

export declare function createProfile(options?: ProfileOptions): Profile

export declare function consistencyReport(profile: Profile): ConsistencyReport

export declare function createHostBridge(options: HostBridgeOptions): HostBridge

export declare function isHandle(value: unknown): value is QuickJSHandle

export declare function createVirtualClock(options?: {
  epoch?: number
  seed?: number | string
  logger?: Logger
  maxTimers?: number
}): VirtualClock

export declare function normalizeLimits(input?: Partial<Limits>): Limits

export declare function captureIntegrity(ctx: QuickJSContext, options?: { stealth?: Stealth; trace?: TraceRecorder }): IntegritySnapshot

export declare function diffIntegrity(before: IntegritySnapshot, after: IntegritySnapshot): IntegrityDiff

export declare function installEnvironment(
  bridge: HostBridge,
  options?: { strict?: boolean; only?: string[]; exclude?: string[]; logger?: Logger },
): Promise<EnvironmentInstallResult>

export declare function loadEnvModule(id: string): Promise<EnvModule>

/* invocation --------------------------------------------------------------- */

export declare function createStealth(ctx: QuickJSContext, options?: StealthOptions): Stealth

export declare function createInvoker(options: {
  ctx: QuickJSContext
  runtime: QuickJSRuntime
  limitReason?: () => string | null | undefined
  bridge: HostBridge
  stealth?: Stealth | null
  profile: Profile
  clock: VirtualClock
  trace?: TraceRecorder | null
  logger?: Logger | null
  limits: Limits
  hooks?: HookBus | null
  instrumentation?: Instrumentation | null
}): Invoker

/* instrumentation ---------------------------------------------------------- */

export declare function createTraceRecorder(options?: TraceRecorderOptions): TraceRecorder

export declare function createHookBus(options?: HookBusOptions): HookBus

export declare function createDefaultHooks(options?: {
  trace?: TraceRecorder
  ioc?: { extractIOCs: Function }
  onUncaught?: Function
  onCaught?: Function
  mocks?: unknown[]
  suppressDialogs?: boolean
  blockPopups?: boolean
}): { registrations: HookDescriptor[]; api: object | null; ast: object }

export declare function registerHooks(bus: HookBus, registrations?: HookDescriptor[]): string[]

export declare function createInstrumentation(options: {
  ctx: QuickJSContext
  bridge: HostBridge
  stealth?: Stealth | null
  trace?: TraceRecorder | null
  hooks?: HookBus | null
  profile?: Profile | null
  clock?: VirtualClock | null
  logger?: Logger | null
  config?: InstrumentationConfig
  environment?: EnvironmentInstallResult | null
}): Instrumentation

export declare function createCodeInstrumenter(options: {
  ctx: QuickJSContext
  bridge: HostBridge
  stealth?: Stealth | null
  trace?: TraceRecorder | null
  hooks?: HookBus | null
  level?: string
  marker?: string
  maxEvents?: number
  maxInsertions?: number
  logger?: Logger | null
  exception?: ExceptionInstrumenter | null
}): CodeInstrumenter

export declare function createApiInstrumenter(options: {
  ctx: QuickJSContext
  bridge: HostBridge
  trace?: TraceRecorder | null
  hooks?: HookBus | null
  logger?: Logger | null
}): ApiInstrumenter

export declare function createExceptionInstrumenter(options: {
  bridge: HostBridge
  stealth?: Stealth | null
  trace?: TraceRecorder | null
  hooks?: HookBus | null
  logger?: Logger | null
  maxErrors?: number
}): ExceptionInstrumenter

export declare function analyzeSource(source: string, options?: AnalyzeSourceOptions): AnalyzeSourceResult

export declare function scoreObfuscation(facts: StaticFacts): ObfuscationScore

export declare function detectTechniques(facts: StaticFacts): string[]

export declare function walkAst(ast: object, visitor?: { enter?: Function; exit?: Function }): void

export declare function detectDispatch(ast: object): {
  found: boolean
  kind?: string
  score?: number
  dispatch?: object
}

export declare function instrumentDispatch(
  source: string,
  options: {
    dispatch: object
    channelExpression: string
    bindingName?: string
    marker?: string
    interpreter?: string | null
  },
): { code: string; plan: Map<number, unknown>; stats: { opcodesInstrumented: number; skipped?: string } }

export declare function locateInterpreter(source: string, dispatch: object): string | null

export declare function summarizeOpcodeTrace(
  events: readonly unknown[],
  options?: { semantics?: Record<string, string>; limit?: number },
): object

/* restore ------------------------------------------------------------------ */

export declare function restore(code: string, options?: RestoreOptions): RestoreResult

export declare function restoreWithPass(id: string, code: string, options?: RestoreOptions): RestoreResult

export declare function parse(code: string, options?: ParseOptions): ParseResult

export declare function generate(ast: object, code?: string, options?: object): GenerateResult

export declare function listPasses(): PassListing[]

export declare function selectPasses(options?: { only?: string[]; exclude?: string[]; ids?: string[] }): RestorePass[]

/* analysis ----------------------------------------------------------------- */

export declare function analyzeSample(source: string, options?: AnalyzeSampleOptions): Promise<AnalyzeSampleResult>

export declare function extractIOCs(text: string, options?: IocOptions): IOCResult

export declare function extractFromEvents(events: readonly object[], options?: IocOptions): IOCResult

export declare function buildReport(analysis: object): AnalysisReport

export declare function renderMarkdown(report: object): string

export declare function scoreVerdict(input?: object): Verdict

export declare function summarizeBehavior(events?: readonly object[]): object

export declare function createArtifactStore(options?: {
  maxBytes?: number
  maxArtifacts?: number
  logger?: Logger
}): ArtifactStore

export declare function extractStagedPayloads(
  events?: readonly object[],
  sourceText?: string,
  options?: object,
): ArtifactStore

/* jsvmp -------------------------------------------------------------------- */

export declare function assemble(program: { op: string; args?: unknown[] }[]): AssembledProgram

/**
 * Build a self-contained JSVMP interpreter artifact. The artifact's
 * `run(options)` convenience runner executes the generated source in the host
 * process and requires the explicit `{ trust: 'host' }` acknowledgement.
 */
export declare function buildVM(
  program: { op: string; args?: unknown[] }[],
  options?: BuildVMOptions,
): VMArtifact

export declare function buildSampleProgram(): { op: string; args?: unknown[] }[]

export declare function analyzeVM(source: string, options?: object): {
  detected: boolean
  kind?: string
  score?: number
  dispatch?: { cases: unknown[]; [key: string]: unknown }
  handlerMap?: Map<number, string>
  [key: string]: unknown
}

export declare function extractHandlers(source: string, options?: object): unknown[]

export declare function isJSVMP(source: string, options?: object): boolean

export declare function summarizeVM(analysis: object): object

/* logging ------------------------------------------------------------------ */

export declare function createLogger(options?: LoggerOptions): Logger

export declare function createEventSink(options: {
  logger: Logger
  level?: string
  maxEvents?: number
}): EventSink

export declare function createMemoryDestination(): MemoryDestination

export declare const redactPaths: readonly string[]

export declare function scopeLogger(logger: Logger, scope: { runId: string; sample?: string }): Logger

/* entry point -------------------------------------------------------------- */

export declare function analyze(source: string, options?: AnalyzeSampleOptions): Promise<AnalyzeSampleResult>

export declare function run(source: string, options?: SandboxOptions & SandboxRunOptions): Promise<SandboxRunRecord>

export declare function restoreCode(code: string, options?: RestoreOptions): RestoreResult
