import type { Client, QueryResult } from "pg";
import type {
  ConnectionDiagnostic,
  PlApiFunctionArg,
  PlApiFunctionDef,
  PlApiStackFrame,
  PlApiStackVariable,
  PlApiStep,
} from "./types.js";
import { readVariables } from "./variables/index.js";

const DEBUGGER_SHARED_LIBRARY = "plugin_debugger";
const DEBUGGER_EXTENSION = "pldbgapi";
const INVALID_SESSION = 0;

const SQL = {
  CREATE_LISTENER: `SELECT pldbg_create_listener();`,

  WAIT_FOR_TARGET: `SELECT pldbg_wait_for_target($1);`,

  ABORT: `SELECT pldbg_abort_target($1);`,

  STEP_OVER: `
    SELECT step.func, step.linenumber, md5(pg_catalog.pg_get_functiondef(step.func))
    FROM pldbg_step_over($1) step;`,

  STEP_INTO: `
    SELECT step.func, step.linenumber, md5(pg_catalog.pg_get_functiondef(step.func))
    FROM pldbg_step_into($1) step;`,

  STEP_CONTINUE: `
    SELECT step.func, step.linenumber, md5(pg_catalog.pg_get_functiondef(step.func))
    FROM pldbg_continue($1) step;`,

  LIST_BREAKPOINT: `
    SELECT bp.func, bp.linenumber, ''
    FROM pldbg_get_breakpoints($1) bp;`,

  SET_GLOBAL_BREAKPOINT: `SELECT pldbg_set_global_breakpoint($1, $2, -1, NULL);`,

  SET_BREAKPOINT: `SELECT pldbg_set_breakpoint($1, $2, $3);`,

  DROP_BREAKPOINT: `SELECT pldbg_drop_breakpoint($1, $2, $3);`,

  DEPOSIT_VALUE: `SELECT pldbg_deposit_value($1, $2, $3, $4);`,

  GET_STACK: `
    SELECT frame.level, frame.func, frame.linenumber,
           md5(pg_catalog.pg_get_functiondef(frame.func))
    FROM pldbg_get_stack($1) frame;`,

  GET_RAW_VARIABLES: `
    SELECT
      varclass = 'A' as is_arg,
      linenumber as line,
      t_type.oid as oid,
      t_var.name as name,
      coalesce(t_type.oid::regtype::TEXT, 'text') as type,
      coalesce(t_type.typtype, 'b') as kind,
      t_type.typarray = 0 as is_array,
      t_type.typcategory = 'S' as is_text,
      coalesce(t_sub.oid::regtype::TEXT, 'text') as array_type,
      t_var.value as value,
      '' as pretty
    FROM pldbg_get_variables($1) t_var
         LEFT JOIN pg_type t_type ON t_var.dtype = t_type.oid
         LEFT JOIN pg_type t_sub ON t_type.typelem = t_sub.oid;`,

  SELECT_FRAME: `SELECT * FROM pldbg_select_frame($1, $2);`,

  GET_SHARED_LIBRARIES: `
    SELECT setting
    FROM pg_settings
    WHERE name = 'shared_preload_libraries';`,

  GET_EXTENSION: `
    SELECT t_namespace.nspname, t_extension.extname, t_extension.extversion
    FROM pg_extension t_extension
    JOIN pg_namespace t_namespace ON t_extension.extnamespace = t_namespace.oid;`,

  GET_FUNCTION_CALL_ARGS: `
    SELECT t_proc2.oid, t_proc2.pronargs, t_proc2.idx, t_proc2.proargname,
           format_type(t_proc2.proargtype, NULL) AS arg_type,
           t_proc2.pronargs > 0 AND idx > (t_proc2.pronargs - t_proc2.pronargdefaults) AS has_default
    FROM (SELECT idx as idx, t_proc1.pronargs, t_proc1.pronargdefaults, t_proc1.oid,
                 t_proc1.proargtypes[idx - 1] AS proargtype,
                 t_proc1.proargnames[idx] AS proargname
          FROM (SELECT t_proc.oid,
                       CASE WHEN t_proc.pronargs = 0 THEN '{0}'::oid[] ELSE t_proc.proargtypes::oid[] END AS proargtypes,
                       CASE WHEN t_proc.pronargs = 0 THEN '{""}'::TEXT[] ELSE t_proc.proargnames END AS proargnames,
                       t_proc.pronargs, t_proc.pronargdefaults,
                       CASE WHEN t_proc.pronargs = 0 THEN 1 ELSE t_proc.pronargs END AS serial
                FROM pg_proc t_proc
                JOIN pg_namespace t_namespace ON t_proc.pronamespace = t_namespace.oid
                WHERE lower(t_namespace.nspname) = lower($1)
                  AND lower(t_proc.proname) = lower($2)
                ORDER BY t_proc.oid) t_proc1,
               generate_series(1, t_proc1.serial) idx) t_proc2
         LEFT JOIN pg_type t_type ON t_proc2.proargtype = t_type.oid;`,

  GET_FUNCTION_DEF: `
    SELECT t_proc.oid, t_namespace.nspname, t_proc.proname,
           pg_catalog.pg_get_functiondef(t_proc.oid),
           t_proc.prosrc,
           md5(pg_catalog.pg_get_functiondef(t_proc.oid))
    FROM pg_proc t_proc
    JOIN pg_namespace t_namespace ON t_proc.pronamespace = t_namespace.oid
    WHERE t_proc.oid = $1;`,
} as const;

// This compact adapter deliberately keeps one method per pldbgapi command around one session.
// Splitting the surface would create competing owners for the same server-side lifecycle.
// code-moniker: ignore[smell-large-class]
export class PostgresDebugger {
  private client: Client;
  private session: number = INVALID_SESSION;
  private readonly backendPid: number;
  private blockingCount = 0;

  constructor(client: Client) {
    this.client = client;
    this.backendPid = (client as Client & { processID?: number | null }).processID ?? 0;
  }

  private invalidSession(): boolean {
    return this.session === INVALID_SESSION;
  }

  getBackendPid(): number {
    return this.backendPid;
  }

  /** True while a server-side blocking pldbgapi command (wait/step) is in flight — commands queued behind it would never be sent. */
  isBusy(): boolean {
    return this.blockingCount > 0;
  }

  private async runBlocking<T>(fn: () => Promise<T>): Promise<T> {
    this.blockingCount++;
    try {
      return await fn();
    } finally {
      this.blockingCount--;
    }
  }

  async checkDebugger(): Promise<ConnectionDiagnostic> {
    const [sharedLibs, extResult] = await Promise.all([
      this.client.query(SQL.GET_SHARED_LIBRARIES),
      this.client.query(SQL.GET_EXTENSION),
    ]);
    const sharedLibraries = sharedLibs.rows.map((r) => r.setting as string).join(", ");
    const extensions = extResult.rows.map((r) => r.extname as string).join(", ");

    return {
      sharedLibraryOk: sharedLibraries.toLowerCase().includes(DEBUGGER_SHARED_LIBRARY),
      sharedLibraries,
      extensionOk: extensions.toLowerCase().includes(DEBUGGER_EXTENSION),
      extensions,
    };
  }

  async getCallArgs(schema: string, routine: string): Promise<PlApiFunctionArg[]> {
    const result = await this.client.query(SQL.GET_FUNCTION_CALL_ARGS, [schema, routine]);
    return result.rows.map((r) => ({
      oid: Number(r.oid),
      nb: Number(r.pronargs),
      pos: Number(r.idx),
      name: r.proargname ?? "",
      type: r.arg_type ?? "",
      hasDefault: Boolean(r.has_default),
    }));
  }

  async createListener(): Promise<void> {
    const result = await this.client.query(SQL.CREATE_LISTENER);
    this.session = result.rows[0]?.pldbg_create_listener ?? INVALID_SESSION;
  }

  async waitForTarget(): Promise<number> {
    if (this.invalidSession()) return 0;
    return this.runBlocking(async () => {
      const result = await this.client.query(SQL.WAIT_FOR_TARGET, [this.session]);
      return result.rows[0]?.pldbg_wait_for_target ?? 0;
    });
  }

  async abort(): Promise<void> {
    if (this.invalidSession()) return;
    await this.client.query(SQL.ABORT, [this.session]);
  }

  async stepOver(): Promise<PlApiStep | null> {
    try {
      return await this.runStep(SQL.STEP_OVER);
    } catch {
      return null;
    }
  }

  async stepInto(): Promise<PlApiStep | null> {
    try {
      return await this.runStep(SQL.STEP_INTO);
    } catch {
      return null;
    }
  }

  async stepContinue(): Promise<PlApiStep | null> {
    try {
      return await this.runStep(SQL.STEP_CONTINUE);
    } catch {
      return null;
    }
  }

  private async runStep(sql: string): Promise<PlApiStep | null> {
    if (this.invalidSession()) return null;
    return this.runBlocking(async () => {
      const result = await this.client.query(sql, [this.session]);
      return this.parseStep(result);
    });
  }

  private parseStep(result: QueryResult): PlApiStep | null {
    const row = result.rows[0];
    if (!row) return null;
    return {
      oid: Number(row.func),
      line: Number(row.linenumber),
      md5: row.md5 ?? "",
    };
  }

  async getStack(): Promise<PlApiStackFrame[]> {
    if (this.invalidSession()) return [];
    const result = await this.client.query(SQL.GET_STACK, [this.session]);
    return result.rows.map((r) => ({
      level: Number(r.level),
      oid: Number(r.func),
      line: Number(r.linenumber),
      md5: r.md5 ?? "",
    }));
  }

  async getFunctionDef(oid: number): Promise<PlApiFunctionDef | null> {
    const result = await this.client.query(SQL.GET_FUNCTION_DEF, [oid]);
    const row = result.rows[0];
    if (!row) return null;
    const source = `${(row.pg_get_functiondef as string).replace(/\n$/, "")};`;
    const body = row.prosrc as string;
    return {
      oid: Number(row.oid),
      schema: row.nspname,
      name: row.proname,
      source,
      body,
      md5: row.md5,
    };
  }

  async getVariables(): Promise<PlApiStackVariable[]> {
    if (this.invalidSession()) return [];
    return readVariables(this.client, this.session, SQL.GET_RAW_VARIABLES);
  }

  async selectFrame(frame: number): Promise<void> {
    if (this.invalidSession()) return;
    await this.client.query(SQL.SELECT_FRAME, [this.session, frame]);
  }

  async getBreakpoints(): Promise<PlApiStep[]> {
    if (this.invalidSession()) return [];
    const result = await this.client.query(SQL.LIST_BREAKPOINT, [this.session]);
    return result.rows.map((r) => ({
      oid: Number(r.func),
      line: Number(r.linenumber),
      md5: "",
    }));
  }

  async setGlobalBreakpoint(oid: number): Promise<void> {
    if (this.invalidSession()) return;
    await this.client.query(SQL.SET_GLOBAL_BREAKPOINT, [this.session, oid]);
  }

  async setBreakpoint(oid: number, line: number): Promise<boolean> {
    if (this.invalidSession()) return false;
    const result = await this.client.query(SQL.SET_BREAKPOINT, [this.session, oid, line]);
    return Boolean(result.rows[0]?.pldbg_set_breakpoint);
  }

  async dropBreakpoint(oid: number, line: number): Promise<boolean> {
    if (this.invalidSession()) return false;
    const result = await this.client.query(SQL.DROP_BREAKPOINT, [this.session, oid, line]);
    return Boolean(result.rows[0]?.pldbg_drop_breakpoint);
  }

  async dropGlobalBreakpoint(oid: number): Promise<boolean> {
    return this.dropBreakpoint(oid, -1);
  }

  async depositValue(varNo: number, lineNo: number, value: string): Promise<boolean> {
    if (this.invalidSession()) return false;
    try {
      await this.client.query(SQL.DEPOSIT_VALUE, [this.session, varNo, lineNo, value]);
      return true;
    } catch {
      return false;
    }
  }

  /** Execute arbitrary SQL on the listener connection (for REPL and condition evaluation). */
  async evaluateSql(sql: string): Promise<QueryResult> {
    return this.client.query(sql);
  }

  async close(): Promise<void> {
    await this.client.end();
  }

  getSession(): number {
    return this.session;
  }
}
