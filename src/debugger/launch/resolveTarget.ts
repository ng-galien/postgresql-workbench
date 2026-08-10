import type { SyntaxParser } from "../../analysis/syntaxTree.js";
import { parseCall } from "../../callParser.js";
import type { PlApiFunctionArg, PostgresDebugger } from "../postgres/index.js";
import type { DebugSessionRoutine } from "./debugSessionStatus.js";
import {
  type DebugLaunchRoutineArgument,
  type DebugLaunchRoutineTarget,
  routineDisplayName,
} from "./launchConfig.js";

export interface LaunchTargetArguments {
  sql?: string;
  routine?: DebugLaunchRoutineTarget;
  routineArgs?: DebugLaunchRoutineArgument[];
  sourceUris: Record<string, string>;
}

export interface TargetExecution {
  entryOid: number;
  queryText: string;
  queryValues: Array<string | null>;
  routine: DebugSessionRoutine;
}

interface ResolvedRoutine {
  oid: number;
  schema: string | null;
  name: string;
  kind: "function" | "procedure";
  argTypes: string[];
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function buildParameterizedCall(target: DebugLaunchRoutineTarget, argTypes: string[]): string {
  const qualified = target.schema
    ? `${quoteIdentifier(target.schema)}.${quoteIdentifier(target.name)}`
    : quoteIdentifier(target.name);
  const placeholders = argTypes.map((type, index) => `$${index + 1}::${type}`);
  return target.kind === "procedure"
    ? `CALL ${qualified}(${placeholders.join(", ")})`
    : `SELECT ${qualified}(${placeholders.join(", ")})`;
}

function groupRoutineCandidates(
  rows: PlApiFunctionArg[],
): Array<{ oid: number; argTypes: string[] }> {
  const byOid = new Map<number, PlApiFunctionArg[]>();
  for (const row of rows) {
    const list = byOid.get(row.oid) ?? [];
    list.push(row);
    byOid.set(row.oid, list);
  }

  return [...byOid.entries()].map(([oid, args]) => ({
    oid,
    argTypes:
      args[0]?.nb === 0
        ? []
        : args.sort((left, right) => left.pos - right.pos).map((arg) => arg.type),
  }));
}

function normalizeTypeName(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, " ");
  const aliases: Record<string, string> = {
    int2: "smallint",
    int4: "integer",
    int8: "bigint",
    float4: "real",
    float8: "double precision",
    bool: "boolean",
    varchar: "character varying",
    "timestamp with time zone": "timestamptz",
    "timestamp without time zone": "timestamp",
    "time with time zone": "timetz",
    "time without time zone": "time",
    decimal: "numeric",
  };
  return aliases[normalized] ?? normalized;
}

function sameArgTypes(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => normalizeTypeName(value) === normalizeTypeName(right[index]))
  );
}

async function resolveRoutineTarget(
  debuggerBackend: PostgresDebugger,
  target: DebugLaunchRoutineTarget,
  argCount: number,
): Promise<ResolvedRoutine> {
  if (target.oid) {
    return {
      oid: target.oid,
      schema: target.schema,
      name: target.name,
      kind: target.kind,
      argTypes: target.argTypes ?? Array.from({ length: argCount }, () => "text"),
    };
  }

  const candidates = groupRoutineCandidates(
    await debuggerBackend.getCallArgs(target.schema ?? "public", target.name),
  );
  if (candidates.length === 0) {
    throw new Error(`Function not found: ${routineDisplayName(target)}`);
  }

  const byTypes =
    target.argTypes && target.argTypes.length > 0
      ? candidates.filter((candidate) => sameArgTypes(candidate.argTypes, target.argTypes!))
      : candidates;
  const byTypeAndArity = byTypes.filter((candidate) => candidate.argTypes.length === argCount);
  const byArity = candidates.filter((candidate) => candidate.argTypes.length === argCount);
  const matches =
    byTypeAndArity.length > 0
      ? byTypeAndArity
      : byTypes.length > 0
        ? byTypes
        : byArity.length > 0
          ? byArity
          : candidates;

  if (matches.length !== 1) {
    throw new Error(`Ambiguous routine target: ${routineDisplayName(target)}`);
  }

  return {
    oid: matches[0].oid,
    schema: target.schema,
    name: target.name,
    kind: target.kind,
    argTypes: matches[0].argTypes,
  };
}

async function resolveStructuredTargetExecution(
  debuggerBackend: PostgresDebugger,
  target: DebugLaunchRoutineTarget,
  routineArgs: DebugLaunchRoutineArgument[],
): Promise<TargetExecution> {
  const resolved = await resolveRoutineTarget(debuggerBackend, target, routineArgs.length);
  const values = routineArgs.map((arg) => arg.value);
  if (resolved.argTypes.length !== values.length) {
    throw new Error(
      `Argument count mismatch for ${routineDisplayName(target)}: expected ${resolved.argTypes.length}, got ${values.length}`,
    );
  }

  return {
    entryOid: resolved.oid,
    queryText: buildParameterizedCall(
      { ...target, schema: resolved.schema, kind: resolved.kind, name: resolved.name },
      resolved.argTypes,
    ),
    queryValues: values,
    routine: {
      oid: resolved.oid,
      schema: resolved.schema,
      name: resolved.name,
      kind: resolved.kind,
    },
  };
}

export async function resolveTargetExecution(
  debuggerBackend: PostgresDebugger,
  args: LaunchTargetArguments,
  parser: SyntaxParser,
): Promise<TargetExecution> {
  if (args.routine) {
    return resolveStructuredTargetExecution(debuggerBackend, args.routine, args.routineArgs ?? []);
  }
  if (!args.sql) {
    throw new Error("Missing launch target. Provide either sql or routine.");
  }

  const parsed = await parseCall(args.sql, parser);
  if (!parsed.routine) {
    throw new Error(`Cannot parse function call from: ${args.sql}`);
  }

  const callArgs = await debuggerBackend.getCallArgs(parsed.schema ?? "public", parsed.routine);
  if (callArgs.length === 0) {
    throw new Error(`Function not found: ${parsed.schema ?? "public"}.${parsed.routine}`);
  }
  const candidates = groupRoutineCandidates(callArgs);
  const byArity = candidates.filter(
    (candidate) => candidate.argTypes.length === parsed.args.length,
  );
  const matches = byArity.length > 0 ? byArity : candidates;
  if (matches.length !== 1) {
    throw new Error(`Ambiguous routine target: ${parsed.schema ?? "public"}.${parsed.routine}`);
  }

  return {
    entryOid: matches[0].oid,
    queryText: args.sql,
    queryValues: [],
    routine: {
      oid: matches[0].oid,
      schema: parsed.schema,
      name: parsed.routine,
      kind: parsed.kind ?? "function",
    },
  };
}
