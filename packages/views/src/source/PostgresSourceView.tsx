import type { CSSProperties } from "react";
import type { HighlightedPostgresSource, PostgresSourceToken } from "./highlight.js";

type TokenProperties = CSSProperties & {
  "--postgres-token-light"?: string;
  "--postgres-token-dark"?: string;
};

function postgresTokenProperties(lightColor?: string, darkColor?: string): TokenProperties {
  return {
    "--postgres-token-light": lightColor,
    "--postgres-token-dark": darkColor,
  };
}

/**
 * One piece of coloured source: what the grammar gave it, and the class the language server's name
 * for it is painted with. Every surface that draws PostgreSQL text draws it through here, so a
 * statement in a panel, in a preview and behind the filter field are coloured by one rule.
 */
export function PostgresToken({ token }: { token: PostgresSourceToken }) {
  return (
    <span
      className={
        token.className ? `postgres-source-token ${token.className}` : "postgres-source-token"
      }
      style={postgresTokenProperties(token.lightColor, token.darkColor)}
    >
      {token.text}
    </span>
  );
}

export function PostgresSourceView({ source }: { source: HighlightedPostgresSource }) {
  return (
    <section
      className="postgres-source-view"
      data-source-highlighted={source.highlighted ? "true" : "false"}
      aria-label="PostgreSQL source code"
    >
      {source.lines.map((line) => (
        <div className="postgres-source-line" data-source-line={line.number} key={line.number}>
          <span className="postgres-source-line-number" aria-hidden="true">
            {line.number}
          </span>
          <code className="postgres-source-line-code">
            {line.tokens.map((token) => (
              <PostgresToken token={token} key={`${line.number}:${token.offset}`} />
            ))}
          </code>
        </div>
      ))}
    </section>
  );
}
