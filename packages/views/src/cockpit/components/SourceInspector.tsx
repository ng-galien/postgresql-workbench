import { useEffect, useMemo, useState } from "react";
import { postgresVisual } from "../../presentation.js";
import {
  type HighlightedPostgresSource,
  highlightPostgresSource,
  plainPostgresSource,
} from "../../source/highlight.js";
import { PostgresSourceView } from "../../source/PostgresSourceView.js";
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
  const fallback = useMemo<HighlightedPostgresSource>(
    () => plainPostgresSource(preview.lines),
    [preview.lines],
  );
  const [source, setSource] = useState(fallback);
  useEffect(() => {
    let active = true;
    setSource(fallback);
    void highlightPostgresSource(preview.lines).then((highlighted) => {
      if (active) setSource(highlighted);
    });
    return () => {
      active = false;
    };
  }, [fallback, preview.lines]);
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
