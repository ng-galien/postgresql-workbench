import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { DebugResultCell } from "../../../dap/src/debugger/launch/index.js";
import { rowOrder } from "../../../rows/src/dataView/rowOrder.js";
import { shownValues } from "../../../rows/src/dataView/shownValues.js";
import type { DataViewExportChoice, DataViewExportScope } from "../../../rows/src/export.js";
import { followLinkRequest } from "../../../rows/src/followLink.js";
import { navigationReadsPostgres } from "../../../rows/src/navigation.js";
import type { SqlStatementResultPayload } from "../../../rows/src/resultPayload.js";
import { ExportDialog, type ExportSource } from "./ExportDialog.js";
import { type GridSelection, selectedOrdinals, selectedRows } from "./gridSelection.js";
import { IconButton } from "./IconButton.js";
import {
  isSqlResultExportFormat,
  SQL_RESULT_EXPORT_FORMATS,
  type SqlNotebookRendererRequest,
  type SqlNotebookRendererResponse,
  type SqlNotebookResultAction,
} from "./payload.js";
import { ResultGrid } from "./ResultGrid.js";
import { ResultNavigation } from "./ResultNavigation.js";
import { type ResultSort, sortedResultRows } from "./resultFormatting.js";
import {
  statementResultBadge,
  statementResultCapabilities,
  statementResultRegionLabel,
  statementResultSummary,
  statementResultTable,
} from "./statementResult.js";

export interface SqlResultViewProps {
  payload: SqlStatementResultPayload;
  messaging?: SqlResultMessaging;
}

export interface SqlResultMessaging {
  postMessage(message: SqlNotebookRendererRequest): void;
  subscribe(listener: (message: SqlNotebookRendererResponse) => void): () => void;
}

export function SqlResultView({ payload, messaging }: SqlResultViewProps) {
  const [current, setCurrent] = useState(payload);
  const [activeAction, setActiveAction] = useState<SqlNotebookResultAction>();
  const [progress, setProgress] = useState<number>();
  const [resultError, setResultError] = useState<string>();
  const [closed, setClosed] = useState(false);
  const [selection, setSelection] = useState<GridSelection>();
  const [inspecting, setInspecting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [sort, setSort] = useState<ResultSort>();
  const [inspectedCell, setInspectedCell] = useState<DebugResultCell>();
  const [exportPreview, setExportPreview] = useState<string>();
  const [exportError, setExportError] = useState<string>();
  const inspectionSequence = useRef(0);
  const previewSequence = useRef(0);
  const pendingPreview = useRef<number | undefined>(undefined);
  const pendingInspection = useRef<string | undefined>(undefined);
  const inspectorButton = useRef<HTMLButtonElement>(null);
  const exportButton = useRef<HTMLButtonElement>(null);
  const inspectorId = useId();
  const exportWasOpen = useRef(false);
  const exportPanelId = useId();
  const closeExport = useCallback(() => {
    exportButton.current?.focus();
    setExporting(false);
  }, []);
  const showInspector = useCallback((shown: boolean) => {
    if (!shown) inspectorButton.current?.focus();
    setInspecting(shown);
  }, []);

  useEffect(() => {
    if (exportWasOpen.current && !exporting) exportButton.current?.focus();
    exportWasOpen.current = exporting;
  }, [exporting]);

  useEffect(() => setCurrent(payload), [payload]);

  const rowset = current.kind === "rowset" ? current : undefined;
  const table = statementResultTable(current);
  const capabilities = statementResultCapabilities(current);
  const summary = statementResultSummary(current);

  useEffect(() => {
    const sessionId = rowset?.navigation?.sessionId;
    if (!messaging) return undefined;
    const unsubscribe = messaging.subscribe((message) => {
      if (message.type === "sql-result/previewed") {
        if (message.resultId === rowset?.resultId && message.requestId === pendingPreview.current) {
          setExportPreview(message.text);
          setExportError(message.error ? message.text : undefined);
        }
        return;
      }
      if (message.type === "sql-result/inspected") {
        if (
          message.resultId === rowset?.resultId &&
          message.requestId === pendingInspection.current
        ) {
          setInspectedCell(message.cell);
        }
        return;
      }
      if (!sessionId) return;
      if (message.sessionId !== sessionId) return;
      if (message.type === "sql-result/update") {
        setCurrent(message.payload);
        setSelection(undefined);
        setInspectedCell(undefined);
        setExporting(false);
        setActiveAction(undefined);
        setProgress(undefined);
        setResultError(undefined);
        setClosed(false);
        return;
      }
      if (message.type === "sql-result/progress") {
        setProgress(message.loadedRowCount);
        return;
      }
      setActiveAction(undefined);
      setProgress(undefined);
      setResultError(message.message);
      setClosed(message.closed);
    });
    if (sessionId) {
      messaging.postMessage({ type: "sql-result/request", sessionId, action: "attach" });
    }
    return unsubscribe;
  }, [rowset?.navigation?.sessionId, rowset?.resultId, messaging]);

  const inspectCell = useCallback(
    (row: number, ordinal: number) => {
      if (!messaging || !rowset?.resultId) return;
      const requestId = `${rowset.resultId}:${++inspectionSequence.current}`;
      pendingInspection.current = requestId;
      setInspectedCell(undefined);
      messaging.postMessage({
        type: "sql-result/inspect",
        requestId,
        resultId: rowset.resultId,
        page: {
          start: rowset.navigation?.pageStart ?? 1,
          length: rowset.rows.length,
        },
        row,
        ordinal,
        ...(sort ? { sort } : {}),
      });
    },
    [rowset, messaging, sort],
  );

  const navigation = rowset?.navigation;
  const request = (action: SqlNotebookResultAction) => {
    if (!navigation || !messaging) return;
    setActiveAction(action);
    setProgress(undefined);
    setResultError(undefined);
    messaging.postMessage({
      type: "sql-result/request",
      sessionId: navigation.sessionId,
      action,
    });
  };
  const busy = activeAction !== undefined;
  const ordinals = table.columns.map((_column, ordinal) => ordinal);
  const displayedRows = sortedResultRows(table.rows, sort);
  const order = useMemo(() => rowOrder([], displayedRows.length), [displayedRows.length]);
  const selected = selection
    ? {
        ...selectedRows(selection),
        ordinals: selectedOrdinals(selection, ordinals),
      }
    : undefined;
  const exportSource: ExportSource = {
    valuesFor: (scope) =>
      shownValues({
        columns: table.columns,
        rows: displayedRows,
        order,
        ordinals: scope === "selection" ? (selected?.ordinals ?? []) : ordinals,
        from: scope === "selection" ? (selected?.first ?? 0) : 0,
        to: scope === "selection" ? (selected?.last ?? -1) : order.count - 1,
      }),
    counts: {
      selection: selected ? selected.last - selected.first + 1 : 0,
      loaded: rowset?.navigation?.loadedRowCount ?? displayedRows.length,
      ...(rowset?.statement ? { all: rowset.rowCount } : {}),
    },
  };
  const exportTitle = `${statementResultBadge(current).toLowerCase()}-result`;
  const exportResult = (choice: DataViewExportChoice, scope: DataViewExportScope): void => {
    if (
      !capabilities.export ||
      !messaging ||
      !rowset?.resultId ||
      !isSqlResultExportFormat(choice.format)
    )
      return;
    messaging.postMessage({
      type: "sql-result/export",
      resultId: rowset.resultId,
      title: exportTitle,
      choice: { ...choice, format: choice.format },
      scope,
      ...(scope === "all"
        ? {}
        : {
            page: {
              start: rowset.navigation?.pageStart ?? 1,
              length: rowset.rows.length,
            },
            ...(sort ? { sort } : {}),
            ...(scope === "selection" && selected
              ? {
                  selection: {
                    from: selected.first,
                    to: selected.last,
                    ordinals: selected.ordinals,
                  },
                }
              : {}),
          }),
    });
    closeExport();
  };
  const previewExport = (choice: DataViewExportChoice, scope: DataViewExportScope): void => {
    if (
      !capabilities.export ||
      !messaging ||
      !rowset?.resultId ||
      !isSqlResultExportFormat(choice.format)
    )
      return;
    const requestId = ++previewSequence.current;
    pendingPreview.current = requestId;
    setExportPreview(undefined);
    setExportError(undefined);
    messaging.postMessage({
      type: "sql-result/preview",
      requestId,
      resultId: rowset.resultId,
      choice: { ...choice, format: choice.format },
      scope,
      ...(scope === "all"
        ? {}
        : {
            page: {
              start: rowset.navigation?.pageStart ?? 1,
              length: rowset.rows.length,
            },
            ...(sort ? { sort } : {}),
            ...(scope === "selection" && selected
              ? {
                  selection: {
                    from: selected.first,
                    to: selected.last,
                    ordinals: selected.ordinals,
                  },
                }
              : {}),
          }),
    });
  };

  return (
    <section className="sql-result" aria-label={statementResultRegionLabel(current)}>
      <header className="result-toolbar">
        <div className="result-summary">
          <span className="result-badge">{statementResultBadge(current)}</span>
          {current.binding ? (
            <span
              className="result-binding"
              title={`Result binding: ${current.binding.connectionName} · ${current.binding.database}`}
            >
              {current.binding.database}
            </span>
          ) : null}
          {capabilities.navigation && messaging && rowset ? (
            <ResultNavigation
              state={{
                navigation,
                busy,
                cancellable: activeAction ? navigationReadsPostgres(activeAction, rowset) : false,
                closed,
              }}
              payload={rowset}
              onAction={request}
              focusFallback={inspectorButton}
            />
          ) : (
            <span>{summary}</span>
          )}
          <span className="result-duration">{current.durationMs} ms</span>
          {rowset?.truncated ? (
            <span
              className="result-badge result-warning-badge"
              title={rowset.truncationReasons.join(", ")}
            >
              Preview truncated
            </span>
          ) : null}
        </div>
        {capabilities.inspection || (capabilities.export && messaging && rowset?.resultId) ? (
          <div className="result-actions">
            {capabilities.inspection ? (
              <IconButton
                icon="inspect"
                label={
                  inspecting
                    ? "Stop showing the value under the cursor"
                    : "Show the value under the cursor, whole"
                }
                primary={inspecting}
                buttonRef={inspectorButton}
                expanded={inspecting}
                controls={inspectorId}
                popup={false}
                onClick={() => showInspector(!inspecting)}
              />
            ) : null}
            {capabilities.export && messaging && rowset?.resultId ? (
              <IconButton
                icon="arrow-circle-up"
                label="Export rows to a file…"
                buttonRef={exportButton}
                expanded={exporting}
                controls={exportPanelId}
                popup={false}
                onClick={() => setExporting(true)}
              />
            ) : null}
          </div>
        ) : null}
      </header>
      <span className="sr-only" role="status" aria-live="polite">
        {activeAction && activeAction !== "cancel"
          ? `Loading ${activeAction === "load-all" ? "all result rows" : `${activeAction} result page`}…`
          : summary}
      </span>
      {progress !== undefined ? (
        <p className="result-progress" role="status">
          Loading all rows… {progress.toLocaleString("en-US")} loaded
        </p>
      ) : null}
      {resultError ? (
        <p className="result-message result-error" role="alert">
          {resultError}
        </p>
      ) : null}
      {table.columns.length > 0 ? (
        <ResultGrid
          payload={table}
          {...(capabilities.sorting
            ? {
                localSorting: {
                  sort,
                  onSort: (next: ResultSort | undefined) => {
                    setSort(next);
                    setSelection(undefined);
                    setInspectedCell(undefined);
                    setExporting(false);
                  },
                },
              }
            : {})}
          selection={selection}
          onSelect={(next) => {
            setSelection(next);
            setExporting(false);
          }}
          {...(capabilities.inspection
            ? {
                inspecting,
                inspectorId,
                onInspecting: showInspector,
                inspectedCell,
                ...(messaging && rowset?.resultId ? { onInspectCell: inspectCell } : {}),
              }
            : {})}
          {...(capabilities.links && messaging
            ? { onFollowLink: (href) => messaging.postMessage(followLinkRequest(href)) }
            : {})}
        />
      ) : (
        <p className="result-empty">{statementResultBadge(current)} completed without a row set.</p>
      )}
      {exporting && capabilities.export && rowset ? (
        <ExportDialog
          source={exportSource}
          title={exportTitle}
          scopes={rowset.statement ? ["selection", "loaded", "all"] : ["selection", "loaded"]}
          formats={SQL_RESULT_EXPORT_FORMATS}
          presentation="panel"
          panelId={exportPanelId}
          preview={exportPreview}
          error={exportError}
          onPreview={previewExport}
          onClose={closeExport}
          onExport={exportResult}
        />
      ) : null}
    </section>
  );
}
