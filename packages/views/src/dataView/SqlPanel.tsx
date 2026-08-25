import { useMemo } from "react";
import { useClipboardCopy } from "../clipboardCopy.js";
import { IconButton } from "../results/IconButton.js";
import { PostgresSourceView } from "../source/PostgresSourceView.js";
import { withSemanticTokens } from "../source/semanticTokens.js";
import { useHighlightedPostgresSource } from "../source/useHighlightedSource.js";
import type { DataViewMessaging } from "./DataViewApp.js";
import { useSqlNames } from "./useSqlNames.js";

/**
 * The SQL the view is running, read in the view. It opens and closes where the reader is, instead
 * of in an editor window they have to come back from, and it is coloured by the same highlighter
 * the Cockpit reads sources with. What is copied from here is that same statement, as written —
 * the query the rows below came from, ready to paste into an editor or a Scratchpad.
 *
 * The grammar colours what a statement is made of; the language server says what its names are,
 * and its tokens are laid over the rest as soon as it answers. Until then, and where no server
 * answers at all, the statement is coloured by the grammar alone and stays readable. Names are
 * kept only for the statement they were asked about: the panel can have moved on since it asked.
 */
export function SqlPanel({
  sql,
  messaging,
  onClose,
}: {
  sql: string;
  messaging: DataViewMessaging;
  onClose: () => void;
}) {
  const source = useHighlightedPostgresSource(sql);
  const named = useSqlNames(messaging, sql, "query");
  const painted = useMemo(() => withSemanticTokens(source, named), [source, named]);
  const clipboard = useClipboardCopy();

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
        <PostgresSourceView source={painted} />
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
