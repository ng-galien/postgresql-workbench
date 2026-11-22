import { createHash } from "node:crypto";
import {
  assertUsableSyntaxTree,
  decodeSqlIdentifier,
  directSyntaxChild,
  findSyntaxNode,
  syntaxNodeText,
} from "../../sql/src/analysis/syntaxNodes.js";
import type { SyntaxNode, SyntaxParser } from "../../sql/src/analysis/syntaxTree.js";
import {
  builtinVisible,
  type ExpressionContext,
  expressionTypeName,
  sqlName,
} from "./postgresExpressionContext.js";

/** Parser-proven layout equivalence; unrecognized signatures retain their original comparison. */
export async function expressionSignature(
  signature: string,
  kind: string,
  parser: SyntaxParser,
  context?: ExpressionContext,
): Promise<string> {
  let source: string;
  let target: string;
  let category: string;
  if (
    kind === "constraint" &&
    /^(?:constraint\s+(?:"(?:[^"]|"")*"|\S+)\s+)?check\s*\(/iu.test(signature)
  ) {
    source = `CREATE TABLE __proof (x integer, ${signature});`;
    target = "ConstraintElem";
    category = "check";
  } else if (kind === "constraint" && /^(default|generated)\s/iu.test(signature)) {
    source = `CREATE TABLE __proof (x integer ${signature});`;
    target = "ColConstraintElem";
    category = "attribute";
  } else if (kind === "index_predicate" && /^where\s/iu.test(signature)) {
    source = `SELECT ${signature.replace(/^where\s+/iu, "")};`;
    target = "a_expr";
    category = "predicate";
  } else if (kind === "index_key" && signature.startsWith("expression:")) {
    source = `SELECT ${signature.slice("expression:".length)};`;
    target = "a_expr";
    category = "key";
  } else {
    return signature;
  }
  const tree = await parser.parse({ language: "sql", source, namedOnly: false });
  assertUsableSyntaxTree(tree, "SQL structural signature");
  const node = findSyntaxNode(tree.root, target);
  if (!node) return signature;
  if (hasUnprovenOperatorGrouping(node)) return signature;
  const structure = JSON.stringify(canonicalNode(source, node, context));
  return `${category}:${createHash("sha256").update(structure).digest("hex")}`;
}

const IDENTIFIERS = new Set(["ColId", "ColLabel", "type_function_name"]);

/** tree-sitter-postgres 1.2.4 can group generic operators below =, < and >. */
function hasUnprovenOperatorGrouping(node: SyntaxNode): boolean {
  const children = node.children.filter((child) => child.kind !== "comment");
  if (children.length === 3 && children[1].kind === "qual_Op") {
    for (const operand of [children[0], children[2]]) {
      const expression = expressionNode(operand);
      if (expression.children.length === 3 && ["=", "<", ">"].includes(expression.children[1].kind))
        return true;
    }
  }
  return children.some(hasUnprovenOperatorGrouping);
}

function canonicalNode(
  source: string,
  node: SyntaxNode,
  context?: ExpressionContext,
  expected?: string,
): unknown {
  if (IDENTIFIERS.has(node.kind)) {
    const text = syntaxNodeText(source, node);
    return [
      "identifier",
      text.startsWith('"')
        ? decodeSqlIdentifier(text)
        : text.replace(/[A-Z]/g, (letter) => letter.toLowerCase()),
    ];
  }
  const children = node.children.filter((child) => child.kind !== "comment");
  const membership = membershipExpression(source, node, context);
  if (membership) return membership;
  if (node.kind === "case_expr") {
    const type = caseResultType(source, node, context);
    return [
      "case_expr",
      ...children
        .filter(
          (child) =>
            !type || child.kind !== "case_default" || !isNullDefault(source, child, type, context),
        )
        .map((child) => canonicalNode(source, child, context)),
    ];
  }
  if (
    node.kind === "func_expr_common_subexpr" &&
    children[0]?.kind === "kw_nullif" &&
    children.length === 6
  ) {
    const type = builtinVisible("=", "operators", context)
      ? inferredType(source, children[2], context)
      : undefined;
    return [
      "nullif",
      canonicalNode(source, children[2], context),
      canonicalNode(source, children[4], context, type),
    ];
  }
  if (
    node.kind === "c_expr" &&
    children.length === 3 &&
    children[0].kind === "(" &&
    children[1].kind === "a_expr" &&
    children[2].kind === ")"
  ) {
    return canonicalNode(source, children[1], context, expected);
  }
  const cast =
    children.length === 3 && children[1].kind === "::" && children[2].kind === "Typename";
  if (cast) {
    const type = expressionTypeName(source, children[2], context);
    const literal = literalNode(children[0]);
    if (literal && type === expected && coercibleLiteral(literal, type, context))
      return ["literal", type, canonicalNode(source, literal)];
    return ["cast", type, canonicalNode(source, children[0], context)];
  }
  const literal = literalNode(node);
  if (literal && expected && coercibleLiteral(literal, expected, context))
    return ["literal", expected, canonicalNode(source, literal)];
  const call = functionCall(node);
  if (call) {
    const name = sqlName(source, call.name);
    const types = functionTypes(source, name, call.args, context);
    return [
      "call",
      canonicalNode(source, call.name, context),
      ...call.args.map((arg, index) =>
        canonicalNode(source, arg, context, types?.arguments[index]),
      ),
    ];
  }
  if (children.length === 3 && ["a_expr", "a_expr_prec", "b_expr"].includes(node.kind)) {
    const operator = syntaxNodeText(source, children[1]).toLowerCase();
    const left = inferredType(source, children[0], context);
    const right = inferredType(source, children[2], context);
    const visible = builtinVisible(operator, "operators", context);
    const comparison = visible && ["=", "<>", "<", ">", "<=", ">="].includes(operator);
    const text = visible && ["~", "!~", "~*", "!~*", "||"].includes(operator) && left === "text";
    const json = visible && ["->", "->>", "#>", "#>>"].includes(operator) && left === "jsonb";
    const leftExpected = comparison ? right : undefined;
    const rightExpected = comparison
      ? left
      : text
        ? "text"
        : json
          ? operator.startsWith("#")
            ? "text[]"
            : "text"
          : undefined;
    return [
      "expression",
      canonicalNode(source, children[0], context, leftExpected),
      canonicalNode(source, children[1], context),
      canonicalNode(source, children[2], context, rightExpected),
    ];
  }
  if (children.length === 1) return canonicalNode(source, children[0], context, expected);
  if (children.length === 0) {
    const text = syntaxNodeText(source, node);
    return [node.kind, node.kind.startsWith("kw_") ? text.toLowerCase() : text];
  }
  const kind = ["a_expr", "a_expr_prec", "b_expr"].includes(node.kind) ? "expression" : node.kind;
  return [
    kind,
    ...children.map((child) =>
      canonicalNode(
        source,
        child,
        context,
        node.kind === "ColConstraintElem" && children[0]?.kind === "kw_default"
          ? context?.expectedType
          : undefined,
      ),
    ),
  ];
}

function expressionNode(node: SyntaxNode): SyntaxNode {
  const children = node.children.filter((child) => child.kind !== "comment");
  if (
    node.kind === "c_expr" &&
    children.length === 3 &&
    children[0].kind === "(" &&
    children[1].kind === "a_expr" &&
    children[2].kind === ")"
  )
    return expressionNode(children[1]);
  if (
    [
      "a_expr",
      "a_expr_prec",
      "b_expr",
      "b_expr_prec",
      "c_expr",
      "AexprConst",
      "Sconst",
      "Iconst",
      "func_expr",
      "func_arg_expr",
    ].includes(node.kind) &&
    children.length === 1
  )
    return expressionNode(children[0]);
  return node;
}

function literalNode(node: SyntaxNode): SyntaxNode | undefined {
  const value = expressionNode(node);
  return ["string_literal", "integer_literal", "kw_null"].includes(value.kind) ? value : undefined;
}

function coercibleLiteral(node: SyntaxNode, type: string, context?: ExpressionContext): boolean {
  if (!knownScalarType(type, context)) return false;
  return (
    node.kind === "string_literal" ||
    node.kind === "kw_null" ||
    (node.kind === "integer_literal" && type === "numeric")
  );
}

function knownScalarType(type: string, context?: ExpressionContext): boolean {
  return (
    ["text", "text[]", "bool", "int2", "int4", "int8", "numeric", "jsonb", "bytea"].includes(
      type,
    ) || !!context?.enums.has(type)
  );
}

function functionCall(node: SyntaxNode): { name: SyntaxNode; args: SyntaxNode[] } | undefined {
  if (node.kind !== "func_application") return undefined;
  const children = node.children.filter((child) => child.kind !== "comment");
  if (
    children.length !== 4 ||
    children[0].kind !== "func_name" ||
    children[1].kind !== "(" ||
    children[2].kind !== "func_arg_list" ||
    children[3].kind !== ")"
  )
    return undefined;
  const args: SyntaxNode[] = [];
  const collect = (list: SyntaxNode) => {
    if (list.kind === "func_arg_expr") args.push(list);
    else for (const child of list.children) collect(child);
  };
  collect(children[2]);
  if (args.some((arg) => arg.children.length !== 1 || arg.children[0].kind !== "a_expr"))
    return undefined;
  return { name: children[0], args };
}

function functionTypes(
  source: string,
  name: string,
  args: SyntaxNode[],
  context?: ExpressionContext,
): { result: string; arguments: string[] } | undefined {
  if (!builtinVisible(name, "functions", context)) return undefined;
  const input = args.map((arg) => inferredType(source, arg, context));
  if (
    ["jsonb_typeof", "jsonb_array_length"].includes(name) &&
    input[0] === "jsonb" &&
    args.length === 1
  )
    return { result: name === "jsonb_typeof" ? "text" : "int4", arguments: ["jsonb"] };
  if (name === "btrim" && input[0] === "text" && args.length === 1)
    return { result: "text", arguments: ["text"] };
  if (name === "sha256" && input[0] === "bytea" && args.length === 1)
    return { result: "bytea", arguments: ["bytea"] };
  if (name === "encode" && input[0] === "bytea" && args.length === 2)
    return { result: "text", arguments: ["bytea", "text"] };
  return undefined;
}

function inferredType(
  source: string,
  original: SyntaxNode,
  context?: ExpressionContext,
): string | undefined {
  const node = expressionNode(original);
  if (node.kind === "columnref") {
    const column = directSyntaxChild(node, "ColId");
    return column && node.children.length === 1
      ? context?.columns.get(sqlName(source, column))
      : undefined;
  }
  const children = node.children.filter((child) => child.kind !== "comment");
  if (node.kind === "func_expr_common_subexpr" && children[0]?.kind === "kw_extract")
    return "numeric";
  if (children.length === 3 && children[1].kind === "::" && children[2].kind === "Typename")
    return expressionTypeName(source, children[2], context);
  const call = functionCall(node);
  if (call) return functionTypes(source, sqlName(source, call.name), call.args, context)?.result;
  if (children.length === 3) {
    const op = syntaxNodeText(source, children[1]);
    const left = inferredType(source, children[0], context);
    if (builtinVisible(op, "operators", context)) {
      if (left === "jsonb" && ["->", "#>", "->>", "#>>"].includes(op))
        return op.endsWith(">>") ? "text" : "jsonb";
      if (left === "text" && op === "||") return "text";
    }
  }
  return undefined;
}

function listElements(node: SyntaxNode, kind: string): SyntaxNode[] {
  if (node.kind === kind) return [node];
  return node.children.flatMap((child) => listElements(child, kind));
}

function membershipExpression(
  source: string,
  node: SyntaxNode,
  context?: ExpressionContext,
): unknown[] | undefined {
  const children = node.children.filter((child) => child.kind !== "comment");
  let left: SyntaxNode;
  let values: SyntaxNode[];
  if (
    node.kind === "a_expr" &&
    children.length === 5 &&
    children[1].kind === "kw_in" &&
    children[2].kind === "(" &&
    children[3].kind === "expr_list" &&
    children[4].kind === ")"
  ) {
    left = children[0];
    values = listElements(children[3], "a_expr");
  } else if (children.length === 3 && children[1].kind === "=") {
    const call = functionCall(expressionNode(children[2]));
    if (call?.args.length !== 1) return undefined;
    const quantifier =
      findSyntaxNode(call.name, "kw_any") ?? findSyntaxNode(call.name, "identifier");
    if (
      !quantifier ||
      syntaxNodeText(source, quantifier).toLowerCase() !== "any" ||
      quantifier.byteRange[0] !== call.name.byteRange[0] ||
      quantifier.byteRange[1] !== call.name.byteRange[1]
    )
      return undefined;
    const array = expressionNode(call.args[0]);
    if (array.kind !== "c_expr" || array.children[0]?.kind !== "kw_array") return undefined;
    const list = findSyntaxNode(array, "expr_list");
    if (!list) return undefined;
    left = children[0];
    values = listElements(list, "a_expr");
  } else return undefined;
  const type = inferredType(source, left, context);
  if (
    !type ||
    (type !== "text" && !context?.enums.has(type)) ||
    !builtinVisible("=", "operators", context)
  )
    return undefined;
  if (
    values.some((value) => {
      const node = expressionNode(value);
      return (
        !literalNode(node) && !(node.children[1]?.kind === "::" && literalNode(node.children[0]))
      );
    })
  )
    return undefined;
  return [
    "membership",
    canonicalNode(source, left, context),
    ...values.map((value) => canonicalNode(source, value, context, type)),
  ];
}

function caseResultType(
  source: string,
  node: SyntaxNode,
  context?: ExpressionContext,
): string | undefined {
  const clauses = directSyntaxChild(node, "when_clause_list");
  if (!clauses) return undefined;
  const types = listElements(clauses, "when_clause").map((clause) => {
    const expressions = clause.children.filter((child) => child.kind === "a_expr");
    return expressions.length === 2 ? inferredType(source, expressions[1], context) : undefined;
  });
  return types.length &&
    types[0] &&
    knownScalarType(types[0], context) &&
    types.every((type) => type === types[0])
    ? types[0]
    : undefined;
}

function isNullDefault(
  source: string,
  node: SyntaxNode,
  type: string,
  context?: ExpressionContext,
): boolean {
  const expression = directSyntaxChild(node, "a_expr");
  if (!expression) return false;
  const value = expressionNode(expression);
  if (value.kind === "kw_null") return true;
  return (
    value.children.length === 3 &&
    value.children[1].kind === "::" &&
    literalNode(value.children[0])?.kind === "kw_null" &&
    expressionTypeName(source, value.children[2], context) === type
  );
}
