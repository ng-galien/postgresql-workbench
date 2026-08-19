import type { CSSProperties } from "react";
import type { HighlightedPostgresSource } from "../graph/highlight.js";
import "../PostgresSourceView.css";

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
              <span
                className="postgres-source-token"
                style={postgresTokenProperties(token.lightColor, token.darkColor)}
                key={`${line.number}:${token.offset}`}
              >
                {token.text}
              </span>
            ))}
          </code>
        </div>
      ))}
    </section>
  );
}
