import {
  canonicalSqlTypeName,
  decodeSqlLiteral,
  directSyntaxChild,
  findSyntaxNode,
  findSyntaxNodes,
  syntaxIdentifierParts,
  syntaxNodeText,
} from "./syntaxNodes.js";
import type { SyntaxNode } from "./syntaxTree.js";

export interface SqlRoutineParameter {
  name: string | null;
  type: string;
  mode: "in" | "out" | "inout" | "variadic" | "default" | "table";
}

export interface SqlFunctionApplication {
  node: SyntaxNode;
  nameParts: string[];
}

export function sqlRoutineLanguage(source: string, statement: SyntaxNode): string | undefined {
  for (const option of findSyntaxNodes(statement, "createfunc_opt_item")) {
    if (!findSyntaxNode(option, "kw_language")) continue;
    const value = option.children.find((child) => child.kind !== "kw_language");
    if (value) return decodeSqlLiteral(syntaxNodeText(source, value)).trim().toLowerCase();
  }
  return undefined;
}

export function sqlRoutineNameParts(source: string, statement: SyntaxNode): string[] {
  const nameNode = directSyntaxChild(statement, "func_name");
  return nameNode ? syntaxIdentifierParts(source, nameNode) : [];
}

export function sqlRoutineBodyLiteral(
  statement: SyntaxNode,
  isDoStatement = statement.kind === "DoStmt",
): SyntaxNode | undefined {
  if (isDoStatement) return sqlStringLiteral(statement);
  for (const option of findSyntaxNodes(statement, "createfunc_opt_item")) {
    if (findSyntaxNode(option, "kw_as")) return sqlStringLiteral(option);
  }
  return undefined;
}

export function sqlRoutineBody(source: string, statement: SyntaxNode): string | undefined {
  const literal = sqlRoutineBodyLiteral(statement);
  return literal ? decodeSqlLiteral(syntaxNodeText(source, literal)) : undefined;
}

export function sqlRoutineParameters(source: string, statement: SyntaxNode): SqlRoutineParameter[] {
  const defaultArguments = new Set(
    findSyntaxNodes(statement, "func_arg_with_default")
      .filter(
        (wrapper) =>
          findSyntaxNode(wrapper, "kw_default") !== undefined ||
          directSyntaxChild(wrapper, "=") !== undefined,
      )
      .map((wrapper) => findSyntaxNode(wrapper, "func_arg"))
      .filter((argument): argument is SyntaxNode => argument !== undefined),
  );
  return findSyntaxNodes(statement, "func_arg").flatMap((argument) => {
    const modeNode = directSyntaxChild(argument, "arg_class");
    const modeText = modeNode ? syntaxNodeText(source, modeNode).trim().toLowerCase() : "in";
    const typeNode = findSyntaxNode(argument, "func_type");
    if (!typeNode) return [];
    const mode: SqlRoutineParameter["mode"] =
      modeText === "out" || modeText === "table" || modeText === "inout" || modeText === "variadic"
        ? modeText
        : defaultArguments.has(argument)
          ? "default"
          : "in";
    const nameNode = findSyntaxNode(argument, "param_name");
    return [
      {
        name: nameNode ? (syntaxIdentifierParts(source, nameNode).at(-1) ?? null) : null,
        type: canonicalSqlTypeName(syntaxNodeText(source, typeNode)),
        mode,
      },
    ];
  });
}

export function preferredSqlCallApplication(statement: SyntaxNode): SyntaxNode | undefined {
  const call = findWithinStatement(statement, "CallStmt");
  if (call) return findWithinStatement(call, "func_application");
  const select = findWithinStatement(statement, "SelectStmt");
  if (!select) return undefined;
  const from = findWithinStatement(select, "from_clause");
  const fromApplication = from ? findWithinStatement(from, "func_application") : undefined;
  if (fromApplication) return fromApplication;
  const targets = findWithinStatement(select, "opt_target_list");
  return targets ? findWithinStatement(targets, "func_application") : undefined;
}

export function sqlFunctionNameParts(source: string, application: SyntaxNode): string[] {
  const nameNode =
    directSyntaxChild(application, "func_name") ?? findSyntaxNode(application, "func_name");
  return nameNode ? syntaxIdentifierParts(source, nameNode) : [];
}

export function sqlFunctionApplications(
  source: string,
  node: SyntaxNode,
): SqlFunctionApplication[] {
  return findSyntaxNodes(node, "func_application").flatMap((application) => {
    const nameParts = sqlFunctionNameParts(source, application);
    return nameParts.length > 0 ? [{ node: application, nameParts }] : [];
  });
}

function sqlStringLiteral(node: SyntaxNode): SyntaxNode | undefined {
  return (
    findSyntaxNode(node, "dollar_quoted_string") ??
    findSyntaxNode(node, "escape_string_literal") ??
    findSyntaxNode(node, "string_literal")
  );
}

function findWithinStatement(node: SyntaxNode, kind: string): SyntaxNode | undefined {
  if (node.kind === kind) return node;
  for (const child of node.children) {
    if ((child.kind === "SelectStmt" || child.kind === "CallStmt") && child.kind !== kind) {
      continue;
    }
    const found = findWithinStatement(child, kind);
    if (found) return found;
  }
  return undefined;
}
