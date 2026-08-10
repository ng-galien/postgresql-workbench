import type { Client } from "pg";
import type { FunctionDefinition } from "../../src/callParser.js";

export type RoutineSourceComparison = "identical" | "different" | "unavailable";

export function routineRegprocedureIdentity(definition: FunctionDefinition): string {
  const qualifiedName = definition.schema
    ? `${quoteIdentifier(definition.schema)}.${quoteIdentifier(definition.name)}`
    : quoteIdentifier(definition.name);
  return `${qualifiedName}(${definition.params.map((param) => param.type).join(", ")})`;
}

export async function compareRoutineSource(
  localBody: string | undefined,
  deployedBody: string | undefined,
): Promise<RoutineSourceComparison> {
  if (localBody === undefined || deployedBody === undefined) {
    return "unavailable";
  }
  return normalizeRoutineBody(localBody) === normalizeRoutineBody(deployedBody)
    ? "identical"
    : "different";
}

export async function resolveRoutineOid(
  client: Client,
  identity: string,
): Promise<number | undefined> {
  const result = await client.query<{ oid: string | null }>(
    "SELECT to_regprocedure($1)::oid::bigint::text AS oid",
    [identity],
  );
  const value = result.rows[0]?.oid;
  if (value === null || value === undefined) return undefined;
  const oid = Number(value);
  return Number.isSafeInteger(oid) && oid >= 0 ? oid : undefined;
}

function normalizeRoutineBody(body: string): string {
  const lines = body.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  while (lines[0]?.trim() === "") {
    lines.shift();
  }
  while (lines.at(-1)?.trim() === "") {
    lines.pop();
  }
  const indentation = lines
    .filter((line) => line.trim())
    .reduce((minimum, line) => Math.min(minimum, leadingIndentationLength(line)), Infinity);
  const normalizedIndentation = Number.isFinite(indentation) ? indentation : 0;
  return lines
    .map((line) => line.slice(Math.min(normalizedIndentation, line.length)).trimEnd())
    .join("\n");
}

function leadingIndentationLength(line: string): number {
  let length = 0;
  while (line[length] === " " || line[length] === "\t") {
    length += 1;
  }
  return length;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
