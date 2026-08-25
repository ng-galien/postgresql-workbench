import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { countLabel } from "../../../rows/src/countLabel.js";
import type { ShownValues } from "../../../rows/src/dataView/shownValues.js";
import {
  type DataViewExportChoice,
  type DataViewExportFormat,
  type DataViewExportNull,
  type DataViewExportScope,
  DEFAULT_DATA_VIEW_EXPORT,
  dataViewExportText,
  exportDelimiterFor,
  exportFileExtension,
} from "../../../rows/src/export.js";
import { useClipboardCopy } from "../clipboardCopy.js";
import { IconButton } from "./IconButton.js";
import { Modal } from "./Modal.js";

/** What the view can tell the dialog about the rows behind each scope. */
export interface ExportSource {
  /** The values a scope covers, for the scopes the view already holds. */
  valuesFor(scope: "selection" | "loaded"): ShownValues;
  /** How many rows each scope would write; the whole result is not always counted yet. */
  counts: { selection: number; loaded: number; all?: number };
  /** The table INSERT statements are written against, when one table owns the rows. */
  table?: string;
}

/** How many rows of the chosen shape are shown before the reader commits to writing them. */
const PREVIEW_ROWS = 12;

const FORMATS: { format: DataViewExportFormat; label: string; hint: string }[] = [
  { format: "csv", label: "CSV", hint: "Comma-separated values" },
  { format: "tsv", label: "TSV", hint: "Tab-separated values" },
  { format: "json", label: "JSON", hint: "JSON records" },
  { format: "sql", label: "SQL", hint: "INSERT statements" },
  { format: "markdown", label: "Markdown", hint: "Markdown table" },
];

const SCOPES: readonly DataViewExportScope[] = ["selection", "loaded", "all"];

const NULLS: { nullAs: DataViewExportNull; label: string }[] = [
  { nullAs: "empty", label: "nothing" },
  { nullAs: "null", label: "NULL" },
  { nullAs: "backslash-n", label: "\\N" },
];

const DELIMITERS: { delimiter: string; label: string }[] = [
  { delimiter: ",", label: "," },
  { delimiter: ";", label: ";" },
  { delimiter: "\t", label: "Tab" },
  { delimiter: "|", label: "|" },
];

/**
 * Choosing an export, and reading what it will give before committing to it. The preview is
 * written by the same module that writes the file, so what is read here is what is written there.
 */
export function ExportDialog({
  source,
  title,
  scopes = SCOPES,
  formats = FORMATS.map(({ format }) => format),
  presentation = "dialog",
  panelId,
  error,
  preview: hostedPreview,
  onPreview,
  onClose,
  onExport,
}: {
  source: ExportSource;
  /** What the file is named after: the query, or the table it reads. */
  title: string;
  /** Row scopes this surface can promise without changing or replaying its query. */
  scopes?: readonly DataViewExportScope[];
  /** Formats this surface can identify honestly from the result it holds. */
  formats?: readonly DataViewExportFormat[];
  /** A notebook output grows for a panel; a full-page view has room for a modal dialog. */
  presentation?: "dialog" | "panel";
  panelId?: string;
  error?: string;
  /** Host-rendered preview from retained values; used when display cells are shortened. */
  preview?: string;
  onPreview?: (choice: DataViewExportChoice, scope: DataViewExportScope) => void;
  onClose: () => void;
  onExport: (choice: DataViewExportChoice, scope: DataViewExportScope) => void;
}) {
  const panel = useRef<HTMLElement>(null);
  const onPreviewRef = useRef(onPreview);
  onPreviewRef.current = onPreview;
  const [scope, setScope] = useState<DataViewExportScope>(
    source.counts.selection > 1 && scopes.includes("selection")
      ? "selection"
      : scopes.includes("loaded")
        ? "loaded"
        : (scopes[0] ?? "loaded"),
  );
  const [choice, setChoice] = useState<DataViewExportChoice>({
    ...DEFAULT_DATA_VIEW_EXPORT,
    format: formats.includes(DEFAULT_DATA_VIEW_EXPORT.format)
      ? DEFAULT_DATA_VIEW_EXPORT.format
      : (formats[0] ?? "csv"),
  });
  const previewClipboard = useClipboardCopy();
  const chosen: DataViewExportChoice = useMemo(
    () => ({ ...choice, table: source.table }),
    [choice, source.table],
  );
  const delimited = chosen.format === "csv" || chosen.format === "tsv";

  /*
   * Why a shape may not be had. A shape offered and then refused is worse than one shown as out
   * of reach with the reason beside it.
   */
  const refusalFor = (format: DataViewExportFormat): string | undefined => {
    if (format === "sql" && !source.table) {
      return "Requires a single table.";
    }
    return undefined;
  };
  const refused = refusalFor(chosen.format);

  useEffect(() => {
    if (!refused) onPreviewRef.current?.(chosen, scope);
  }, [chosen, refused, scope]);

  /* A dozen rows in the chosen shape, written by the module that will write the file. */
  const localPreview = ((): string => {
    if (refused) return "";
    const values = source.valuesFor(scope === "all" ? "loaded" : scope);
    try {
      return dataViewExportText(values.columns, values.rows.slice(0, PREVIEW_ROWS), {
        ...chosen,
        finalNewline: false,
      });
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  })();
  const preview = error ? "" : onPreview ? (hostedPreview ?? "Preparing preview…") : localPreview;

  const rowsInScope = scope === "all" ? source.counts.all : source.counts[scope];
  const fileName = `${title.replace(/[^\w.-]+/gu, "_")}.${exportFileExtension(chosen.format)}`;

  useEffect(() => {
    if (presentation !== "panel") return undefined;
    panel.current?.focus();
    return undefined;
  }, [presentation]);

  const closePanelOnEscape = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  };

  const chooser = (
    <div className="export-dialog">
      <fieldset className="export-group">
        <legend className="export-legend">Rows</legend>
        {scopes.map((candidate) => (
          <label className="export-option" key={candidate}>
            <input
              type="radio"
              name="export-scope"
              checked={scope === candidate}
              disabled={candidate === "selection" && source.counts.selection === 0}
              onChange={() => setScope(candidate)}
            />
            <span className="export-option-label">
              {candidate === "selection"
                ? "The selection"
                : candidate === "loaded"
                  ? "The rows loaded"
                  : "Entire query"}
            </span>
            <span className="export-option-hint">
              {candidate === "all"
                ? source.counts.all === undefined
                  ? "Runs the query again"
                  : countLabel(source.counts.all, "row")
                : countLabel(source.counts[candidate], "row")}
            </span>
          </label>
        ))}
      </fieldset>

      <fieldset className="export-group">
        <legend className="export-legend">Format</legend>
        {FORMATS.filter(({ format }) => formats.includes(format)).map(({ format, label, hint }) => {
          const refusal = refusalFor(format);
          return (
            <label className="export-option" key={format} title={refusal}>
              <input
                type="radio"
                name="export-format"
                checked={chosen.format === format}
                disabled={refusal !== undefined}
                onChange={() =>
                  setChoice((held) => ({
                    ...held,
                    format,
                    delimiter: exportDelimiterFor(format, held.delimiter),
                  }))
                }
              />
              <span className="export-option-label">{label}</span>
              <span className="export-option-hint">{refusal ?? hint}</span>
            </label>
          );
        })}
      </fieldset>

      <fieldset className="export-group export-options">
        <legend className="export-legend">Options</legend>
        {delimited ? (
          <>
            <label className="export-option">
              <input
                type="checkbox"
                checked={chosen.header}
                onChange={(event) =>
                  setChoice((held) => ({ ...held, header: event.target.checked }))
                }
              />
              <span className="export-option-label">Include column names</span>
            </label>
            <fieldset className="export-row export-inline-group">
              <legend className="export-row-label">NULL as</legend>
              {NULLS.map(({ nullAs, label }) => (
                <button
                  type="button"
                  key={nullAs}
                  className={`export-pill${chosen.nullAs === nullAs ? " chosen" : ""}`}
                  aria-pressed={chosen.nullAs === nullAs}
                  onClick={() => setChoice((held) => ({ ...held, nullAs }))}
                >
                  {label}
                </button>
              ))}
            </fieldset>
            {chosen.format === "csv" ? (
              <fieldset className="export-row export-inline-group">
                <legend className="export-row-label">Separator</legend>
                {DELIMITERS.filter(({ delimiter }) => delimiter !== "\t").map(
                  ({ delimiter, label }) => (
                    <button
                      type="button"
                      key={delimiter}
                      className={`export-pill${chosen.delimiter === delimiter ? " chosen" : ""}`}
                      aria-pressed={chosen.delimiter === delimiter}
                      onClick={() => setChoice((held) => ({ ...held, delimiter }))}
                    >
                      {label}
                    </button>
                  ),
                )}
              </fieldset>
            ) : null}
          </>
        ) : chosen.format === "sql" ? (
          <label className="export-option">
            <input
              type="checkbox"
              checked={chosen.createTable}
              onChange={(event) =>
                setChoice((held) => ({ ...held, createTable: event.target.checked }))
              }
            />
            <span className="export-option-label">Include CREATE TABLE</span>
          </label>
        ) : (
          <p className="export-no-options">No options</p>
        )}
      </fieldset>

      <div className="export-preview-frame">
        <div className="export-preview-bar">
          <div className="export-preview-heading">Preview</div>
          <IconButton
            icon={
              previewClipboard.state === "copied"
                ? "check"
                : previewClipboard.state === "error"
                  ? "error"
                  : "copy"
            }
            label={
              previewClipboard.state === "copied"
                ? "Preview copied"
                : previewClipboard.state === "error"
                  ? "Preview could not be copied"
                  : "Copy preview"
            }
            disabled={refused !== undefined || preview === ""}
            onClick={() => previewClipboard.copy(preview)}
          />
        </div>
        <pre
          className="export-preview"
          role="status"
          aria-live="polite"
          aria-busy={Boolean(onPreview && hostedPreview === undefined && !refused)}
        >
          {refused ?? preview}
        </pre>
      </div>

      {scope === "all" ? (
        <p className="export-warning" role="note">
          Runs the query again. Row order and values may differ. Procedures and statements with side
          effects will execute again.
        </p>
      ) : null}
      {error ? (
        <p className="result-message result-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="export-actions">
        <span className="export-target">
          {refused
            ? ""
            : `${fileName}${rowsInScope === undefined ? "" : ` · ${countLabel(rowsInScope, "row")}`}`}
        </span>
        <button type="button" className="result-button" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="result-button result-button-primary"
          disabled={refused !== undefined || error !== undefined}
          onClick={() => onExport(chosen, scope)}
        >
          Export
        </button>
      </div>
    </div>
  );

  return presentation === "panel" ? (
    <section
      ref={panel}
      id={panelId}
      className="export-panel"
      aria-label="Export rows"
      tabIndex={-1}
      onKeyDown={closePanelOnEscape}
    >
      <header className="export-panel-header">
        <h2 className="export-panel-title">Export rows</h2>
        <button type="button" className="icon-button" title="Close" onClick={onClose}>
          <span className="codicon codicon-close" aria-hidden="true" />
        </button>
      </header>
      <div className="export-panel-body">{chooser}</div>
    </section>
  ) : (
    <Modal title="Export rows" onClose={onClose}>
      {chooser}
    </Modal>
  );
}
