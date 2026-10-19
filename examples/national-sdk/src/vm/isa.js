/**
 * Canonical NSL VM instruction set.
 *
 * A handler id is an index into this array and is stable across builds: the
 * build-time opcode permutation and the per-invocation remapping are what vary,
 * not the semantics. Keeping the canonical order in one place is what lets the
 * compiler, interpreter, disassembler and tests agree without a lookup table
 * that can drift.
 */
export const ISA = Object.freeze([
  'CONST',
  'LOAD_ARG',
  'LOAD_LOCAL',
  'STORE_LOCAL',
  'UNDEF',
  'NULL',
  'TRUE',
  'FALSE',
  'POP',
  'DUP',
  'SWAP',
  'ADD',
  'SUB',
  'MUL',
  'DIV',
  'MOD',
  'BIT_AND',
  'BIT_OR',
  'BIT_XOR',
  'SHL',
  'SHR',
  'USHR',
  'NEG',
  'NOT',
  'BNOT',
  'EQ',
  'NEQ',
  'SEQ',
  'SNEQ',
  'LT',
  'GT',
  'LTE',
  'GTE',
  'TYPEOF',
  'JMP',
  'JZ',
  'JNZ',
  'GET_PROP',
  'GET_INDEX',
  'SET_PROP',
  'SET_INDEX',
  'NEW_ARRAY',
  'NEW_OBJECT',
  'CALL',
  'CALL_METHOD',
  'RETURN',
  'HALT',
  'TO_STR',
  'TO_NUM',
])

/** mnemonic -> handler id */
export const OPCODE_ID = new Map(ISA.map((name, index) => [name, index]))

/** handler id -> mnemonic */
export const ID_OPCODE = ISA
