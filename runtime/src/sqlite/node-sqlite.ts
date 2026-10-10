// `node:sqlite` as Node 24 exposes it, over the Wasm engine.
//
// Behaviour (argument checks, error codes and messages, value conversions) is
// matched against native Node 24 by harness/compare.mjs, which runs one script
// against both and diffs the output.
import type { FsBackend } from './backend'
import { createEngine, type Engine, type WasmSource } from './engine'

const SQLITE_OK = 0
const SQLITE_ROW = 100
const SQLITE_DONE = 101
const OPEN_READONLY = 0x1
const OPEN_READWRITE = 0x2
const OPEN_CREATE = 0x4
const OPEN_URI = 0x40
const DBCONFIG_ENABLE_FKEY = 1002
const DBCONFIG_DEFENSIVE = 1010
const DBCONFIG_DQS_DML = 1013
const DBCONFIG_DQS_DDL = 1014
const SQLITE_UTF8 = 1
const SQLITE_DETERMINISTIC = 0x800
const SQLITE_DIRECTONLY = 0x80000
const DESERIALIZE_FREEONCLOSE = 1
const DESERIALIZE_RESIZEABLE = 2

const MAX_I64 = 2n ** 63n - 1n
const MIN_I64 = -(2n ** 63n)

const constants = Object.freeze({
  SQLITE_CHANGESET_OMIT: 0, SQLITE_CHANGESET_REPLACE: 1, SQLITE_CHANGESET_ABORT: 2,
  SQLITE_CHANGESET_DATA: 1, SQLITE_CHANGESET_NOTFOUND: 2, SQLITE_CHANGESET_CONFLICT: 3,
  SQLITE_CHANGESET_CONSTRAINT: 4, SQLITE_CHANGESET_FOREIGN_KEY: 5,
  SQLITE_OK: 0, SQLITE_DENY: 1, SQLITE_IGNORE: 2,
  SQLITE_CREATE_INDEX: 1, SQLITE_CREATE_TABLE: 2, SQLITE_CREATE_TEMP_INDEX: 3, SQLITE_CREATE_TEMP_TABLE: 4,
  SQLITE_CREATE_TEMP_TRIGGER: 5, SQLITE_CREATE_TEMP_VIEW: 6, SQLITE_CREATE_TRIGGER: 7, SQLITE_CREATE_VIEW: 8,
  SQLITE_DELETE: 9, SQLITE_DROP_INDEX: 10, SQLITE_DROP_TABLE: 11, SQLITE_DROP_TEMP_INDEX: 12,
  SQLITE_DROP_TEMP_TABLE: 13, SQLITE_DROP_TEMP_TRIGGER: 14, SQLITE_DROP_TEMP_VIEW: 15, SQLITE_DROP_TRIGGER: 16,
  SQLITE_DROP_VIEW: 17, SQLITE_INSERT: 18, SQLITE_PRAGMA: 19, SQLITE_READ: 20, SQLITE_SELECT: 21,
  SQLITE_TRANSACTION: 22, SQLITE_UPDATE: 23, SQLITE_ATTACH: 24, SQLITE_DETACH: 25, SQLITE_ALTER_TABLE: 26,
  SQLITE_REINDEX: 27, SQLITE_ANALYZE: 28, SQLITE_CREATE_VTABLE: 29, SQLITE_DROP_VTABLE: 30, SQLITE_FUNCTION: 31,
  SQLITE_SAVEPOINT: 32, SQLITE_COPY: 0, SQLITE_RECURSIVE: 33,
})

type Ctor = new (message: string) => Error
function err(Base: Ctor, code: string, message: string): Error {
  const e = new Base(message) as Error & { code: string }
  e.code = code
  return e
}
const invalidType = (message: string) => err(TypeError, 'ERR_INVALID_ARG_TYPE', message)
const invalidState = (message: string) => err(Error, 'ERR_INVALID_STATE', message)
const unavailable = (what: string) => err(Error, 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM', `${what} is not supported in this runtime`)

export interface SqliteModuleOptions {
  /**
   * The engine: a compiled `WebAssembly.Module` (compile once, post it to every
   * process worker), the bytes of sqlite3.wasm, or a function returning either.
   * It is not touched until the first database is opened.
   */
  wasm: WasmSource
}

export interface SqliteCounters {
  open: number
  close: number
  exec: number
  prepare: number
  all: number
  get: number
  run: number
  iterate: number
  /** ms inside this module for the calls above. */
  ms: number
}

/** State of one open connection, shared with its statements. */
interface Conn {
  db: number
  /** Live statement handles; emptied (and finalized) on close. */
  stmts: Set<number>
  functionIds: number[]
  authorizerId: number
  ignoreNextError: boolean
}

interface StatementState {
  conn: Conn
  stmt: number
  readBigInts: boolean
  returnArrays: boolean
  bareNamed: boolean
  unknownNamed: boolean
  /** bare name -> full parameter name, built on first use. */
  bare?: Map<string, string>
}

export function createSqliteModule(backend: FsBackend, options: SqliteModuleOptions) {
  const holder = createEngine(backend, options.wasm)
  const counters: SqliteCounters = { open: 0, close: 0, exec: 0, prepare: 0, all: 0, get: 0, run: 0, iterate: 0, ms: 0 }
  let timing = false
  let E!: Engine
  let x!: Engine['x']
  const engine = (): Engine => {
    if (!E) {
      E = holder.get()
      x = E.x
    }
    return E
  }

  const sqliteError = (conn: Conn): Error => {
    const pending = E.takePending()
    if (pending) return pending.error as Error
    const errcode: number = x.sqlite3_extended_errcode(conn.db)
    const e = err(Error, 'ERR_SQLITE_ERROR', E.cstr(x.sqlite3_errmsg(conn.db))) as Error & { errcode: number; errstr: string }
    e.errcode = errcode
    e.errstr = E.cstr(x.sqlite3_errstr(errcode))
    return e
  }
  const check = (conn: Conn, rc: number) => {
    if (rc !== SQLITE_OK) throw sqliteError(conn)
  }

  // Statements dropped without the database being closed are finalized when collected.
  const registry = new FinalizationRegistry<{ conn: Conn; stmt: number }>(({ conn, stmt }) => {
    if (conn.stmts.delete(stmt)) x.sqlite3_finalize(stmt)
  })

  // ---- values ----

  const bindValue = (st: StatementState, index: number, value: unknown): void => {
    const stmt = st.stmt
    let rc: number
    if (typeof value === 'number') rc = x.sqlite3_bind_double(stmt, index, value)
    else if (typeof value === 'string') {
      const p = E.allocString(value)
      rc = x.bat_bind_text(stmt, index, p, E.lastLen)
    } else if (value === null) rc = x.sqlite3_bind_null(stmt, index)
    else if (ArrayBuffer.isView(value)) {
      const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
      rc = bytes.length === 0 ? x.sqlite3_bind_zeroblob(stmt, index, 0) : x.bat_bind_blob(stmt, index, E.allocBytes(bytes), bytes.length)
    } else if (typeof value === 'bigint') {
      if (value > MAX_I64 || value < MIN_I64) throw err(TypeError, 'ERR_INVALID_ARG_VALUE', 'BigInt value is too large to bind.')
      rc = x.sqlite3_bind_int64(stmt, index, value)
    } else throw invalidType(`Provided value cannot be bound to SQLite parameter ${index}.`)
    check(st.conn, rc)
  }

  const bareNames = (st: StatementState): Map<string, string> => {
    if (st.bare) return st.bare
    const map = new Map<string, string>()
    const n: number = x.sqlite3_bind_parameter_count(st.stmt)
    for (let i = 1; i <= n; i++) {
      const p: number = x.sqlite3_bind_parameter_name(st.stmt, i)
      if (!p) continue
      const full = E.cstr(p)
      const bare = full.slice(1)
      const seen = map.get(bare)
      if (seen !== undefined && seen !== full) {
        throw invalidState(`Cannot create bare named parameter '${bare}' because of conflicting names '${seen}' and '${full}'.`)
      }
      map.set(bare, full)
    }
    return (st.bare = map)
  }

  const bindParams = (st: StatementState, args: IArguments | unknown[]): void => {
    const stmt = st.stmt
    check(st.conn, x.sqlite3_clear_bindings(stmt))
    const n = args.length
    if (n === 0) return
    let first = 0
    const named = args[0]
    if (named !== null && typeof named === 'object' && !ArrayBuffer.isView(named)) {
      first = 1
      for (const key of Object.keys(named as object)) {
        const z = E.allocString(key)
        let index: number = x.sqlite3_bind_parameter_index(stmt, z)
        x.free(z)
        if (index === 0 && st.bareNamed) {
          const full = bareNames(st).get(key)
          if (full !== undefined) {
            const zf = E.allocString(full)
            index = x.sqlite3_bind_parameter_index(stmt, zf)
            x.free(zf)
          }
        }
        if (index === 0) {
          if (st.unknownNamed) continue
          throw invalidState(`Unknown named parameter '${key}'`)
        }
        bindValue(st, index, (named as Record<string, unknown>)[key])
      }
    }
    let index = 1
    for (let i = first; i < n; i++) {
      // Anonymous values fill the positions that have no name.
      while (x.sqlite3_bind_parameter_name(stmt, index)) index++
      bindValue(st, index++, args[i])
    }
  }

  const tooLarge = (v: bigint) => err(RangeError, 'ERR_OUT_OF_RANGE', `Value is too large to be represented as a JavaScript number: ${v}`)

  const columnNames = (stmt: number, n: number): string[] => {
    const names = new Array<string>(n)
    for (let i = 0; i < n; i++) names[i] = E.cstr(x.sqlite3_column_name(stmt, i))
    return names
  }

  /** The current row of a statement that just returned SQLITE_ROW. */
  const readRow = (st: StatementState, n: number, names: string[]): any => {
    const buf = E.rowBuffer(n)
    x.bat_row(st.stmt, n, buf)
    const u32 = E.u32
    const f64 = E.f64
    const u8 = E.u8
    const big = st.readBigInts
    const arrays = st.returnArrays
    const row: any = arrays ? new Array(n) : { __proto__: null }
    let w = buf >>> 2
    for (let i = 0; i < n; i++, w += 4) {
      let v: unknown
      switch (u32[w]) {
        case 1:
          v = f64[(w >>> 1) + 1]
          if (big) v = BigInt(v as number)
          break
        case 2:
          v = f64[(w >>> 1) + 1]
          break
        case 3:
          v = E.text(u32[w + 2], u32[w + 1])
          break
        case 4:
          v = u8.slice(u32[w + 2], u32[w + 2] + u32[w + 1])
          break
        case 6: {
          const exact = E.dv.getBigInt64(buf + i * 16 + 8, true)
          if (!big) throw tooLarge(exact)
          v = exact
          break
        }
        default:
          v = null
      }
      if (arrays) row[i] = v
      else row[names[i]] = v
    }
    return row
  }

  const valueToJs = (value: number, big: boolean): unknown => {
    switch (x.sqlite3_value_type(value)) {
      case 1: {
        if (big) return x.sqlite3_value_int64(value)
        if (!x.bat_value_int_safe(value)) throw tooLarge(x.sqlite3_value_int64(value))
        return x.sqlite3_value_double(value)
      }
      case 2:
        return x.sqlite3_value_double(value)
      case 3: {
        const p: number = x.sqlite3_value_text(value)
        const n: number = x.sqlite3_value_bytes(value)
        E.refresh()
        return E.text(p, n)
      }
      case 4: {
        const p: number = x.sqlite3_value_blob(value)
        const n: number = x.sqlite3_value_bytes(value)
        return E.u8.slice(p, p + n)
      }
      default:
        return null
    }
  }
  const argsToJs = (argc: number, argv: number, big: boolean): unknown[] => {
    const args = new Array(argc)
    for (let i = 0; i < argc; i++) args[i] = valueToJs(E.u32[(argv >>> 2) + i], big)
    return args
  }
  const resultFromJs = (ctx: number, value: unknown): void => {
    if (value === null || value === undefined) x.sqlite3_result_null(ctx)
    else if (typeof value === 'number') x.sqlite3_result_double(ctx, value)
    else if (typeof value === 'string') {
      const p = E.allocString(value)
      x.bat_result_text(ctx, p, E.lastLen)
    } else if (ArrayBuffer.isView(value)) {
      const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
      x.bat_result_blob(ctx, E.allocBytes(bytes), bytes.length)
    } else if (typeof value === 'bigint') {
      if (value > MAX_I64 || value < MIN_I64) throw err(RangeError, 'ERR_OUT_OF_RANGE', 'BigInt value is too large for SQLite')
      x.sqlite3_result_int64(ctx, value)
    } else if (typeof (value as PromiseLike<unknown>).then === 'function') {
      throw err(Error, 'ERR_SQLITE_ERROR', 'Asynchronous user-defined functions are not supported')
    } else throw err(Error, 'ERR_SQLITE_ERROR', 'Returned JavaScript value cannot be converted to a SQLite value')
  }

  // ---- StatementSync ----

  let constructing: StatementState | undefined
  const states = new WeakMap<object, StatementState>()
  const live = (self: object): StatementState => {
    const st = states.get(self)
    if (!st) throw invalidType('Illegal invocation')
    if (!st.conn.stmts.has(st.stmt)) throw invalidState('statement has been finalized')
    return st
  }
  const stepError = (st: StatementState): Error => sqliteError(st.conn)
  const begin = () => (timing ? performance.now() : 0)
  const end = (t: number) => {
    if (timing) counters.ms += performance.now() - t
  }
  const boolArg = (v: unknown, name: string) => {
    if (typeof v !== 'boolean') throw invalidType(`The "${name}" argument must be a boolean.`)
    return v
  }

  class StatementSync {
    constructor() {
      if (!constructing) throw err(Error, 'ERR_ILLEGAL_CONSTRUCTOR', 'Illegal constructor')
      states.set(this, constructing)
      constructing = undefined
    }
    all(): unknown[] {
      const st = live(this)
      const t = begin()
      counters.all++
      const stmt = st.stmt
      x.sqlite3_reset(stmt)
      try {
        bindParams(st, arguments)
        const rows: unknown[] = []
        const n: number = x.sqlite3_column_count(stmt)
        let names: string[] | undefined
        let rc: number
        while ((rc = x.sqlite3_step(stmt)) === SQLITE_ROW) rows.push(readRow(st, n, (names ??= st.returnArrays ? [] : columnNames(stmt, n))))
        if (rc !== SQLITE_DONE) throw stepError(st)
        return rows
      } finally {
        x.sqlite3_reset(stmt)
        end(t)
      }
    }
    get(): unknown {
      const st = live(this)
      const t = begin()
      counters.get++
      const stmt = st.stmt
      x.sqlite3_reset(stmt)
      try {
        bindParams(st, arguments)
        const rc: number = x.sqlite3_step(stmt)
        if (rc === SQLITE_DONE) return undefined
        if (rc !== SQLITE_ROW) throw stepError(st)
        const n: number = x.sqlite3_column_count(stmt)
        if (n === 0) return undefined
        return readRow(st, n, st.returnArrays ? [] : columnNames(stmt, n))
      } finally {
        x.sqlite3_reset(stmt)
        end(t)
      }
    }
    run(): { changes: number | bigint; lastInsertRowid: number | bigint } {
      const st = live(this)
      const t = begin()
      counters.run++
      const stmt = st.stmt
      x.sqlite3_reset(stmt)
      try {
        bindParams(st, arguments)
        let rc: number
        while ((rc = x.sqlite3_step(stmt)) === SQLITE_ROW) {}
        if (rc !== SQLITE_DONE) throw stepError(st)
      } finally {
        // An error is reported by step; reset would only report it again.
        x.sqlite3_reset(stmt)
        end(t)
      }
      const db = st.conn.db
      const changes: number = x.bat_changes(db)
      const rowid: number = x.bat_last_insert_rowid(db)
      if (st.readBigInts) return { changes: BigInt(changes), lastInsertRowid: BigInt(rowid) }
      return { changes, lastInsertRowid: rowid }
    }
    iterate(): IterableIterator<unknown> {
      const st = live(this)
      counters.iterate++
      const stmt = st.stmt
      x.sqlite3_reset(stmt)
      bindParams(st, arguments)
      const n: number = x.sqlite3_column_count(stmt)
      let names: string[] | undefined
      let done = false
      const finish = () => {
        if (!done) {
          done = true
          if (st.conn.stmts.has(stmt)) x.sqlite3_reset(stmt)
        }
      }
      const it = {
        __proto__: iteratorPrototype,
        next(): IteratorResult<unknown> {
          if (!st.conn.stmts.has(stmt)) throw invalidState('statement has been finalized')
          if (done) return { __proto__: null, done: true, value: null } as any
          const rc: number = x.sqlite3_step(stmt)
          if (rc === SQLITE_ROW) {
            return { __proto__: null, done: false, value: readRow(st, n, (names ??= st.returnArrays ? [] : columnNames(stmt, n))) } as any
          }
          const failed = rc !== SQLITE_DONE ? stepError(st) : undefined
          finish()
          if (failed) throw failed
          return { __proto__: null, done: true, value: null } as any
        },
        return(): IteratorResult<unknown> {
          finish()
          return { __proto__: null, done: true, value: null } as any
        },
      }
      return it as unknown as IterableIterator<unknown>
    }
    columns(): unknown[] {
      const st = live(this)
      const stmt = st.stmt
      const n: number = x.sqlite3_column_count(stmt)
      const s = (p: number) => (p ? E.cstr(p) : null)
      const out = new Array(n)
      for (let i = 0; i < n; i++) {
        out[i] = {
          __proto__: null,
          column: s(x.sqlite3_column_origin_name(stmt, i)),
          database: s(x.sqlite3_column_database_name(stmt, i)),
          name: s(x.sqlite3_column_name(stmt, i)),
          table: s(x.sqlite3_column_table_name(stmt, i)),
          type: s(x.sqlite3_column_decltype(stmt, i)),
        }
      }
      return out
    }
    setAllowBareNamedParameters(enabled: boolean): void {
      const st = live(this)
      st.bareNamed = boolArg(enabled, 'allowBareNamedParameters')
    }
    setAllowUnknownNamedParameters(enabled: boolean): void {
      const st = live(this)
      st.unknownNamed = boolArg(enabled, 'enabled')
    }
    setReadBigInts(enabled: boolean): void {
      const st = live(this)
      st.readBigInts = boolArg(enabled, 'readBigInts')
    }
    setReturnArrays(enabled: boolean): void {
      const st = live(this)
      st.returnArrays = boolArg(enabled, 'returnArrays')
    }
    get sourceSQL(): string {
      const st = live(this)
      return E.cstr(x.sqlite3_sql(st.stmt))
    }
    get expandedSQL(): string {
      const st = live(this)
      const p: number = x.sqlite3_expanded_sql(st.stmt)
      if (!p) throw err(Error, 'ERR_SQLITE_ERROR', 'Expanded SQL text would exceed configured limits')
      const sql = E.cstr(p)
      x.sqlite3_free(p)
      return sql
    }
  }
  const iteratorPrototype = Object.create(Iterator.prototype, {
    [Symbol.toStringTag]: { value: 'StatementSyncIterator', configurable: true },
  })

  // ---- DatabaseSync ----

  interface DbState {
    location: string
    readOnly: boolean
    foreignKeys: boolean
    dqs: boolean
    timeout: number
    defensive: boolean
    readBigInts: boolean
    returnArrays: boolean
    bareNamed: boolean
    unknownNamed: boolean
    conn?: Conn
  }
  const dbs = new WeakMap<object, DbState>()
  const dbState = (self: object): DbState => {
    const s = dbs.get(self)
    if (!s) throw invalidType('Illegal invocation')
    return s
  }
  const opened = (self: object): Conn => {
    const conn = dbState(self).conn
    if (!conn) throw invalidState('database is not open')
    return conn
  }

  const pathArg = (path: unknown): string => {
    let location: string | undefined
    if (typeof path === 'string') location = path
    else if (path instanceof Uint8Array) location = new TextDecoder().decode(path)
    else if (path !== null && typeof path === 'object' && typeof (path as URL).href === 'string' && (path as URL).protocol === 'file:') {
      location = decodeURIComponent((path as URL).pathname)
    }
    if (location === undefined || location.includes('\0')) {
      throw invalidType('The "path" argument must be a string, Uint8Array, or URL without null bytes.')
    }
    return location
  }

  const openDatabase = (s: DbState): void => {
    engine()
    const z = E.allocString(s.location)
    const flags = (s.readOnly ? OPEN_READONLY : OPEN_READWRITE | OPEN_CREATE) | OPEN_URI
    const rc: number = x.sqlite3_open_v2(z, E.out, flags, 0)
    x.free(z)
    const db = E.u32[E.out >>> 2]
    const conn: Conn = { db, stmts: new Set(), functionIds: [], authorizerId: 0, ignoreNextError: false }
    try {
      if (rc !== SQLITE_OK) {
        if (!db) throw err(Error, 'ERR_SQLITE_ERROR', 'out of memory')
        throw sqliteError(conn)
      }
      x.sqlite3_extended_result_codes(db, 1)
      check(conn, x.bat_db_config(db, DBCONFIG_DQS_DML, s.dqs ? 1 : 0))
      check(conn, x.bat_db_config(db, DBCONFIG_DQS_DDL, s.dqs ? 1 : 0))
      check(conn, x.bat_db_config(db, DBCONFIG_ENABLE_FKEY, s.foreignKeys ? 1 : 0))
      if (s.defensive) check(conn, x.bat_db_config(db, DBCONFIG_DEFENSIVE, 1))
      x.sqlite3_busy_timeout(db, s.timeout)
    } catch (e) {
      if (db) x.sqlite3_close_v2(db)
      throw e
    }
    s.conn = conn
  }

  const closeDatabase = (s: DbState): void => {
    const conn = s.conn!
    for (const stmt of conn.stmts) x.sqlite3_finalize(stmt)
    conn.stmts.clear()
    const rc: number = x.sqlite3_close_v2(conn.db)
    s.conn = undefined
    if (conn.authorizerId) E.removeFunction(conn.authorizerId)
    if (rc !== SQLITE_OK) throw err(Error, 'ERR_SQLITE_ERROR', 'failed to close the database')
  }

  const prepareStatement = (s: DbState, conn: Conn, sql: string): StatementSync => {
    const z = E.allocString(sql)
    const rc: number = x.sqlite3_prepare_v2(conn.db, z, E.lastLen + 1, E.out, 0)
    x.free(z)
    if (rc !== SQLITE_OK) throw sqliteError(conn)
    const stmt = E.u32[E.out >>> 2]
    conn.stmts.add(stmt)
    constructing = {
      conn,
      stmt,
      readBigInts: s.readBigInts,
      returnArrays: s.returnArrays,
      bareNamed: s.bareNamed,
      unknownNamed: s.unknownNamed,
    }
    const statement = new StatementSync()
    registry.register(statement, { conn, stmt })
    return statement
  }

  const optionBool = (options: Record<string, unknown>, key: string, fallback: boolean, prefix = 'options'): boolean => {
    const v = options[key]
    if (v === undefined) return fallback
    if (typeof v !== 'boolean') throw invalidType(`The "${prefix}.${key}" argument must be a boolean.`)
    return v
  }

  class DatabaseSync {
    constructor(path: string | Uint8Array | URL, options?: Record<string, unknown>) {
      const location = pathArg(path)
      const s: DbState = {
        location,
        readOnly: false,
        foreignKeys: true,
        dqs: false,
        timeout: 0,
        defensive: false,
        readBigInts: false,
        returnArrays: false,
        bareNamed: true,
        unknownNamed: false,
      }
      let open = true
      if (options !== undefined) {
        if (options === null || typeof options !== 'object') throw invalidType('The "options" argument must be an object.')
        open = optionBool(options, 'open', true)
        s.readOnly = optionBool(options, 'readOnly', false)
        s.foreignKeys = optionBool(options, 'enableForeignKeyConstraints', true)
        s.dqs = optionBool(options, 'enableDoubleQuotedStringLiterals', false)
        if (optionBool(options, 'allowExtension', false)) throw unavailable('node:sqlite: loading extensions')
        if (options.timeout !== undefined) {
          if (!Number.isInteger(options.timeout)) throw invalidType('The "options.timeout" argument must be an integer.')
          s.timeout = options.timeout as number
        }
        s.readBigInts = optionBool(options, 'readBigInts', false)
        s.returnArrays = optionBool(options, 'returnArrays', false)
        s.bareNamed = optionBool(options, 'allowBareNamedParameters', true)
        s.unknownNamed = optionBool(options, 'allowUnknownNamedParameters', false)
        s.defensive = optionBool(options, 'defensive', false)
      }
      dbs.set(this, s)
      if (open) {
        const t = begin()
        counters.open++
        openDatabase(s)
        end(t)
      }
    }
    open(): void {
      const s = dbState(this)
      if (s.conn) throw invalidState('database is already open')
      const t = begin()
      counters.open++
      openDatabase(s)
      end(t)
    }
    close(): void {
      const s = dbState(this)
      if (!s.conn) throw invalidState('database is not open')
      const t = begin()
      counters.close++
      closeDatabase(s)
      end(t)
    }
    prepare(sql: string): StatementSync {
      const s = dbState(this)
      const conn = opened(this)
      if (typeof sql !== 'string') throw invalidType('The "sql" argument must be a string.')
      const t = begin()
      counters.prepare++
      try {
        return prepareStatement(s, conn, sql)
      } finally {
        end(t)
      }
    }
    exec(sql: string): void {
      const conn = opened(this)
      if (typeof sql !== 'string') throw invalidType('The "sql" argument must be a string.')
      const t = begin()
      counters.exec++
      const z = E.allocString(sql)
      const rc: number = x.bat_exec(conn.db, z)
      x.free(z)
      end(t)
      if (rc !== SQLITE_OK) throw sqliteError(conn)
    }
    function(name: string, options: unknown, fn?: unknown): void {
      const conn = opened(this)
      if (typeof name !== 'string') throw invalidType('The "name" argument must be a string.')
      if (typeof options === 'function') {
        fn = options
        options = undefined
      }
      let big = false
      let varargs = false
      let deterministic = false
      let directOnly = false
      if (options !== undefined) {
        if (options === null || typeof options !== 'object') throw invalidType('The "options" argument must be an object.')
        const o = options as Record<string, unknown>
        big = optionBool(o, 'useBigIntArguments', false)
        varargs = optionBool(o, 'varargs', false)
        deterministic = optionBool(o, 'deterministic', false)
        directOnly = optionBool(o, 'directOnly', false)
      }
      if (typeof fn !== 'function') throw invalidType('The "function" argument must be a function.')
      const f = fn as (...args: unknown[]) => unknown
      const id = E.addFunction({
        call(ctx, argc, argv) {
          resultFromJs(ctx, f(...argsToJs(argc, argv, big)))
        },
      })
      const z = E.allocString(name)
      const flags = SQLITE_UTF8 | (deterministic ? SQLITE_DETERMINISTIC : 0) | (directOnly ? SQLITE_DIRECTONLY : 0)
      const rc: number = x.bat_create_function(conn.db, z, varargs ? -1 : f.length, flags, id)
      x.free(z)
      check(conn, rc)
    }
    aggregate(name: string, options: Record<string, unknown>): void {
      const conn = opened(this)
      if (typeof name !== 'string') throw invalidType('The "name" argument must be a string.')
      if (options === null || typeof options !== 'object') throw invalidType('The "options" argument must be an object.')
      const start = options.start
      if (start === undefined) throw invalidType('The "options.start" argument must be a function or a primitive value.')
      const step = options.step as (acc: unknown, ...args: unknown[]) => unknown
      if (typeof step !== 'function') throw invalidType('The "options.step" argument must be a function.')
      const result = options.result as ((acc: unknown) => unknown) | undefined
      const inverse = options.inverse as ((acc: unknown, ...args: unknown[]) => unknown) | undefined
      if (inverse !== undefined && typeof inverse !== 'function') throw invalidType('The "options.inverse" argument must be a function.')
      const big = optionBool(options, 'useBigIntArguments', false)
      const varargs = optionBool(options, 'varargs', false)
      const directOnly = optionBool(options, 'directOnly', false)
      const deterministic = optionBool(options, 'deterministic', false)
      let argc = -1
      if (!varargs) {
        argc = Math.max(0, step.length - 1)
        if (inverse) argc = Math.max(argc, Math.max(0, inverse.length - 1))
      }
      const accumulators = new Map<number, { value: unknown }>()
      const initial = () => ({ value: typeof start === 'function' ? (start as () => unknown)() : start })
      const id = E.addFunction({
        step(ctx, state, argCount, argv, isInverse) {
          let acc = accumulators.get(state)
          if (!acc) accumulators.set(state, (acc = initial()))
          const args = argsToJs(argCount, argv, big)
          acc.value = (isInverse ? inverse! : step)(acc.value, ...args)
        },
        final(ctx, state, isFinal) {
          const acc = (state ? accumulators.get(state) : undefined) ?? initial()
          if (isFinal && state) accumulators.delete(state)
          resultFromJs(ctx, typeof result === 'function' ? result(acc.value) : acc.value)
        },
      })
      const z = E.allocString(name)
      const flags = SQLITE_UTF8 | (deterministic ? SQLITE_DETERMINISTIC : 0) | (directOnly ? SQLITE_DIRECTONLY : 0)
      const rc: number = x.bat_create_aggregate(conn.db, z, argc, flags, id, inverse ? 1 : 0)
      x.free(z)
      check(conn, rc)
    }
    createTagStore(maxSize = 1000): unknown {
      opened(this)
      return createTagStore(this, maxSize)
    }
    location(dbName = 'main'): string | null {
      const conn = opened(this)
      if (typeof dbName !== 'string') throw invalidType('The "dbName" argument must be a string.')
      const z = E.allocString(dbName)
      const p: number = x.sqlite3_db_filename(conn.db, z)
      x.free(z)
      if (!p) return null
      return E.cstr(p) || null
    }
    createSession(): never {
      opened(this)
      throw unavailable('node:sqlite: createSession()')
    }
    applyChangeset(): never {
      opened(this)
      throw unavailable('node:sqlite: applyChangeset()')
    }
    enableLoadExtension(): never {
      opened(this)
      throw unavailable('node:sqlite: loading extensions')
    }
    loadExtension(): never {
      opened(this)
      throw unavailable('node:sqlite: loading extensions')
    }
    enableDefensive(active: boolean): void {
      const conn = opened(this)
      if (typeof active !== 'boolean') throw invalidType('The "active" argument must be a boolean.')
      check(conn, x.bat_db_config(conn.db, DBCONFIG_DEFENSIVE, active ? 1 : 0))
    }
    serialize(dbName = 'main'): Uint8Array {
      const conn = opened(this)
      if (typeof dbName !== 'string') throw invalidType('The "dbName" argument must be a string.')
      const z = E.allocString(dbName)
      const p: number = x.sqlite3_serialize(conn.db, z, E.out, 0)
      x.free(z)
      const size = Number(E.dv.getBigInt64(E.out, true))
      if (!p) {
        if (size === 0) return new Uint8Array(0)
        throw sqliteError(conn)
      }
      const bytes = E.u8.slice(p, p + size)
      x.sqlite3_free(p)
      return bytes
    }
    deserialize(buffer: Uint8Array, options?: { dbName?: string }): void {
      const conn = opened(this)
      if (!(buffer instanceof Uint8Array)) throw invalidType('The "buffer" argument must be a Uint8Array.')
      let dbName = 'main'
      if (options !== undefined) {
        if (options === null || typeof options !== 'object') throw invalidType('The "options" argument must be an object.')
        if (options.dbName !== undefined) {
          if (typeof options.dbName !== 'string') throw invalidType('The "options.dbName" argument must be a string.')
          dbName = options.dbName
        }
      }
      if (buffer.length === 0) throw err(RangeError, 'ERR_INVALID_ARG_VALUE', 'The "buffer" argument must not be empty.')
      for (const stmt of conn.stmts) x.sqlite3_finalize(stmt)
      conn.stmts.clear()
      const p: number = x.sqlite3_malloc(buffer.length)
      if (!p) throw err(Error, 'ERR_MEMORY_ALLOCATION_FAILED', 'Failed to allocate memory for the database')
      E.u8.set(buffer, p)
      const z = E.allocString(dbName)
      const n = BigInt(buffer.length)
      const rc: number = x.sqlite3_deserialize(conn.db, z, p, n, n, DESERIALIZE_FREEONCLOSE | DESERIALIZE_RESIZEABLE)
      x.free(z)
      check(conn, rc)
    }
    setAuthorizer(callback: ((...args: unknown[]) => unknown) | null): void {
      const conn = opened(this)
      if (callback !== null && typeof callback !== 'function') throw invalidType('The "callback" argument must be a function or null.')
      if (conn.authorizerId) E.removeFunction(conn.authorizerId)
      conn.authorizerId = 0
      if (callback) {
        conn.authorizerId = E.addFunction({
          authorize(action, a, b, c, d) {
            const r = callback(action, a, b, c, d)
            if (!Number.isInteger(r)) throw invalidType('Authorizer callback must return an integer authorization code')
            if (r !== 0 && r !== 1 && r !== 2) {
              throw err(RangeError, 'ERR_OUT_OF_RANGE', 'Authorizer callback returned a invalid authorization code')
            }
            return r as number
          },
        })
      }
      check(conn, x.bat_set_authorizer(conn.db, conn.authorizerId))
    }
    get isOpen(): boolean {
      return dbState(this).conn !== undefined
    }
    get isTransaction(): boolean {
      return x.sqlite3_get_autocommit(opened(this).db) === 0
    }
    [Symbol.dispose](): void {
      const s = dbState(this)
      if (s.conn) {
        try {
          closeDatabase(s)
        } catch {}
      }
    }
  }

  // ---- SQLTagStore (db.createTagStore) ----

  function createTagStore(db: DatabaseSync, capacity: number) {
    const cache = new Map<string, StatementSync>()
    const statement = (strings: readonly string[]): StatementSync => {
      const sql = strings.join('?')
      let st = cache.get(sql)
      if (st) {
        cache.delete(sql)
        const state = states.get(st)!
        if (!state.conn.stmts.has(state.stmt)) st = undefined
      }
      if (!st) st = db.prepare(sql)
      cache.set(sql, st)
      if (cache.size > capacity) cache.delete(cache.keys().next().value!)
      return st
    }
    return {
      all: (strings: readonly string[], ...values: unknown[]) => (statement(strings).all as any)(...values),
      get: (strings: readonly string[], ...values: unknown[]) => (statement(strings).get as any)(...values),
      run: (strings: readonly string[], ...values: unknown[]) => (statement(strings).run as any)(...values),
      iterate: (strings: readonly string[], ...values: unknown[]) => (statement(strings).iterate as any)(...values),
      clear: () => cache.clear(),
      get size() { return cache.size },
      get capacity() { return capacity },
      get db() { return db },
    }
  }

  class Session {
    constructor() {
      throw err(Error, 'ERR_ILLEGAL_CONSTRUCTOR', 'Illegal constructor')
    }
  }

  // ---- backup ----

  function backup(sourceDb: DatabaseSync, path: string | Uint8Array | URL, options?: Record<string, unknown>): Promise<number> {
    if (sourceDb === null || typeof sourceDb !== 'object' || !dbs.has(sourceDb)) throw invalidType('The "sourceDb" argument must be an object.')
    const conn = opened(sourceDb)
    const location = pathArg(path)
    let rate = 100
    let source = 'main'
    let target = 'main'
    let progress: ((info: { totalPages: number; remainingPages: number }) => void) | undefined
    if (options !== undefined) {
      if (options === null || typeof options !== 'object') throw invalidType('The "options" argument must be an object.')
      if (options.rate !== undefined) {
        if (!Number.isInteger(options.rate)) throw invalidType('The "options.rate" argument must be an integer.')
        rate = options.rate as number
      }
      if (options.source !== undefined) {
        if (typeof options.source !== 'string') throw invalidType('The "options.source" argument must be a string.')
        source = options.source
      }
      if (options.target !== undefined) {
        if (typeof options.target !== 'string') throw invalidType('The "options.target" argument must be a string.')
        target = options.target
      }
      if (options.progress !== undefined) {
        if (typeof options.progress !== 'function') throw invalidType('The "options.progress" argument must be a function.')
        progress = options.progress as typeof progress
      }
    }
    return new Promise<number>((resolve, reject) => {
      const z = E.allocString(location)
      const rc: number = x.sqlite3_open_v2(z, E.out, OPEN_READWRITE | OPEN_CREATE | OPEN_URI, 0)
      x.free(z)
      const dest: Conn = { db: E.u32[E.out >>> 2], stmts: new Set(), functionIds: [], authorizerId: 0, ignoreNextError: false }
      const fail = (e: unknown) => {
        if (dest.db) x.sqlite3_close_v2(dest.db)
        reject(e)
      }
      if (rc !== SQLITE_OK) return fail(sqliteError(dest))
      const zt = E.allocString(target)
      const zs = E.allocString(source)
      const handle: number = x.sqlite3_backup_init(dest.db, zt, conn.db, zs)
      x.free(zt)
      x.free(zs)
      if (!handle) return fail(sqliteError(dest))
      // One batch of pages per turn, as native does, so the progress callback sees the loop.
      const turn = () => {
        try {
          if (!dbs.get(sourceDb)?.conn) {
            x.sqlite3_backup_finish(handle)
            return fail(invalidState('database is not open'))
          }
          const r: number = x.sqlite3_backup_step(handle, rate)
          const total: number = x.sqlite3_backup_pagecount(handle)
          const remaining: number = x.sqlite3_backup_remaining(handle)
          if (r === SQLITE_DONE) {
            x.sqlite3_backup_finish(handle)
            x.sqlite3_close_v2(dest.db)
            return resolve(total)
          }
          if (r !== SQLITE_OK && r !== 5 && r !== 6) {
            x.sqlite3_backup_finish(handle)
            return fail(sqliteError(dest))
          }
          if (progress) progress({ totalPages: total, remainingPages: remaining })
          queueMicrotask(turn)
        } catch (e) {
          x.sqlite3_backup_finish(handle)
          fail(e)
        }
      }
      turn()
    })
  }

  for (const C of [DatabaseSync, StatementSync] as const) {
    for (const key of Object.getOwnPropertyNames(C.prototype)) {
      if (key === 'constructor') continue
      const d = Object.getOwnPropertyDescriptor(C.prototype, key)!
      if (typeof d.value === 'function') Object.defineProperty(C.prototype, key, { ...d, enumerable: true })
    }
  }

  // Node throws when the constructor is called without `new`; a class already does, with another message.
  const callable = <T extends Function>(C: T, name: string): T =>
    new Proxy(C, {
      apply() {
        throw err(TypeError, 'ERR_CONSTRUCT_CALL_REQUIRED', 'Cannot call constructor without `new`')
      },
    })

  return {
    DatabaseSync: callable(DatabaseSync, 'DatabaseSync'),
    StatementSync,
    Session,
    constants,
    backup,
    /** Not part of node:sqlite: engine timings and per-call counters for harnesses. */
    __bat: {
      counters,
      get engine() { return holder.stats },
      /** Also accumulate time spent in the API (adds two clock reads per call). */
      setTiming(on: boolean) { timing = on },
    },
  }
}

export type SqliteModule = ReturnType<typeof createSqliteModule>
