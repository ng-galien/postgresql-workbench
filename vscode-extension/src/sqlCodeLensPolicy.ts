import { canonicalSqlTypeName } from "../../src/analysis/syntaxNodes.js";
import type { FunctionDefinition, ParsedCallSite } from "../../src/callParser.js";
import type { SqlAuthoringObject, SqlAuthoringSnapshot } from "./sqlAuthoring/protocol.js";

/** Debug eligibility of one analyzed SQL entry point, with the single blocking cause. */
export type SqlDebugAvailability =
  | { status: "available" }
  | { status: "unavailable"; reason: SqlDebugUnavailableReason };

export type SqlDebugUnavailableReason =
  | "Index missing"
  | "Index stale"
  | "Routine not indexed"
  | "Several overloads match"
  | "Not a PL/pgSQL routine"
  | "Call depends on a row value or parameter";

export function shouldProvideSqlCodeLenses(uriScheme: string): boolean {
  return uriScheme !== "vscode-notebook-cell";
}

function unavailable(reason: SqlDebugUnavailableReason): SqlDebugAvailability {
  return { status: "unavailable", reason };
}

function availabilityOfCandidates(
  snapshot: SqlAuthoringSnapshot | undefined,
  select: (objects: SqlAuthoringObject[]) => SqlAuthoringObject[],
): SqlDebugAvailability {
  if (!snapshot) return unavailable("Index missing");
  if (snapshot.status !== "available") return unavailable("Index stale");
  const candidates = select(snapshot.objects);
  if (candidates.length === 0) return unavailable("Routine not indexed");
  if (candidates.length > 1) return unavailable("Several overloads match");
  return candidates[0]?.plpgsql === true
    ? { status: "available" }
    : unavailable("Not a PL/pgSQL routine");
}

export function debuggableSqlCall(
  snapshot: SqlAuthoringSnapshot | undefined,
  call: ParsedCallSite,
): SqlDebugAvailability {
  const expectedKind = call.kind === "call" ? "procedure" : "function";
  const resolved = availabilityOfCandidates(snapshot, (objects) =>
    objects.filter(
      (object) =>
        object.kind === expectedKind &&
        object.name === call.routine &&
        (call.schema === null || object.schema === call.schema) &&
        object.parameters.length === call.args.length,
    ),
  );
  if (resolved.status === "available" && !call.isLaunchable) {
    return unavailable("Call depends on a row value or parameter");
  }
  return resolved;
}

export function debuggableSqlDefinition(
  snapshot: SqlAuthoringSnapshot | undefined,
  definition: FunctionDefinition,
): SqlDebugAvailability {
  const inputTypes = definition.params.map((parameter) => canonicalSqlTypeName(parameter.type));
  return availabilityOfCandidates(snapshot, (objects) =>
    objects.filter(
      (object) =>
        object.kind === definition.kind &&
        object.name === definition.name &&
        (definition.schema === null || object.schema === definition.schema) &&
        object.parameters.length === inputTypes.length &&
        object.parameters.every(
          (parameter, index) => canonicalSqlTypeName(parameter.type) === inputTypes[index],
        ),
    ),
  );
}

export function hasDebuggableSqlCall(
  snapshot: SqlAuthoringSnapshot | undefined,
  call: ParsedCallSite,
): boolean {
  return debuggableSqlCall(snapshot, call).status === "available";
}

export function hasDebuggableSqlDefinition(
  snapshot: SqlAuthoringSnapshot | undefined,
  definition: FunctionDefinition,
): boolean {
  return debuggableSqlDefinition(snapshot, definition).status === "available";
}
