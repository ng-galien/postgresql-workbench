import { Buffer } from "node:buffer";
import type { SyntaxNode, SyntaxTree } from "./syntaxTree.js";

export function syntaxNodeText(source: string, node: SyntaxNode): string {
  return Buffer.from(source, "utf8")
    .subarray(node.byteRange[0], node.byteRange[1])
    .toString("utf8");
}

export function directSyntaxChild(node: SyntaxNode, kind: string): SyntaxNode | undefined {
  return node.children.find((child) => child.kind === kind);
}

export function directSyntaxChildren(node: SyntaxNode, kind: string): SyntaxNode[] {
  return node.children.filter((child) => child.kind === kind);
}

export function findSyntaxNode(node: SyntaxNode, kind: string): SyntaxNode | undefined {
  if (node.kind === kind) return node;
  for (const child of node.children) {
    const found = findSyntaxNode(child, kind);
    if (found) return found;
  }
  return undefined;
}

export function findSyntaxNodes(
  node: SyntaxNode,
  kind: string,
  result: SyntaxNode[] = [],
): SyntaxNode[] {
  if (node.kind === kind) result.push(node);
  for (const child of node.children) findSyntaxNodes(child, kind, result);
  return result;
}

export function syntaxTreeHasKind(node: SyntaxNode, kinds: ReadonlySet<string>): boolean {
  if (kinds.has(node.kind)) return true;
  return node.children.some((child) => syntaxTreeHasKind(child, kinds));
}

/** Thrown when a syntax tree is truncated or contains syntax errors. */
export class UnusableSyntaxTreeError extends Error {
  constructor(
    message: string,
    readonly cause: "truncated" | "syntax-error",
  ) {
    super(message);
    this.name = "UnusableSyntaxTreeError";
  }
}

export function assertUsableSyntaxTree(syntax: SyntaxTree, language: string): void {
  if (syntax.truncated) {
    throw new UnusableSyntaxTreeError(
      `Code Moniker returned a truncated ${language} syntax tree`,
      "truncated",
    );
  }
  if (syntax.hasError) {
    throw new UnusableSyntaxTreeError(`${language} source contains syntax errors`, "syntax-error");
  }
}

export function decodeSqlIdentifier(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) return trimmed;
  let decoded = "";
  for (let index = 1; index < trimmed.length - 1; index++) {
    if (trimmed[index] === '"' && trimmed[index + 1] === '"') index++;
    decoded += trimmed[index];
  }
  return decoded;
}

export function syntaxIdentifierParts(source: string, node: SyntaxNode): string[] {
  const parts: string[] = [];
  const first = directSyntaxChild(node, "ColId");
  if (first) parts.push(decodeSqlIdentifier(syntaxNodeText(source, first)));
  for (const attribute of findSyntaxNodes(node, "attr_name")) {
    parts.push(decodeSqlIdentifier(syntaxNodeText(source, attribute)));
  }
  return parts.length > 0 ? parts : [decodeSqlIdentifier(syntaxNodeText(source, node))];
}

export function canonicalSqlTypeName(value: string): string {
  let typeName = value.trim();
  let arraySuffix = "";
  while (typeName.endsWith("[]")) {
    typeName = typeName.slice(0, -2).trimEnd();
    arraySuffix += "[]";
  }
  const aliases: Record<string, string> = {
    int: "int4",
    integer: "int4",
    smallint: "int2",
    bigint: "int8",
    boolean: "bool",
    real: "float4",
    "double precision": "float8",
    decimal: "numeric",
  };
  return `${aliases[typeName.toLowerCase()] ?? typeName}${arraySuffix}`;
}

export function decodeSqlLiteral(value: string): string {
  if (value.startsWith("$")) {
    const delimiterEnd = value.indexOf("$", 1);
    if (delimiterEnd < 0) throw new Error("Invalid dollar-quoted SQL literal");
    const delimiter = value.slice(0, delimiterEnd + 1);
    if (!value.endsWith(delimiter)) throw new Error("Unterminated dollar-quoted SQL literal");
    return value.slice(delimiter.length, value.length - delimiter.length);
  }

  const firstQuote = value.indexOf("'");
  const lastQuote = value.lastIndexOf("'");
  if (firstQuote < 0 || lastQuote <= firstQuote) return value;
  const escapeSyntax = value.slice(0, firstQuote).trim().toLowerCase() === "e";
  let decoded = "";
  for (let index = firstQuote + 1; index < lastQuote; index++) {
    if (value[index] === "'" && value[index + 1] === "'") {
      decoded += "'";
      index++;
    } else if (escapeSyntax && value[index] === "\\" && index + 1 < lastQuote) {
      const decodedEscape = decodeEscape(value, index + 1, lastQuote);
      decoded += decodedEscape.value;
      index = decodedEscape.lastIndex;
    } else {
      decoded += value[index];
    }
  }
  return decoded;
}

function decodeEscape(
  value: string,
  escapeIndex: number,
  literalEnd: number,
): { value: string; lastIndex: number } {
  const escaped = value[escapeIndex];
  const simpleEscapes: Record<string, string> = {
    b: "\b",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t",
  };
  if (simpleEscapes[escaped] !== undefined) {
    return { value: simpleEscapes[escaped], lastIndex: escapeIndex };
  }
  if (escaped >= "0" && escaped <= "7") {
    let digits = escaped;
    while (
      digits.length < 3 &&
      escapeIndex + digits.length < literalEnd &&
      value[escapeIndex + digits.length] >= "0" &&
      value[escapeIndex + digits.length] <= "7"
    ) {
      digits += value[escapeIndex + digits.length];
    }
    return {
      value: String.fromCodePoint(Number.parseInt(digits, 8)),
      lastIndex: escapeIndex + digits.length - 1,
    };
  }
  const unicodeLength = escaped === "u" ? 4 : escaped === "U" ? 8 : 0;
  const hexadecimalLength = escaped === "x" ? 2 : unicodeLength;
  if (hexadecimalLength > 0) {
    let digits = "";
    const digitsStart = escapeIndex + 1;
    while (
      digits.length < hexadecimalLength &&
      digitsStart + digits.length < literalEnd &&
      isHexadecimal(value[digitsStart + digits.length])
    ) {
      digits += value[digitsStart + digits.length];
    }
    if (digits.length > 0 && (escaped === "x" || digits.length === unicodeLength)) {
      const codePoint = Number.parseInt(digits, 16);
      if (codePoint <= 0x10ffff) {
        return {
          value: String.fromCodePoint(codePoint),
          lastIndex: digitsStart + digits.length - 1,
        };
      }
    }
  }
  return { value: escaped, lastIndex: escapeIndex };
}

function isHexadecimal(value: string): boolean {
  const normalized = value.toLowerCase();
  return (value >= "0" && value <= "9") || (normalized >= "a" && normalized <= "f");
}
