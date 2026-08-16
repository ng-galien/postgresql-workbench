import { planSqlResultExecution } from "../../src/analysis/sqlStatements.js";
import { canonicalSqlTypeName } from "../../src/analysis/syntaxNodes.js";
import type { SyntaxParser } from "../../src/analysis/syntaxTree.js";
import { parseSqlDefinitions } from "../../src/callParser.js";
import type { SqlAuthoringSnapshot } from "./sqlAuthoring/protocol.js";

export interface ManagedRoutineBinding {
  serverId: string;
  database: string;
  schema: string;
  oid: number;
  name: string;
  documentKind: string;
  symbolKind: string;
  plpgsql: boolean;
  content: string;
}

export type ManagedRoutineDeploymentValidation =
  | { status: "valid" }
  | { status: "rejected"; message: string };

export async function validateManagedRoutineDeployment(
  sql: string,
  binding: ManagedRoutineBinding,
  snapshot: SqlAuthoringSnapshot | undefined,
  parser: SyntaxParser,
): Promise<ManagedRoutineDeploymentValidation> {
  if (!binding.plpgsql || binding.documentKind !== "routine") {
    return { status: "rejected", message: "Only managed PL/pgSQL routines can be deployed" };
  }
  const plan = await planSqlResultExecution(sql, parser);
  const definitions = await parseSqlDefinitions(sql, parser);
  const definition = definitions[0];
  const deployedDefinitions = await parseSqlDefinitions(binding.content, parser);
  const deployedDefinition = deployedDefinitions.find(
    (candidate) =>
      candidate.kind === binding.symbolKind &&
      candidate.schema === binding.schema &&
      candidate.name === binding.name,
  );
  if (
    plan.status !== "ready" ||
    plan.statements.length !== 1 ||
    definitions.length !== 1 ||
    !definition?.sourceSql ||
    !/^CREATE\s+OR\s+REPLACE\s+/iu.test(definition.sourceSql)
  ) {
    return {
      status: "rejected",
      message: "Deploy requires exactly one valid CREATE OR REPLACE PL/pgSQL routine",
    };
  }
  const bound = snapshot?.objects.find(
    (object) => object.oid === binding.oid && object.kind === binding.symbolKind,
  );
  const inputTypes = definition.params.map((parameter) => canonicalSqlTypeName(parameter.type));
  const boundTypes = bound?.parameters.map((parameter) => canonicalSqlTypeName(parameter.type));
  const deployedModes = deployedDefinition?.params.map((parameter) =>
    parameter.mode === "default" ? "in" : parameter.mode,
  );
  const inputModes = definition.params.map((parameter) =>
    parameter.mode === "default" ? "in" : parameter.mode,
  );
  if (
    snapshot?.status !== "available" ||
    snapshot.serverId !== binding.serverId ||
    snapshot.database !== binding.database ||
    !bound ||
    definition.kind !== binding.symbolKind ||
    definition.schema !== binding.schema ||
    definition.name !== binding.name ||
    !deployedDefinition ||
    inputTypes.length !== boundTypes?.length ||
    inputTypes.some((type, index) => type !== boundTypes[index]) ||
    inputModes.length !== deployedModes?.length ||
    inputModes.some((mode, index) => mode !== deployedModes[index])
  ) {
    return {
      status: "rejected",
      message: "The working copy no longer matches the managed routine identity and signature",
    };
  }
  return { status: "valid" };
}
