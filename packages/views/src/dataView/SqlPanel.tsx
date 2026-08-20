import { useEffect, useState } from "react";
import { IconButton } from "../results/IconButton.js";
import {
  type HighlightedPostgresSource,
  highlightPostgresSource,
  plainPostgresSource,
} from "../source/highlight.js";
import { PostgresSourceView } from "../source/PostgresSourceView.js";

/**
 * The SQL the view is running, read in the view. It opens and closes where the reader is, instead
 * of in an editor window they have to come back from, and it is coloured by the same highlighter
 * the Cockpit reads sources with.
 */
export function SqlPanel({ sql, onClose }: { sql: string; onClose: () => void }) {
  const [source, setSource] = useState<HighlightedPostgresSource>(() => plainSql(sql));

  useEffect(() => {
    let current = true;
    // Plain first, coloured when the highlighter answers: the SQL is readable either way.
    setSource(plainSql(sql));
    void highlightPostgresSource(sqlLines(sql)).then((highlighted) => {
      if (current) setSource(highlighted);
    });
    return () => {
      current = false;
    };
  }, [sql]);

  return (
    <section className="data-view-sql" aria-label="Query SQL">
      <header className="data-view-sql-bar">
        <span className="data-view-sql-title">SQL</span>
        <IconButton icon="close" label="Hide the SQL" onClick={onClose} />
      </header>
      <div className="data-view-sql-body">
        <PostgresSourceView source={source} />
      </div>
    </section>
  );
}

function sqlLines(sql: string): { number: number; text: string }[] {
  return sql.split("\n").map((text, index) => ({ number: index + 1, text }));
}

function plainSql(sql: string): HighlightedPostgresSource {
  return plainPostgresSource(sqlLines(sql));
}
