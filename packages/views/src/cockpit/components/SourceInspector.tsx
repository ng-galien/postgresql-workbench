import { useMemo } from "react";
import { postgresVisual } from "../../presentation.js";
import { plainPostgresSource } from "../../source/highlight.js";
import { PostgresSourceView } from "../../source/PostgresSourceView.js";
import { withSemanticTokens } from "../../source/semanticTokens.js";
import type { WorkbenchGraphSourcePreview } from "../protocol.js";
import { post } from "../vscodeApi.js";

function SourceInspector({
  preview,
  onClose,
  pinned,
  onPinnedChange,
}: {
  preview: WorkbenchGraphSourcePreview;
  onClose: () => void;
  pinned: boolean;
  onPinnedChange(pinned: boolean): void;
}) {
  /*
   * The server counted lines from the top of the text it was asked about; the preview numbers its
   * lines as the file does. The shift between the two is the first line's number.
   */
  const source = useMemo(() => {
    const shift = (preview.lines[0]?.number ?? 1) - 1;
    return withSemanticTokens(
      plainPostgresSource(preview.lines),
      (preview.tokens ?? []).map((token) => ({ ...token, line: token.line + shift })),
    );
  }, [preview.lines, preview.tokens]);
  const visual = postgresVisual(preview.kind);
  const file = preview.file.split("/").at(-1) ?? preview.file;
  return (
    <aside
      className="source-inspector"
      aria-label="PostgreSQL source inset"
      data-graph-preview={preview.symbolUri}
      data-graph-preview-title={preview.title}
      data-graph-preview-lines={preview.lines.length}
    >
      <header className="source-heading">
        <span className="source-glyph">{visual.glyph}</span>
        <strong>{preview.title}</strong>
        <span className="source-kind">{preview.kind}</span>
        <span className="source-file" title={preview.file}>
          {file}
        </span>
        <span className="source-actions">
          <button
            type="button"
            title={pinned ? "Unpin source preview" : "Pin source preview"}
            aria-label={pinned ? "Unpin source preview" : "Pin source preview"}
            aria-pressed={pinned}
            onClick={() => onPinnedChange(!pinned)}
          >
            {pinned ? "●" : "○"}
          </button>
          <button
            type="button"
            title="Open definition in the editor"
            aria-label="Open definition"
            onClick={() => post({ type: "open", symbolUri: preview.symbolUri })}
          >
            ↗
          </button>
          <button
            type="button"
            title="Close source inset (Escape)"
            aria-label="Close"
            onClick={onClose}
          >
            ×
          </button>
        </span>
      </header>
      <div className="source-range">
        lines {preview.firstLine}–{preview.lastLine}
      </div>
      <div className="source-body">
        <PostgresSourceView source={source} />
      </div>
    </aside>
  );
}

export { SourceInspector };
