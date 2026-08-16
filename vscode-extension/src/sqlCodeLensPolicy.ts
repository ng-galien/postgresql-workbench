import { canonicalSqlTypeName } from "../../src/analysis/syntaxNodes.js";
import type { FunctionDefinition, ParsedCallSite } from "../../src/callParser.js";
import type { SqlAuthoringSnapshot } from "./sqlAuthoring/protocol.js";

export function shouldProvideSqlCodeLenses(uriScheme: string): boolean {
  return uriScheme !== "vscode-notebook-cell";
}

export function hasDebuggableSqlCall(
  snapshot: SqlAuthoringSnapshot | undefined,
  call: ParsedCallSite,
): boolean {
  if (snapshot?.status !== "available") return false;
  const expectedKind = call.kind === "call" ? "procedure" : "function";
  const candidates = snapshot.objects.filter(
    (object) =>
      object.kind === expectedKind &&
      object.name === call.routine &&
      (call.schema === null || object.schema === call.schema) &&
      object.parameters.length === call.args.length,
  );
  return candidates.length === 1 && candidates[0]?.plpgsql === true;
}

export function hasDebuggableSqlDefinition(
  snapshot: SqlAuthoringSnapshot | undefined,
  definition: FunctionDefinition,
): boolean {
  if (snapshot?.status !== "available") return false;
  const inputTypes = definition.params.map((parameter) => canonicalSqlTypeName(parameter.type));
  const candidates = snapshot.objects.filter(
    (object) =>
      object.kind === definition.kind &&
      object.name === definition.name &&
      (definition.schema === null || object.schema === definition.schema) &&
      object.parameters.length === inputTypes.length &&
      object.parameters.every(
        (parameter, index) => canonicalSqlTypeName(parameter.type) === inputTypes[index],
      ),
  );
  return candidates.length === 1 && candidates[0]?.plpgsql === true;
}
