/**
 * Declarations for the `ai4reverse-web/sandbox` subpath.
 *
 * The barrel re-exports the sandbox layer: the run engine, the seeded profile
 * kit, limit handling, integrity snapshots and the environment module loader.
 */

export {
  TracelessSandbox,
  createProfile,
  consistencyReport,
  createHostBridge,
  isHandle,
  createVirtualClock,
  normalizeLimits,
  DEFAULT_LIMITS,
  captureIntegrity,
  diffIntegrity,
  installEnvironment,
  ENV_MODULE_IDS,
  loadEnvModule,
} from './ai4reverse.js'

export type {
  Profile,
  ProfileOptions,
  ConsistencyReport,
  Limits,
  LimitKind,
  VirtualClock,
  ClockStats,
  ScreenShape,
  WindowShape,
  HostBridge,
  HostBridgeOptions,
  HostCallContext,
  SandboxOptions,
  SandboxRunOptions,
  SandboxRunRecord,
  SandboxDisposal,
  SandboxDisposalError,
  SandboxSettle,
  SandboxSettleDrained,
  SandboxSettleError,
  SandboxSettleSkipped,
  SandboxSettleOptions,
  TimerCallbackError,
  TimerBatchResult,
  InvocationResult,
  IntegritySnapshot,
  IntegrityDiff,
  ProfileSummary,
  EnvModule,
  EnvModuleMeta,
  EnvironmentInstallResult,
  TraceEvent,
  TraceRecorder,
  TraceStats,
  HookDescriptor,
  HookBus,
  Logger,
  QuickJSContext,
  QuickJSHandle,
  QuickJSRuntime,
} from './ai4reverse.js'

/** One locale preset: language tags, timezone and CLDR-ish formatting anchors. */
export interface LocalePreset {
  language: string
  languages: string[]
  timezone: string
  tzOffsetMinutes: number
  currency: string
  numberingSystem: string
  dateFormat: string
}

/** One operating-system preset. */
export interface OsFamily {
  names: string[]
  platform: string
  architecture: string
  bitness: string
  platformVersion: string
  fonts: string[]
  gpus: { vendor: string; renderer: string }[]
  userAgentToken: string
  oscpu: string
}

/** One screen preset. */
export interface DevicePreset {
  width: number
  height: number
  dpr: number
  touch: number
}

/** One browser preset. `brands` derives the `userAgentData` brand list. */
export interface BrowserPreset {
  name: string
  vendor: string
  engine: string
  versions: string[]
  productSub: string
  brands(major: number): { brand: string; version: string }[]
}

export declare const LOCALES: Readonly<Record<string, LocalePreset>>

export declare const OS_FAMILIES: Readonly<Record<string, OsFamily>>

export declare const DEVICES: readonly DevicePreset[]

export declare const BROWSERS: Readonly<Record<string, BrowserPreset>>

/** Human-readable description of a limit breach. */
export declare function limitMessage(kind: LimitKind, limits: Limits): string

/** Strip host-only detail from a message that is about to reach the guest. */
export declare function sanitizeHostMessage(message: unknown): string
