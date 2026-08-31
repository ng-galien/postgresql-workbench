import type { SqlEditorSurface } from "../../../editor/src/contracts.js";
import { useClipboardCopy } from "../clipboardCopy.js";
import { IconButton } from "../results/IconButton.js";

/**
 * The SQL the view is running, read in the view. It opens and closes where the reader is, instead
 * of in an editor window they have to come back from. What is copied from here is that same
 * statement, as written — the query the rows below came from, ready to paste into an editor or a
 * Scratchpad.
 *
 * Every colour comes from the language server's one stream: what each piece is and what each name
 * means, in the same answer every SQL surface reads. Until it answers the statement is plain and
 * stays readable, and names are kept only for the statement they were asked about: the panel can
 * have moved on since it asked.
 */
export function SqlPanel({
  uri,
  sql,
  Editor,
  onClose,
}: {
  uri: string;
  sql: string;
  Editor: SqlEditorSurface;
  onClose: () => void;
}) {
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
        <div className="data-view-sql-editor postgres-editor-surface">
          <Editor uri={uri} text={sql} languageId="sql" ariaLabel="Query SQL" readOnly />
        </div>
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
