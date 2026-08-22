import { useEffect, useState } from "react";
import { useClipboardCopy } from "../clipboardCopy.js";
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
 * the Cockpit reads sources with. What is copied from here is that same statement, as written —
 * the query the rows below came from, ready to paste into an editor or a Scratchpad.
 */
export function SqlPanel({ sql, onClose }: { sql: string; onClose: () => void }) {
  const [source, setSource] = useState<HighlightedPostgresSource>(() => plainSql(sql));
  const clipboard = useClipboardCopy();

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
        <span className="codicon codicon-code" aria-hidden="true" />
        <span className="data-view-sql-title">SQL</span>
        <span className="data-view-sql-spacer" />
        <IconButton
          icon={COPY_ICON[clipboard.state]}
          label={COPY_LABEL[clipboard.state]}
          onClick={() => clipboard.copy(sql)}
        />
        <IconButton icon="close" label="Hide the SQL" onClick={onClose} />
        {/* A copy leaves the page as it was, so it is also said to a reader who cannot see it. */}
        <span className="sr-only" role="status" aria-live="polite">
          {clipboard.state === "idle" ? "" : COPY_LABEL[clipboard.state]}
        </span>
      </header>
      <div className="data-view-sql-body">
        <PostgresSourceView source={source} />
      </div>
    </section>
  );
}

/* What the copy control shows, and says, once it has an answer to give. */
const COPY_ICON = { idle: "copy", copied: "check", error: "error" } as const;
const COPY_LABEL = {
  idle: "Copy this SQL",
  copied: "SQL copied",
  error: "The SQL could not be copied",
} as const;

function sqlLines(sql: string): { number: number; text: string }[] {
  return sql.split("\n").map((text, index) => ({ number: index + 1, text }));
}

function plainSql(sql: string): HighlightedPostgresSource {
  return plainPostgresSource(sqlLines(sql));
}
