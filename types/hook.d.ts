/**
 * Declarations for the `ai4reverse-web/hook` subpath.
 *
 * The hook bus plus the default hook factories (`code`, `api`, `exception`,
 * `ast`). A hook is a `phase` + handler pair; the bus owns dispatch order,
 * error isolation and trace recording.
 */

export {
  createHookBus,
  HOOK_PHASES,
  createDefaultHooks,
  registerHooks,
} from './ai4reverse.js'

export type {
  HookBus,
  HookBusOptions,
  HookDispatchResult,
  HookDescriptor,
  HookRegistration,
  HookRegisteredDescriptor,
  HookStats,
  HookErrorEntry,
  TraceRecorder,
  Logger,
} from './ai4reverse.js'

/** One static suspicious-pattern probe used by the default code hooks. */
export interface SuspiciousPattern {
  id: string
  pattern: RegExp
  detail: string
}

export declare const SUSPICIOUS_PATTERNS: readonly SuspiciousPattern[]

/** Options accepted by every default hook factory. */
export interface HookFactoryOptions {
  trace?: import('./ai4reverse.js').TraceRecorder
  logger?: import('./ai4reverse.js').Logger
  [key: string]: unknown
}

export declare function createCodeHooks(options?: HookFactoryOptions): HookDescriptorList

export interface ApiHooks {
  hooks: import('./ai4reverse.js').HookDescriptor[]
  fired: unknown[]
  stats(): { fired: number; registered: number }
}

export declare function createApiHooks(options?: HookFactoryOptions): ApiHooks

export declare function createExceptionHooks(options?: HookFactoryOptions): HookDescriptorList

export declare function createAstHooks(options?: HookFactoryOptions): HookDescriptorList

type HookDescriptorList = import('./ai4reverse.js').HookDescriptor[]
