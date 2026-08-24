import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { DebugResultCell } from "../../../dap/src/debugger/launch/index.js";
import { rowOrder } from "../../../rows/src/dataView/rowOrder.js";
import { shownValues } from "../../../rows/src/dataView/shownValues.js";
import type { DataViewExportChoice, DataViewExportScope } from "../../../rows/src/export.js";
import { followLinkRequest } from "../../../rows/src/followLink.js";
import type { SqlNotebookResultPayload } from "../../../rows/src/resultPayload.js";
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
import { type ResultSort, resultRowSummary, sortedResultRows } from "./resultFormatting.js";

export interface SqlResultViewProps {
  payload: SqlNotebookResultPayload;
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

  useEffect(() => {
    const sessionId = current.navigation?.sessionId;
    if (!messaging) return undefined;
    const unsubscribe = messaging.subscribe((message) => {
      if (message.type === "sql-result/previewed") {
        if (message.resultId === current.resultId && message.requestId === pendingPreview.current) {
          setExportPreview(message.text);
          setExportError(message.error ? message.text : undefined);
        }
        return;
      }
      if (message.type === "sql-result/inspected") {
        if (
          message.resultId === current.resultId &&
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
  }, [current.navigation?.sessionId, current.resultId, messaging]);

  const inspectCell = useCallback(
    (row: number, ordinal: number) => {
      if (!messaging || !current.resultId) return;
      const requestId = `${current.resultId}:${++inspectionSequence.current}`;
      pendingInspection.current = requestId;
      setInspectedCell(undefined);
      messaging.postMessage({
        type: "sql-result/inspect",
        requestId,
        resultId: current.resultId,
        page: {
          start: current.navigation?.pageStart ?? 1,
          length: current.rows.length,
        },
        row,
        ordinal,
        ...(sort ? { sort } : {}),
      });
    },
    [current.navigation?.pageStart, current.resultId, current.rows.length, messaging, sort],
  );

  const navigation = current.navigation;
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
  const ordinals = current.columns.map((_column, ordinal) => ordinal);
  const displayedRows = sortedResultRows(current.rows, sort);
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
        columns: current.columns,
        rows: displayedRows,
        order,
        ordinals: scope === "selection" ? (selected?.ordinals ?? []) : ordinals,
        from: scope === "selection" ? (selected?.first ?? 0) : 0,
        to: scope === "selection" ? (selected?.last ?? -1) : order.count - 1,
      }),
    counts: {
      selection: selected ? selected.last - selected.first + 1 : 0,
      loaded: current.navigation?.loadedRowCount ?? displayedRows.length,
      ...(current.statement ? { all: current.rowCount } : {}),
    },
  };
  const exportTitle = `${current.command.toLowerCase()}-result`;
  const exportResult = (choice: DataViewExportChoice, scope: DataViewExportScope): void => {
    if (!messaging || !current.resultId || !isSqlResultExportFormat(choice.format)) return;
    messaging.postMessage({
      type: "sql-result/export",
      resultId: current.resultId,
      title: exportTitle,
      choice: { ...choice, format: choice.format },
      scope,
      ...(scope === "all"
        ? {}
        : {
            page: {
              start: current.navigation?.pageStart ?? 1,
              length: current.rows.length,
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
    if (!messaging || !current.resultId || !isSqlResultExportFormat(choice.format)) return;
    const requestId = ++previewSequence.current;
    pendingPreview.current = requestId;
    setExportPreview(undefined);
    setExportError(undefined);
    messaging.postMessage({
      type: "sql-result/preview",
      requestId,
      resultId: current.resultId,
      choice: { ...choice, format: choice.format },
      scope,
      ...(scope === "all"
        ? {}
        : {
            page: {
              start: current.navigation?.pageStart ?? 1,
              length: current.rows.length,
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
    <section className="sql-result" aria-label="PostgreSQL query result">
      <header className="result-toolbar">
        <div className="result-summary">
          <span className="result-badge">{current.command}</span>
          <span
            className="result-binding"
            title={`Result binding: ${current.binding.connectionName} · ${current.binding.database}`}
          >
            {current.binding.database}
          </span>
          {messaging ? (
            <ResultNavigation
              state={{ navigation, busy, closed }}
              payload={current}
              onAction={request}
            />
          ) : (
            <span>{resultRowSummary(current)}</span>
          )}
          <span className="result-duration">{current.durationMs} ms</span>
          {current.truncated ? (
            <span
              className="result-badge result-warning-badge"
              title={current.truncationReasons.join(", ")}
            >
              Preview truncated
            </span>
          ) : null}
        </div>
        {current.columns.length > 0 ? (
          <div className="result-actions">
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
            {messaging && current.resultId ? (
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
          : resultRowSummary(current)}
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
      {current.columns.length > 0 ? (
        <ResultGrid
          payload={current}
          localSorting={{
            sort,
            onSort: (next) => {
              setSort(next);
              setSelection(undefined);
              setInspectedCell(undefined);
              setExporting(false);
            },
          }}
          selection={selection}
          onSelect={(next) => {
            setSelection(next);
            setExporting(false);
          }}
          inspecting={inspecting}
          inspectorId={inspectorId}
          onInspecting={showInspector}
          inspectedCell={inspectedCell}
          {...(messaging && current.resultId ? { onInspectCell: inspectCell } : {})}
          {...(messaging
            ? { onFollowLink: (href) => messaging.postMessage(followLinkRequest(href)) }
            : {})}
        />
      ) : (
        <p className="result-empty">{current.command} completed without a row set.</p>
      )}
      {exporting ? (
        <ExportDialog
          source={exportSource}
          title={exportTitle}
          scopes={current.statement ? ["selection", "loaded", "all"] : ["selection", "loaded"]}
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
