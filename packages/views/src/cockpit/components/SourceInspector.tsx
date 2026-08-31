import type { SqlEditorSurface } from "../../../../editor/src/contracts.js";
import { postgresVisual } from "../../../../presentation/src/presentation.js";
import type { CockpitMessaging, WorkbenchGraphSourcePreview } from "../protocol.js";

function SourceInspector({
  preview,
  messaging,
  onClose,
  pinned,
  onPinnedChange,
  Editor,
}: {
  preview: WorkbenchGraphSourcePreview;
  messaging: CockpitMessaging;
  onClose: () => void;
  pinned: boolean;
  onPinnedChange(pinned: boolean): void;
  Editor: SqlEditorSurface;
}) {
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
            onClick={() => messaging.post({ type: "open", symbolUri: preview.symbolUri })}
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
        <div className="source-editor postgres-editor-surface">
          <Editor
            uri={preview.editorUri}
            text={preview.lines.map((line) => line.text).join("\n")}
            languageId={preview.languageId}
            ariaLabel="PostgreSQL source preview"
            lineNumberStart={preview.lines[0]?.number ?? preview.firstLine}
            readOnly
          />
        </div>
      </div>
    </aside>
  );
}

export { SourceInspector };
