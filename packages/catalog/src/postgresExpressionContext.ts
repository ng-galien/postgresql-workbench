import {
  canonicalSqlTypeName,
  decodeSqlIdentifier,
  directSyntaxChild,
  findSyntaxNode,
  findSyntaxNodes,
  syntaxNodeText,
} from "../../sql/src/analysis/syntaxNodes.js";
import type { SyntaxNode, SyntaxParser } from "../../sql/src/analysis/syntaxTree.js";
import {
  postgresStatementDeclarations,
  postgresStatementTrees,
} from "./postgresSyntaxStatements.js";

export interface ExpressionContext {
  columns: ReadonlyMap<string, string>;
  searchPath: readonly string[];
  enums: ReadonlySet<string>;
  expectedType?: string;
  resolution: {
    schemas: Set<string>;
    functions: Set<string>;
    types: Set<string>;
    unknownFunctions: boolean;
    operators: boolean;
  };
}

export interface ExpressionContexts {
  tables: Map<string, ExpressionContext>;
  indexes: Map<string, string>;
  limitations: string[];
}

const DECLARATIVE_CONTEXT_STATEMENTS = new Set([
  "CreateStmt",
  "CreateSchemaStmt",
  "IndexStmt",
  "DefineStmt",
  "CreateDomainStmt",
  "ViewStmt",
  "CreateFunctionStmt",
  "CreateTrigStmt",
  "CommentStmt",
  "VariableSetStmt",
]);

export async function readExpressionContexts(
  source: string,
  parser: SyntaxParser,
): Promise<ExpressionContexts> {
  const statements = await postgresStatementTrees(source, parser, [
    "CreateStmt",
    "CreateSchemaStmt",
    "IndexStmt",
    "DefineStmt",
    "CreateDomainStmt",
    "ViewStmt",
    "VariableSetStmt",
  ]);
  const result: ExpressionContexts = { tables: new Map(), indexes: new Map(), limitations: [] };
  const enums = new Set<string>();
  const resolution: ExpressionContext["resolution"] = {
    schemas: new Set(),
    functions: new Set(),
    types: new Set(),
    unknownFunctions: false,
    operators: false,
  };
  const headers = await parser.parse({
    language: "sql",
    source,
    namedOnly: false,
    maxDepth: 8,
    maxNodes: 40_000,
  });
  for (const declaration of postgresStatementDeclarations(Buffer.from(source), headers.root)) {
    if (!DECLARATIVE_CONTEXT_STATEMENTS.has(declaration.kind)) {
      result.limitations.push(
        `Expression context is not proven for ${declaration.kind} at byte ${declaration.byteRange[0]}`,
      );
    }
  }
  for (const statement of statements) {
    for (const declaration of postgresStatementDeclarations(
      Buffer.from(statement.source),
      statement.root,
    )) {
      const conditional = directSyntaxChild(declaration, "kw_if");
      const nestedSchema = directSyntaxChild(declaration, "OptSchemaEltList");
      const temporary = findSyntaxNode(declaration, "OptTemp");
      const variable =
        declaration.kind === "VariableSetStmt" && findSyntaxNode(declaration, "var_name");
      if (
        conditional ||
        temporary ||
        nestedSchema ||
        (declaration.kind === "VariableSetStmt" &&
          (!variable || sqlName(statement.source, variable) !== "search_path"))
      ) {
        result.limitations.push(
          `Expression context is not proven for this ${declaration.kind} variant at byte ${statement.offset + declaration.byteRange[0]}`,
        );
      }
    }
  }
  if (result.limitations.length) return result;
  resolution.unknownFunctions = headers.emittedNodes >= 40_000 || headers.hasError;
  for (const fn of findSyntaxNodes(headers.root, "CreateFunctionStmt")) {
    const name = directSyntaxChild(fn, "func_name");
    if (!name || !findSyntaxNode(name, "attr_name")) resolution.unknownFunctions = true;
    else resolution.functions.add(qualifiedName(source, name, []));
  }
  for (const statement of statements) {
    for (const schema of findSyntaxNodes(statement.root, "CreateSchemaStmt")) {
      const name =
        directSyntaxChild(schema, "ColId") ?? directSyntaxChild(schema, "opt_single_name");
      if (name && !directSyntaxChild(schema, "kw_if"))
        resolution.schemas.add(sqlName(statement.source, name));
    }
    for (const definition of [
      ...findSyntaxNodes(statement.root, "DefineStmt"),
      ...findSyntaxNodes(statement.root, "CreateDomainStmt"),
      ...findSyntaxNodes(statement.root, "CreateStmt"),
      ...findSyntaxNodes(statement.root, "ViewStmt"),
    ]) {
      if (directSyntaxChild(definition, "kw_operator")) resolution.operators = true;
      const name =
        directSyntaxChild(definition, "any_name") ??
        directSyntaxChild(definition, "qualified_name");
      if (name) {
        resolution.types.add(qualifiedName(statement.source, name, []));
        if (directSyntaxChild(definition, "kw_enum") && findSyntaxNode(name, "attr_name"))
          enums.add(qualifiedName(statement.source, name, []));
        if (!findSyntaxNode(name, "attr_name"))
          resolution.types.add(`*.${sqlName(statement.source, name)}`);
      }
    }
  }
  let searchPath = ["pg_catalog", "public"];
  let pathChanges = 0;
  for (const statement of statements) {
    const { source, root } = statement;
    const setting = findSyntaxNode(root, "VariableSetStmt");
    if (setting) {
      const variable = findSyntaxNode(setting, "var_name");
      if (variable && sqlName(source, variable) === "search_path") {
        pathChanges += 1;
        const values = findSyntaxNodes(setting, "var_value");
        searchPath =
          values.length && values.every((node) => !findSyntaxNode(node, "Sconst"))
            ? values.map((node) => sqlName(source, node))
            : ["<unresolved search_path>", "pg_catalog"];
      }
    }
    const definition = findSyntaxNode(root, "DefineStmt");
    if (definition && directSyntaxChild(definition, "kw_enum")) {
      const name = directSyntaxChild(definition, "any_name");
      if (name) enums.add(qualifiedName(source, name, searchPath));
    }
    for (const table of findSyntaxNodes(root, "CreateStmt")) {
      const name = directSyntaxChild(table, "qualified_name");
      if (!name) continue;
      const context: ExpressionContext = {
        columns: new Map(),
        enums,
        searchPath: [...searchPath],
        resolution,
      };
      const columns = new Map<string, string>();
      for (const column of findSyntaxNodes(table, "columnDef")) {
        const name = directSyntaxChild(column, "ColId");
        const type = directSyntaxChild(column, "Typename");
        if (name && type)
          columns.set(sqlName(source, name), expressionTypeName(source, type, context));
      }
      const tableName = qualifiedName(source, name, searchPath);
      if (JSON.parse(tableName)[0] === "pg_temp")
        result.limitations.push("Expression context is not proven for temporary-schema types");
      if (result.tables.has(tableName))
        result.limitations.push(`Expression context is ambiguous for table ${tableName}`);
      result.tables.set(tableName, { ...context, columns });
    }
    const index = findSyntaxNode(root, "IndexStmt");
    if (index) {
      const name = directSyntaxChild(index, "opt_single_name");
      const relation = directSyntaxChild(index, "relation_expr");
      const tableName = relation && directSyntaxChild(relation, "qualified_name");
      if (name && tableName) {
        const table = qualifiedName(source, tableName, searchPath);
        result.indexes.set(JSON.stringify([JSON.parse(table)[0], sqlName(source, name)]), table);
      }
    }
  }
  if (pathChanges > 1) {
    result.limitations.push("Expression context is not proven across multiple search_path changes");
  }
  return result;
}

export function contextForSymbol(
  contexts: ExpressionContexts,
  identity: string,
): ExpressionContext | undefined {
  const parts = new Map(
    identity.split("/").map((part) => {
      const colon = part.indexOf(":");
      return [part.slice(0, colon), decodeURIComponent(part.slice(colon + 1))];
    }),
  );
  const schema = parts.get("schema");
  const table = parts.get("table");
  const index = parts.get("index");
  const key = table
    ? JSON.stringify([schema, table])
    : index && contexts.indexes.get(JSON.stringify([schema, index]));
  const context = key ? contexts.tables.get(key) : undefined;
  if (!context) return undefined;
  const attribute = parts.get("constraint");
  const column = attribute?.replace(/\.(?:default|generated|not_null)$/u, "");
  return { ...context, expectedType: column ? context.columns.get(column) : undefined };
}

export function sqlName(source: string, node: SyntaxNode): string {
  const text = syntaxNodeText(source, node).trim();
  return text.startsWith('"')
    ? decodeSqlIdentifier(text)
    : text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

function qualifiedName(source: string, node: SyntaxNode, searchPath: readonly string[]): string {
  const names = qualifiedParts(source, node);
  return JSON.stringify(
    names.length === 1
      ? [searchPath.find((schema) => schema !== "pg_catalog") ?? "public", names[0]]
      : names,
  );
}

function qualifiedParts(source: string, node: SyntaxNode): string[] {
  const first = directSyntaxChild(node, "ColId") ?? directSyntaxChild(node, "type_function_name");
  const names = first
    ? [
        sqlName(source, first),
        ...findSyntaxNodes(node, "attr_name").map((part) => sqlName(source, part)),
      ]
    : [];
  return names;
}

export function expressionTypeName(
  source: string,
  node: SyntaxNode,
  context?: ExpressionContext,
): string {
  const text = syntaxNodeText(source, node).trim();
  const builtin = text.includes('"')
    ? text
    : canonicalSqlTypeName(text.toLowerCase().replace(/^pg_catalog\./u, ""));
  if (
    /^(text|text\[\]|bool|int[248]|numeric|jsonb|bytea)$/u.test(builtin) &&
    (text.toLowerCase().startsWith("pg_catalog.") ||
      !findSyntaxNode(node, "GenericType") ||
      builtinVisible(builtin.replace(/\[\]$/u, ""), "types", context))
  )
    return builtin;
  const generic = findSyntaxNode(node, "GenericType");
  if (
    findSyntaxNode(node, "opt_array_bounds") ||
    findSyntaxNode(node, "kw_array") ||
    findSyntaxNode(node, "kw_setof") ||
    findSyntaxNode(node, "opt_type_modifiers")
  )
    return `unresolved:${text}`;
  const parts = generic ? qualifiedParts(source, generic) : [];
  const key = JSON.stringify(parts);
  if (context?.enums.has(key)) return key;
  if (!context || parts.length !== 1) return `unresolved:${text}`;
  return (
    context.searchPath
      .map((schema) => JSON.stringify([schema, parts[0]]))
      .find((name) => context.enums.has(name)) ?? `unresolved:${text}`
  );
}

/** Unconditional CREATE SCHEMA starts an empty namespace; existing or unknown schemas fail closed. */
export function builtinVisible(
  name: string,
  category: "functions" | "types" | "operators",
  context?: ExpressionContext,
): boolean {
  if (!context) return false;
  if (category === "operators" && context.resolution.operators) return false;
  if (category === "functions" && context.resolution.unknownFunctions) return false;
  if (category === "types" && context.resolution.types.has(`*.${name}`)) return false;
  const catalog = context.searchPath.indexOf("pg_catalog");
  if (catalog === -1) return true;
  return context.searchPath
    .slice(0, catalog)
    .every(
      (schema) =>
        context.resolution.schemas.has(schema) &&
        (category === "operators" ||
          !context.resolution[category].has(JSON.stringify([schema, name]))),
    );
}
