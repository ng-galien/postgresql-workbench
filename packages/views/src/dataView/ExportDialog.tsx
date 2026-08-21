import { useState } from "react";
import { countLabel } from "../../../rows/src/countLabel.js";
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
import type { ShownValues } from "../../../rows/src/shownValues.js";
import { Modal } from "../results/Modal.js";

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
  {
    format: "csv",
    label: "CSV",
    hint: "Commas, quoted where they must be. Opens in a spreadsheet.",
  },
  { format: "tsv", label: "TSV", hint: "Tabs — what copying a row already puts on the clipboard." },
  { format: "json", label: "JSON", hint: "One record per row, with NULL kept as null." },
  {
    format: "sql",
    label: "SQL",
    hint: "INSERT statements, to put these rows into another database.",
  },
  {
    format: "markdown",
    label: "Markdown",
    hint: "A table lined up, to paste into an issue or a page.",
  },
];

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
  onClose,
  onExport,
}: {
  source: ExportSource;
  /** What the file is named after: the query, or the table it reads. */
  title: string;
  onClose: () => void;
  onExport: (choice: DataViewExportChoice, scope: DataViewExportScope) => void;
}) {
  const [scope, setScope] = useState<DataViewExportScope>(
    source.counts.selection > 1 ? "selection" : "loaded",
  );
  const [choice, setChoice] = useState<DataViewExportChoice>(DEFAULT_DATA_VIEW_EXPORT);
  const chosen: DataViewExportChoice = { ...choice, table: source.table };
  const delimited = chosen.format === "csv" || chosen.format === "tsv";

  /*
   * Why a shape may not be had. A shape offered and then refused is worse than one shown as out
   * of reach with the reason beside it.
   */
  const refusalFor = (format: DataViewExportFormat): string | undefined => {
    if (format === "sql" && !source.table) {
      return "INSERT statements need one table to write into; this query reads several.";
    }
    if (format === "markdown" && scope === "all") {
      return "A Markdown table lines its columns up, which needs every row measured first.";
    }
    return undefined;
  };
  const refused = refusalFor(chosen.format);

  /* A dozen rows in the chosen shape, written by the module that will write the file. */
  const preview = ((): string => {
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

  const rowsInScope = scope === "all" ? source.counts.all : source.counts[scope];
  const shownRows = Math.min(
    PREVIEW_ROWS,
    scope === "all" ? source.counts.loaded : source.counts[scope],
  );
  const fileName = `${title.replace(/[^\w.-]+/gu, "_")}.${exportFileExtension(chosen.format)}`;

  return (
    <Modal title="Export rows" onClose={onClose}>
      <div className="export-dialog">
        <fieldset className="export-group">
          <legend className="export-legend">Rows</legend>
          {(["selection", "loaded", "all"] as const).map((candidate) => (
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
                    : "Every row of the query"}
              </span>
              <span className="export-option-hint">
                {candidate === "all"
                  ? source.counts.all === undefined
                    ? "read from the database as it is written"
                    : countLabel(source.counts.all, "row")
                  : countLabel(source.counts[candidate], "row")}
              </span>
            </label>
          ))}
        </fieldset>

        <fieldset className="export-group">
          <legend className="export-legend">Shape</legend>
          {FORMATS.map(({ format, label, hint }) => {
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

        <fieldset className="export-group export-written">
          <legend className="export-legend">Written as</legend>
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
                <span className="export-option-label">A first line naming the columns</span>
              </label>
              <div className="export-row">
                <span className="export-row-label">A NULL written as</span>
                {NULLS.map(({ nullAs, label }) => (
                  <button
                    type="button"
                    key={nullAs}
                    className={`export-pill${chosen.nullAs === nullAs ? " chosen" : ""}`}
                    onClick={() => setChoice((held) => ({ ...held, nullAs }))}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {chosen.format === "csv" ? (
                <div className="export-row">
                  <span className="export-row-label">Columns separated by</span>
                  {DELIMITERS.filter(({ delimiter }) => delimiter !== "\t").map(
                    ({ delimiter, label }) => (
                      <button
                        type="button"
                        key={delimiter}
                        className={`export-pill${chosen.delimiter === delimiter ? " chosen" : ""}`}
                        onClick={() => setChoice((held) => ({ ...held, delimiter }))}
                      >
                        {label}
                      </button>
                    ),
                  )}
                </div>
              ) : null}
            </>
          ) : (
            /* Nothing to choose here, said rather than left blank: the panel keeps its shape. */
            <p className="export-nothing-to-choose">
              {chosen.format === "json"
                ? "JSON says a NULL its own way, and names its columns in every record."
                : chosen.format === "sql"
                  ? "An INSERT names its columns and says NULL as NULL; there is nothing to choose."
                  : "A Markdown table names its columns and leaves a NULL cell empty."}
            </p>
          )}
        </fieldset>

        <div className="export-preview-frame">
          <div className="export-preview-heading">
            {refused
              ? "Nothing to show"
              : shownRows < (scope === "all" ? source.counts.loaded : source.counts[scope])
                ? `The first ${shownRows} rows, as they will be written`
                : "What will be written"}
            {scope === "all" && !refused ? " — the rest follows the same way" : ""}
          </div>
          <pre className="export-preview">{refused ?? preview}</pre>
        </div>

        <div className="export-actions">
          <span className="export-target">
            {refused
              ? ""
              : `${fileName}${rowsInScope === undefined ? "" : ` · ${countLabel(rowsInScope, "row")}`}`}
          </span>
          <button type="button" className="edit-bar-button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="edit-bar-button apply ready"
            disabled={refused !== undefined}
            onClick={() => onExport(chosen, scope)}
          >
            Export
          </button>
        </div>
      </div>
    </Modal>
  );
}
