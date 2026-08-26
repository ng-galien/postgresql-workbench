import type { HighlightedPostgresSource, PostgresSourceToken } from "./highlight.js";

/**
 * One piece of coloured source: the class the language server's stream gave it, or nothing. Every
 * surface that draws PostgreSQL text draws it through here, so a statement in a panel, in a
 * preview and behind the filter field are coloured by one rule.
 */
export function PostgresToken({ token }: { token: PostgresSourceToken }) {
  return (
    <span
      className={
        token.className ? `postgres-source-token ${token.className}` : "postgres-source-token"
      }
    >
      {token.text}
    </span>
  );
}

export function PostgresSourceView({ source }: { source: HighlightedPostgresSource }) {
  return (
    <section className="postgres-source-view" aria-label="PostgreSQL source code">
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
