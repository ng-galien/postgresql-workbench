/** Shared PostgreSQL syntax primitives. This module depends on no parser tree, shape, or feature. */
export type SyntaxLanguage = "sql" | "plpgsql";

export interface PostgresShapeRange {
  start: number;
  end: number;
}

/** Portable identity of the exact UTF-16 text used by one syntax analysis. */
export interface PostgresAnalysisIdentity {
  algorithm: "fnv1a64-utf16";
  value: string;
  length: number;
}

/**
 * Computes a deterministic content identity without depending on Node.js or a host runtime.
 * This is a consistency check between immutable analysis products, not a security primitive.
 */
export function postgresAnalysisIdentity(source: string): PostgresAnalysisIdentity {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= BigInt(source.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return {
    algorithm: "fnv1a64-utf16",
    value: hash.toString(16).padStart(16, "0"),
    length: source.length,
  };
}

export type PostgresSqlSyntaxTarget = {
  language: "sql";
  entryPoint: "script" | "statement" | "expression";
};

export type PlpgsqlSyntaxTarget = {
  language: "plpgsql";
  entryPoint: "block";
};

/** The grammar entry point proven for one language region. SQL and PL/pgSQL stay disjoint. */
export type PostgresSyntaxTarget = PostgresSqlSyntaxTarget | PlpgsqlSyntaxTarget;
