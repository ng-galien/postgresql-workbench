import type { Client } from "pg";
import type { PlApiStackVariable } from "../types.js";

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

function variableSelect(variable: PlApiStackVariable): string {
  const isNull = variable.value.value.toUpperCase() === "NULL";
  const realType = variable.value.isText
    ? "text"
    : variable.value.type === "record"
      ? "text"
      : variable.value.type;
  const escaped = escapeSqlLiteral(variable.value.value);
  const escapedName = escapeSqlLiteral(variable.value.name);
  const escapedType = escapeSqlLiteral(variable.value.type);
  const escapedKind = escapeSqlLiteral(variable.value.kind);
  const escapedArrayType = escapeSqlLiteral(variable.value.arrayType);
  const realValue = `('${escaped}'::${realType})`;

  let jsonValue = `${realValue}::text`;
  let prettyValue = jsonValue;
  if (variable.value.isArray || variable.value.kind === "c") {
    jsonValue = `to_json${realValue}::text`;
    prettyValue = `jsonb_pretty(to_jsonb${realValue})`;
  }
  if (isNull) {
    jsonValue = "'NULL'";
    prettyValue = "'NULL'";
  }

  return (
    `SELECT ${variable.isArg} AS is_arg,${variable.line} AS line,${variable.value.oid} AS oid,` +
    `'${escapedName}' AS name,'${escapedType}' AS type,'${escapedKind}' AS kind,` +
    `${variable.value.isArray} AS is_array,${variable.value.isText} AS is_text,` +
    `'${escapedArrayType}' AS array_type,${jsonValue} AS value, ${prettyValue} AS pretty`
  );
}

function mapVariables(rows: Record<string, unknown>[]): PlApiStackVariable[] {
  return rows.map((row, index) => ({
    varNo: index,
    isArg: Boolean(row.is_arg),
    line: Number(row.line),
    value: {
      oid: Number(row.oid),
      name: String(row.name ?? ""),
      type: String(row.type ?? "text"),
      kind: String(row.kind ?? "b"),
      isArray: Boolean(row.is_array),
      isText: Boolean(row.is_text),
      arrayType: String(row.array_type ?? "text"),
      value: String(row.value ?? "NULL"),
      pretty: String(row.pretty ?? ""),
    },
  }));
}

export async function readVariables(
  client: Client,
  session: number,
  rawVariablesSql: string,
): Promise<PlApiStackVariable[]> {
  const result = await client.query(rawVariablesSql, [session]);
  const rawVariables = mapVariables(result.rows);
  if (rawVariables.length === 0) return rawVariables;

  const unionQuery = `${rawVariables.map(variableSelect).join("\nUNION ALL\n")};`;
  try {
    const jsonResult = await client.query(unionQuery);
    return mapVariables(jsonResult.rows);
  } catch {
    return rawVariables;
  }
}
