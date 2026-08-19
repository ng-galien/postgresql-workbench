import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { DebugResultCell } from "../../../dap/src/debugger/launch/index.js";
import {
  dataViewColumnKeys,
  dataViewRowKey,
  dataViewSourceTitle,
} from "../../../rows/src/dataView.js";
import { hasWorkbenchTreeDrag } from "../cockpit/dragAndDrop.js";
import type { GridEditing } from "../results/CellEditor.js";
import { type GridLayout, ResultGrid } from "../results/ResultGrid.js";
import { nextResultSort, resultAsTsv } from "../results/resultFormatting.js";
import { resultRowSummary } from "../results/SqlResultView.js";
import type {
  DataViewAddition,
  DataViewCompletion,
  DataViewRequest,
  DataViewResponse,
  DataViewState,
} from "./protocol.js";

export interface DataViewMessaging {
  post(message: DataViewRequest): void;
  subscribe(listener: (message: DataViewResponse) => void): () => void;
}

interface Notice {
  message: string;
  severity: "info" | "error";
}

function IconButton({
  icon,
  label,
  onClick,
  disabled,
  primary,
  text,
}: {
  icon: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
  /** Optional short text shown next to the icon. */
  text?: ReactNode;
}) {
  return (
    <button
      className={`icon-button${primary ? " primary" : ""}`}
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      <span className={`codicon codicon-${icon}`} aria-hidden="true" />
      {text !== undefined ? <span className="icon-button-text">{text}</span> : null}
    </button>
  );
}

function MenuItem({
  label,
  disabled,
  onSelect,
}: {
  label: string;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className="column-menu-item"
      disabled={disabled}
      onClick={onSelect}
    >
      {label}
    </button>
  );
}

const COMPLETION_DEBOUNCE_MS = 120;

/**
 * WHERE editor: multi-line (Shift+Enter), Enter applies, completions come from the SQL authoring
 * server through the host (Ctrl+Space or while typing).
 */
function FilterInput({
  value,
  disabled,
  messaging,
  onApply,
}: {
  value: string;
  disabled: boolean;
  messaging: DataViewMessaging;
  onApply(text: string): void;
}) {
  const [draft, setDraft] = useState(value);
  const [items, setItems] = useState<DataViewCompletion[]>([]);
  const [selected, setSelected] = useState(0);
  const [focused, setFocused] = useState(false);
  const requestId = useRef(0);
  const timer = useRef<number | undefined>(undefined);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const dirty = draft.trim() !== value.trim();

  useEffect(() => {
    if (!focused) setDraft(value);
  }, [value, focused]);

  useEffect(
    () =>
      messaging.subscribe((message) => {
        if (message.type !== "data-view/completions" || message.requestId !== requestId.current) {
          return;
        }
        setItems(message.items);
        setSelected(0);
      }),
    [messaging],
  );

  const requestCompletions = (text: string, offset: number, explicit = false) => {
    if (timer.current !== undefined) window.clearTimeout(timer.current);
    // No proposals inside a string literal, and while typing only after an identifier character.
    const before = text.slice(0, offset);
    const insideLiteral = (before.match(/'/gu)?.length ?? 0) % 2 === 1;
    if (insideLiteral || (!explicit && !/[\w$".]$/u.test(before))) {
      close();
      return;
    }
    timer.current = window.setTimeout(() => {
      requestId.current += 1;
      messaging.post({ type: "data-view/complete", requestId: requestId.current, text, offset });
    }, COMPLETION_DEBOUNCE_MS);
  };
  const close = () => {
    setItems([]);
    requestId.current += 1;
  };
  const accept = (item: DataViewCompletion) => {
    const element = textarea.current;
    const caret = element?.selectionStart ?? draft.length;
    const start = Math.max(0, caret - item.replaceLength);
    const next = `${draft.slice(0, start)}${item.insertText}${draft.slice(caret)}`;
    setDraft(next);
    close();
    requestAnimationFrame(() => {
      const position = start + item.insertText.length;
      element?.setSelectionRange(position, position);
      element?.focus();
    });
  };
  const handleKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (items.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelected((current) => (current + 1) % items.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelected((current) => (current - 1 + items.length) % items.length);
        return;
      }
      if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
        const item = items[selected];
        if (item) {
          event.preventDefault();
          accept(item);
          return;
        }
      }
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
    }
    if (event.key === " " && event.ctrlKey) {
      event.preventDefault();
      requestCompletions(draft, event.currentTarget.selectionStart, true);
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      close();
      onApply(draft.trim());
      return;
    }
    if (event.key === "Escape") {
      setDraft(value);
      event.currentTarget.blur();
    }
  };
  const rows = Math.min(6, Math.max(1, draft.split("\n").length));

  return (
    <div className={`filter-input${dirty ? " dirty" : ""}${draft ? " active" : ""}`}>
      <span className="codicon codicon-filter" aria-hidden="true" />
      <textarea
        ref={textarea}
        className="filter-textarea"
        rows={rows}
        value={draft}
        placeholder="WHERE … (Enter runs, Shift+Enter new line, Ctrl+Space completes)"
        spellCheck={false}
        disabled={disabled}
        aria-label="Filter (WHERE)"
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          window.setTimeout(close, 150);
        }}
        onChange={(event) => {
          setDraft(event.target.value);
          requestCompletions(event.target.value, event.target.selectionStart);
        }}
        onKeyDown={handleKey}
      />
      {draft || value ? (
        <button
          type="button"
          className="icon-button"
          title="Clear the filter"
          aria-label="Clear the filter"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            setDraft("");
            close();
            if (value) onApply("");
          }}
        >
          <span className="codicon codicon-close" aria-hidden="true" />
        </button>
      ) : null}
      {dirty ? (
        <button
          type="button"
          className="icon-button primary"
          title="Run with this filter (Enter)"
          aria-label="Run with this filter"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onApply(draft.trim())}
        >
          <span className="codicon codicon-play" aria-hidden="true" />
        </button>
      ) : null}
      {items.length > 0 ? (
        <ul className="filter-completions" aria-label="Completions">
          {items.slice(0, 12).map((item, index) => (
            <li key={`${item.kind ?? ""}:${item.label}:${item.detail ?? ""}:${item.insertText}`}>
              <button
                type="button"
                className={`filter-completion${index === selected ? " selected" : ""}`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => accept(item)}
              >
                {item.kind ? <span className="filter-completion-kind">{item.kind}</span> : null}
                <span className="filter-completion-label">{item.label}</span>
                {item.detail ? (
                  <span className="filter-completion-detail">{item.detail}</span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function DataViewApp({ messaging }: { messaging: DataViewMessaging }) {
  const [state, setState] = useState<DataViewState>();
  const [progress, setProgress] = useState<number>();
  const [notice, setNotice] = useState<Notice>();
  const [showSql, setShowSql] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const [badgeDragOver, setBadgeDragOver] = useState<number>();
  const [additions, setAdditions] = useState<DataViewAddition[]>();
  const [additionFilter, setAdditionFilter] = useState("");
  const [choices, setChoices] = useState<{
    addition: DataViewAddition;
    title: string;
    choices: Array<{ index: number; label: string; description: string }>;
  }>();
  const badgeDragSource = useRef<number | undefined>(undefined);
  const [sortDragOver, setSortDragOver] = useState<number>();
  const sortDragSource = useRef<number | undefined>(undefined);

  useEffect(() => {
    const unsubscribe = messaging.subscribe((message) => {
      if (message.type === "data-view/state") {
        setState(message.state);
        setProgress(undefined);
        return;
      }
      if (message.type === "data-view/progress") {
        setProgress(message.loadedRowCount);
        return;
      }
      if (message.type === "data-view/notice") {
        setNotice({ message: message.message, severity: message.severity });
        return;
      }
      if (message.type === "data-view/additions") {
        setAdditions(message.items);
        setAdditionFilter("");
        setChoices(undefined);
        return;
      }
      if (message.type === "data-view/choices") {
        setChoices({ addition: message.addition, title: message.title, choices: message.choices });
        setAdditions([]);
      }
    });
    messaging.post({ type: "data-view/ready" });
    return unsubscribe;
  }, [messaging]);

  useEffect(() => {
    if (!notice || notice.severity === "error") return;
    const timer = window.setTimeout(() => setNotice(undefined), 4_000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const editing = useMemo<GridEditing | undefined>(() => {
    if (!state || state.editability.tables.length === 0) return undefined;
    // The grid asks for these once per rendered cell, on every scroll: indexed, never scanned.
    const tablesByOid = new Map(
      state.editability.tables.map((table) => [table.tableOid, table] as const),
    );
    const editsByRow = new Map(
      state.edits.map((edit) => [`${edit.ordinal}:${dataViewRowKey(edit)}`, edit] as const),
    );
    const rowIdentity = (row: readonly DebugResultCell[], ordinal: number) => {
      const policy = state.editability.columns[ordinal];
      if (!policy?.editable) return undefined;
      const table = tablesByOid.get(policy.tableOid);
      if (!table) return undefined;
      return {
        tableOid: table.tableOid,
        key: table.keyOrdinals.map((keyOrdinal) => row[keyOrdinal]?.value ?? null),
      };
    };
    return {
      policies: state.editability.columns,
      editFor(row, _rowIndex, ordinal) {
        // The grid asks per cell on every scroll frame; unedited is the usual state.
        if (editsByRow.size === 0) return undefined;
        const identity = rowIdentity(row, ordinal);
        if (!identity) return undefined;
        return editsByRow.get(`${ordinal}:${dataViewRowKey(identity)}`);
      },
      onEdit(row, _rowIndex, ordinal, value, original) {
        const identity = rowIdentity(row, ordinal);
        const policy = state.editability.columns[ordinal];
        if (!identity || !policy?.editable) return;
        messaging.post({
          type: "data-view/edit",
          edit: { ...identity, ordinal, column: policy.column, original, value },
        });
      },
    };
  }, [state, messaging]);

  if (!state) {
    return (
      <main className="data-view">
        <p className="data-view-status">Opening the Data View…</p>
      </main>
    );
  }

  const payload = state.payload;
  const navigation = payload?.navigation;
  const cursorOpen = state.status === "ready" && navigation !== undefined && !state.message;
  const disabled = state.busy || state.applying;
  const editCount = state.edits.length;
  const editable = state.editability.tables.length > 0;
  const query = state.query;
  const columnNames = payload?.columns.map((column) => column.name) ?? [];
  /** Grid-column sorts, in ORDER BY order (items that are not grid columns are kept as text only). */
  const columnSorts = query.orderBy.flatMap((item) =>
    item.column ? [{ column: item.column, direction: item.direction }] : [],
  );
  const gridSorts = columnSorts.flatMap((sort) => {
    const columnIndex = columnNames.indexOf(sort.column);
    return columnIndex >= 0 ? [{ columnIndex, direction: sort.direction }] : [];
  });
  const columnKeys = dataViewColumnKeys(state.projection, columnNames);
  const hiddenOrdinals = new Set(
    columnKeys.flatMap((key, ordinal) => (query.hidden.includes(key) ? [ordinal] : [])),
  );
  const post = (message: DataViewRequest) => messaging.post(message);
  const applySorts = (sorts: { column: string; direction: "ascending" | "descending" }[]) =>
    post({ type: "data-view/sort", sorts });
  /** Toggles one column: none → asc → desc → none; `additive` keeps the other criteria. */
  const requestSort = (ordinal: number, additive: boolean) => {
    const current = gridSorts.find((sort) => sort.columnIndex === ordinal);
    sortBy(ordinal, nextResultSort(current, ordinal)?.direction, additive);
  };
  const sortBy = (ordinal: number, direction?: "ascending" | "descending", additive = false) => {
    const column = columnNames[ordinal];
    if (!column) return;
    const others = additive ? columnSorts.filter((sort) => sort.column !== column) : [];
    applySorts(direction ? [...others, { column, direction }] : others);
  };
  const layout: GridLayout | undefined = query.structured
    ? {
        hidden: hiddenOrdinals,
        onReorder: (from, to) => post({ type: "data-view/reorder", from, to }),
        columnAccent: (ordinal) => {
          const index = state.projection.columnTable[ordinal];
          const table = index === undefined ? undefined : state.projection.tables[index];
          return table ? tableAccent(table.accent) : undefined;
        },
        menuItems: (ordinal) => {
          const column = columnNames[ordinal] ?? "";
          const visible = columnNames
            .map((_name, index) => index)
            .filter((index) => !hiddenOrdinals.has(index));
          const position = visible.indexOf(ordinal);
          const left = position > 0 ? visible[position - 1] : undefined;
          const right = position >= 0 ? visible[position + 1] : undefined;
          return [
            { label: "Sort ascending", action: () => sortBy(ordinal, "ascending") },
            { label: "Sort descending", action: () => sortBy(ordinal, "descending") },
            ...(columnSorts.length > 0
              ? [
                  { label: "Add ascending sort", action: () => sortBy(ordinal, "ascending", true) },
                  {
                    label: "Add descending sort",
                    action: () => sortBy(ordinal, "descending", true),
                  },
                  { label: "Clear sort", action: () => applySorts([]) },
                ]
              : []),
            {
              label: "Hide column",
              action: () => post({ type: "data-view/hide", column: columnKeys[ordinal] ?? column }),
            },
            ...(left === undefined
              ? []
              : [
                  {
                    label: "Move left",
                    action: () => post({ type: "data-view/reorder", from: ordinal, to: left }),
                  },
                ]),
            ...(right === undefined
              ? []
              : [
                  {
                    label: "Move right",
                    action: () => post({ type: "data-view/reorder", from: ordinal, to: right }),
                  },
                ]),
            {
              label: "Edit projection in query…",
              action: () => post({ type: "data-view/edit-query", clause: "select" }),
            },
          ];
        },
      }
    : undefined;
  // One fixed status line: messages never push the grid around.
  const statusLine: { text: string; severity: "info" | "error" } =
    state.status === "error"
      ? { text: state.message ?? "Error", severity: "error" }
      : notice
        ? { text: notice.message, severity: notice.severity }
        : progress !== undefined
          ? {
              text: `Loading all rows… ${progress.toLocaleString("en-US")} loaded`,
              severity: "info",
            }
          : state.message
            ? { text: state.message, severity: "info" }
            : query.problem
              ? {
                  text: `${query.problem} Column drag, hide, and sort from the grid are disabled.`,
                  severity: "info",
                }
              : state.busy
                ? { text: state.applying ? "Applying changes…" : "Loading…", severity: "info" }
                : { text: "", severity: "info" };
  const refresh = () =>
    post({ type: query.editorDirty ? "data-view/apply-query" : "data-view/refresh" });

  return (
    <main
      className={`data-view${state.applying ? " applying" : ""}${dropActive ? " drop-active" : ""}`}
      aria-busy={disabled}
      onDragOver={(event) => {
        if (!hasWorkbenchTreeDrag(event.dataTransfer)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        if (!dropActive) setDropActive(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setDropActive(false);
      }}
      onDrop={(event) => {
        setDropActive(false);
        if (!hasWorkbenchTreeDrag(event.dataTransfer)) return;
        event.preventDefault();
        post({ type: "data-view/drop-tree" });
      }}
    >
      <header className="data-view-toolbar">
        <div className="toolbar-group toolbar-identity">
          <span
            className="data-view-association"
            title={`Connexion Association: ${state.serverName} · ${state.source.database}`}
          >
            <span className="codicon codicon-database" aria-hidden="true" />
            {associationLabel(state.serverName, state.source.database)}
          </span>
        </div>

        <div className="toolbar-group toolbar-query">
          <IconButton
            icon={query.editorDirty ? "play" : "refresh"}
            label={
              query.editorDirty
                ? "Apply the edited query (saving the editor does the same)"
                : "Refresh"
            }
            onClick={refresh}
            disabled={disabled}
            primary={query.editorDirty}
          />
          <IconButton
            icon="code"
            label="Edit the query in a SQL editor (completion, formatting); save to apply"
            onClick={() => post({ type: "data-view/edit-query" })}
          />
          <div className="toolbar-more">
            <IconButton
              icon={query.hidden.length > 0 ? "eye-closed" : "list-selection"}
              label={
                query.hidden.length > 0
                  ? `Columns (${query.hidden.length} hidden)`
                  : "Show or hide columns"
              }
              disabled={!query.structured || columnNames.length === 0}
              onClick={() => setColumnsOpen((open) => !open)}
              text={query.hidden.length > 0 ? query.hidden.length : undefined}
            />
            {columnsOpen ? (
              <>
                <button
                  type="button"
                  className="column-menu-backdrop"
                  aria-label="Close columns menu"
                  onClick={() => setColumnsOpen(false)}
                />
                <div className="column-menu toolbar-menu columns-menu" role="menu">
                  {[...state.projection.tables.map((_table, index) => index), undefined].map(
                    (tableIndex) => {
                      const ordinals = columnNames.flatMap((_name, ordinal) =>
                        state.projection.columnTable[ordinal] === tableIndex ? [ordinal] : [],
                      );
                      if (ordinals.length === 0) return null;
                      const table =
                        tableIndex === undefined ? undefined : state.projection.tables[tableIndex];
                      const accent = table ? tableAccent(table.accent) : undefined;
                      return (
                        <div
                          key={table ? table.tableOid : "computed"}
                          className="columns-menu-group"
                          style={
                            accent ? ({ "--column-accent": accent } as CSSProperties) : undefined
                          }
                        >
                          <div className="columns-menu-heading">
                            {table ? `${table.schema}.${table.name}` : "Computed values"}
                          </div>
                          {ordinals.map((ordinal) => {
                            const name = columnNames[ordinal] ?? "";
                            const key = columnKeys[ordinal] ?? name;
                            const hidden = hiddenOrdinals.has(ordinal);
                            return (
                              <button
                                key={key}
                                type="button"
                                role="menuitemcheckbox"
                                aria-checked={!hidden}
                                className="column-menu-item"
                                onClick={() =>
                                  post(
                                    hidden
                                      ? { type: "data-view/unhide", column: key }
                                      : { type: "data-view/hide", column: key },
                                  )
                                }
                              >
                                <span
                                  className={`codicon codicon-${hidden ? "circle-large-outline" : "pass-filled"}`}
                                  aria-hidden="true"
                                />
                                {name}
                              </button>
                            );
                          })}
                        </div>
                      );
                    },
                  )}
                  {query.hidden.length > 0 ? (
                    <MenuItem
                      label="Show all columns"
                      onSelect={() => {
                        setColumnsOpen(false);
                        post({ type: "data-view/unhide" });
                      }}
                    />
                  ) : null}
                </div>
              </>
            ) : null}
          </div>
        </div>

        {navigation ? (
          <div className="toolbar-group toolbar-navigation">
            <IconButton
              icon="chevron-left"
              label="Previous page"
              disabled={disabled || !cursorOpen || !navigation.hasPrevious}
              onClick={() => post({ type: "data-view/navigate", action: "previous" })}
            />
            <span
              className="toolbar-rows"
              title={payload?.truncated ? payload.truncationReasons.join(", ") : undefined}
            >
              {payload ? resultRowSummary(payload) : ""}
              {payload?.truncated ? (
                <span className="codicon codicon-warning" title="Preview truncated" />
              ) : null}
              {!cursorOpen && state.status === "ready" ? (
                <span
                  className="codicon codicon-debug-disconnect"
                  title="Cursor closed; refresh to load again"
                />
              ) : null}
            </span>
            <IconButton
              icon="chevron-right"
              label="Next page"
              disabled={disabled || !cursorOpen || !navigation.hasNext}
              onClick={() => post({ type: "data-view/navigate", action: "next" })}
            />
            <IconButton
              icon="cloud-download"
              label="Load every remaining row (may use significant memory)"
              disabled={disabled || !cursorOpen || !navigation.canLoadAll}
              onClick={() => post({ type: "data-view/navigate", action: "load-all" })}
            />
            <IconButton
              icon="stop-circle"
              label="Cancel loading"
              disabled={!state.busy || state.applying}
              onClick={() => post({ type: "data-view/navigate", action: "cancel" })}
            />
          </div>
        ) : null}

        {editable ? (
          <div className="toolbar-group toolbar-edits">
            <span
              className={`toolbar-edit-count${editCount > 0 ? " pending" : ""}`}
              aria-live="polite"
              title={`${editCount} pending change${editCount === 1 ? "" : "s"}`}
            >
              <span className="codicon codicon-edit" aria-hidden="true" />
              {editCount}
            </span>
            <IconButton
              icon="discard"
              label="Discard pending changes"
              disabled={editCount === 0 || state.applying}
              onClick={() => post({ type: "data-view/discard" })}
            />
            <IconButton
              icon={state.applying ? "sync~spin" : "save"}
              label="Apply pending changes in one transaction (Ctrl/Cmd+S)"
              disabled={editCount === 0 || state.applying}
              primary={editCount > 0}
              onClick={() => post({ type: "data-view/apply" })}
            />
          </div>
        ) : null}

        <div className="toolbar-group toolbar-more">
          <IconButton
            icon="ellipsis"
            label="More actions"
            onClick={() => setMoreOpen((open) => !open)}
          />
          {moreOpen ? (
            <>
              <button
                type="button"
                className="column-menu-backdrop"
                aria-label="Close menu"
                onClick={() => setMoreOpen(false)}
              />
              <div className="column-menu toolbar-menu" role="menu">
                <MenuItem
                  label={showSql ? "Hide SQL" : "Show SQL"}
                  onSelect={() => {
                    setMoreOpen(false);
                    setShowSql((current) => !current);
                  }}
                />
                <MenuItem
                  label="Copy loaded rows as TSV"
                  disabled={!payload || payload.columns.length === 0}
                  onSelect={() => {
                    setMoreOpen(false);
                    if (payload) post({ type: "data-view/copy", text: resultAsTsv(payload) });
                  }}
                />
                {(["loaded", "all"] as const).flatMap((scope) =>
                  (["csv", "tsv", "json"] as const).map((format) => (
                    <MenuItem
                      key={`${scope}-${format}`}
                      label={`Export ${scope} rows as ${format.toUpperCase()}…`}
                      disabled={!payload || payload.columns.length === 0}
                      onSelect={() => {
                        setMoreOpen(false);
                        post({ type: "data-view/export", format, scope });
                      }}
                    />
                  )),
                )}
                <MenuItem
                  label="Open in a new Scratchpad"
                  onSelect={() => {
                    setMoreOpen(false);
                    post({ type: "data-view/open-sql" });
                  }}
                />
              </div>
            </>
          ) : null}
        </div>
      </header>

      <section
        className="data-view-tables"
        aria-label="Tables in the query"
        onDragOver={(event) => {
          if (badgeDragSource.current === undefined) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
        }}
        onDrop={(event) => {
          const from = badgeDragSource.current;
          if (from === undefined) return;
          event.preventDefault();
          badgeDragSource.current = undefined;
          setBadgeDragOver(undefined);
          const badges = [
            ...event.currentTarget.querySelectorAll<HTMLElement>(".data-view-table-badge"),
          ];
          let to = badges.length - 1;
          badges.forEach((badge, index) => {
            const bounds = badge.getBoundingClientRect();
            if (
              event.clientX < bounds.left + bounds.width / 2 &&
              to === badges.length - 1 &&
              index < to
            ) {
              to = index;
            }
          });
          if (from !== to) post({ type: "data-view/reorder-table", from, to });
        }}
      >
        <div className="toolbar-more">
          <IconButton
            icon="add"
            label="Add a column or a related table to the query"
            disabled={!query.structured}
            onClick={() => post({ type: "data-view/additions" })}
          />
          {additions ? (
            <>
              <button
                type="button"
                className="column-menu-backdrop"
                aria-label="Close"
                onClick={() => setAdditions(undefined)}
              />
              <div className="column-menu additions-menu" role="menu">
                {choices ? (
                  <div className="columns-menu-group">
                    <div className="columns-menu-heading">
                      {choices.title} — {choices.addition.label}
                    </div>
                    {choices.choices.map((choice) => (
                      <button
                        key={choice.index}
                        type="button"
                        role="menuitem"
                        className="column-menu-item addition-item"
                        title={choice.description}
                        onClick={() => {
                          setChoices(undefined);
                          setAdditions(undefined);
                          post({
                            type: "data-view/compose",
                            addition: choices.addition,
                            relationChoice: choice.index,
                          });
                        }}
                      >
                        <span className="codicon codicon-git-merge" aria-hidden="true" />
                        <span className="addition-label">{choice.label}</span>
                        <span className="addition-detail">{choice.description}</span>
                      </button>
                    ))}
                    <MenuItem
                      label="Cancel"
                      onSelect={() => {
                        setChoices(undefined);
                        setAdditions(undefined);
                      }}
                    />
                  </div>
                ) : null}
                {choices ? null : (
                  <input
                    className="additions-filter"
                    // biome-ignore lint/a11y/noAutofocus: the picker is opened by an explicit click
                    autoFocus
                    value={additionFilter}
                    placeholder="Filter columns and related tables…"
                    spellCheck={false}
                    onChange={(event) => setAdditionFilter(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") setAdditions(undefined);
                    }}
                  />
                )}
                {[...state.projection.tables.map((_table, index) => index), -1].map(
                  (tableIndex) => {
                    const table = tableIndex >= 0 ? state.projection.tables[tableIndex] : undefined;
                    const needle = additionFilter.trim().toLowerCase();
                    const items = additions.filter(
                      (item) =>
                        item.tableIndex === tableIndex &&
                        (!needle ||
                          item.label.toLowerCase().includes(needle) ||
                          item.detail.toLowerCase().includes(needle)),
                    );
                    if (items.length === 0) return null;
                    return (
                      <div
                        key={table ? table.tableOid : "others"}
                        className="columns-menu-group"
                        style={
                          table
                            ? ({ "--column-accent": tableAccent(table.accent) } as CSSProperties)
                            : undefined
                        }
                      >
                        <div className="columns-menu-heading">
                          {table ? `${table.schema}.${table.name}` : "Other tables and views"}
                        </div>
                        {items.map((item) => (
                          <button
                            key={`${item.kind}:${item.label}:${item.detail}`}
                            type="button"
                            role="menuitem"
                            className="column-menu-item addition-item"
                            title={
                              item.kind === "table"
                                ? `JOIN ${item.label} through ${item.detail}`
                                : `Add column ${item.label} (${item.detail})`
                            }
                            onClick={() => {
                              setAdditions(undefined);
                              post({ type: "data-view/compose", addition: item });
                            }}
                          >
                            <span
                              className={`codicon codicon-${item.kind === "table" ? "table" : "symbol-field"}`}
                              aria-hidden="true"
                            />
                            <span className="addition-label">{item.label}</span>
                            <span className="addition-detail">{item.detail}</span>
                          </button>
                        ))}
                      </div>
                    );
                  },
                )}
                {additions.length === 0 && !choices ? (
                  <div className="columns-menu-heading">Nothing to add</div>
                ) : null}
              </div>
            </>
          ) : null}
        </div>
        {state.source.kind === "sql" ? (
          <span className="data-view-title" title={query.text}>
            {dataViewSourceTitle(state.source)}
          </span>
        ) : null}
        <ol className="data-view-tables-list">
          {state.projection.tables.map((table, index) => (
            <li
              key={table.tableOid}
              className={`data-view-table-badge${badgeDragOver === index ? " drag-over" : ""}`}
              style={{ "--column-accent": tableAccent(table.accent) } as CSSProperties}
              title={`${table.schema}.${table.name} — its columns carry the same accent. Drag to move its columns.`}
              draggable={query.structured}
              onDragStart={(event) => {
                badgeDragSource.current = index;
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", `${table.schema}.${table.name}`);
              }}
              onDragOver={(event) => {
                if (badgeDragSource.current === undefined) return;
                event.preventDefault();
                event.stopPropagation();
                event.dataTransfer.dropEffect = "move";
                if (badgeDragOver !== index) setBadgeDragOver(index);
              }}
              onDragLeave={() =>
                setBadgeDragOver((current) => (current === index ? undefined : current))
              }
              onDrop={(event) => {
                const from = badgeDragSource.current;
                badgeDragSource.current = undefined;
                setBadgeDragOver(undefined);
                if (from === undefined) return;
                event.preventDefault();
                event.stopPropagation();
                if (from !== index) post({ type: "data-view/reorder-table", from, to: index });
              }}
              onDragEnd={() => {
                badgeDragSource.current = undefined;
                setBadgeDragOver(undefined);
              }}
            >
              <span className="data-view-table-swatch" aria-hidden="true" />
              <span className="data-view-table-schema">{table.schema}.</span>
              <span className="data-view-table-name">{table.name}</span>
              <button
                type="button"
                className="data-view-clause-action"
                title={`Remove ${table.schema}.${table.name} from the query`}
                aria-label={`Remove ${table.schema}.${table.name}`}
                disabled={!query.structured}
                onClick={() => post({ type: "data-view/remove-table", tableIndex: index })}
              >
                <span className="codicon codicon-close" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ol>
        {state.projection.tables.length === 0 && state.source.kind === "relation" ? (
          <span className="data-view-title" title={query.text}>
            {dataViewSourceTitle(state.source)}
          </span>
        ) : null}
      </section>
      <div className="data-view-query-line">
        <FilterInput
          value={query.whereText ?? ""}
          disabled={disabled || !query.structured}
          messaging={messaging}
          onApply={(text) => post({ type: "data-view/filter", text })}
        />
      </div>
      <div className="data-view-query-line data-view-order-line">
        <ol className="data-view-order">
          <span className="codicon codicon-list-ordered" aria-hidden="true" />
          {query.orderBy.length === 0 ? (
            <span className="data-view-order-empty">
              ORDER BY — click a column header (Shift+click adds a criterion)
            </span>
          ) : (
            query.orderBy.map((item, index) => {
              const ordinal = item.column ? columnNames.indexOf(item.column) : -1;
              const tableIndex = ordinal >= 0 ? state.projection.columnTable[ordinal] : undefined;
              const table =
                tableIndex === undefined ? undefined : state.projection.tables[tableIndex];
              const sortIndex = item.column
                ? columnSorts.findIndex((sort) => sort.column === item.column)
                : -1;
              return (
                <li
                  key={`${item.text}:${item.direction}`}
                  className={`data-view-clause active${sortDragOver === sortIndex && sortIndex >= 0 ? " drag-over" : ""}`}
                  style={
                    table
                      ? ({ "--column-accent": tableAccent(table.accent) } as CSSProperties)
                      : undefined
                  }
                  draggable={sortIndex >= 0}
                  onDragStart={(event) => {
                    sortDragSource.current = sortIndex;
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/plain", item.text);
                  }}
                  onDragOver={(event) => {
                    if (sortDragSource.current === undefined || sortIndex < 0) return;
                    event.preventDefault();
                    event.stopPropagation();
                    event.dataTransfer.dropEffect = "move";
                    if (sortDragOver !== sortIndex) setSortDragOver(sortIndex);
                  }}
                  onDragLeave={() =>
                    setSortDragOver((current) => (current === sortIndex ? undefined : current))
                  }
                  onDrop={(event) => {
                    const from = sortDragSource.current;
                    sortDragSource.current = undefined;
                    setSortDragOver(undefined);
                    if (from === undefined || sortIndex < 0 || from === sortIndex) return;
                    event.preventDefault();
                    event.stopPropagation();
                    const next = [...columnSorts];
                    const [moved] = next.splice(from, 1);
                    if (moved) next.splice(sortIndex, 0, moved);
                    applySorts(next);
                  }}
                  onDragEnd={() => {
                    sortDragSource.current = undefined;
                    setSortDragOver(undefined);
                  }}
                >
                  <span className="data-view-order-rank">{index + 1}</span>
                  <span
                    className={`codicon codicon-${item.direction === "ascending" ? "arrow-up" : "arrow-down"}`}
                    aria-hidden="true"
                  />
                  <span className="data-view-clause-text" title={item.text}>
                    {item.column ?? item.text}
                  </span>
                  {item.column ? (
                    <>
                      <button
                        type="button"
                        className="data-view-clause-action"
                        title="Invert direction"
                        onClick={() =>
                          applySorts(
                            columnSorts.map((sort) =>
                              sort.column === item.column
                                ? {
                                    column: sort.column,
                                    direction:
                                      sort.direction === "ascending" ? "descending" : "ascending",
                                  }
                                : sort,
                            ),
                          )
                        }
                      >
                        <span className="codicon codicon-arrow-swap" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="data-view-clause-action"
                        title="Remove this criterion"
                        onClick={() =>
                          applySorts(columnSorts.filter((sort) => sort.column !== item.column))
                        }
                      >
                        <span className="codicon codicon-close" aria-hidden="true" />
                      </button>
                    </>
                  ) : null}
                </li>
              );
            })
          )}
          {query.orderBy.length > 0 ? (
            <button
              type="button"
              className="icon-button"
              title="Remove the ORDER BY"
              aria-label="Remove the ORDER BY"
              onClick={() => applySorts([])}
            >
              <span className="codicon codicon-clear-all" aria-hidden="true" />
            </button>
          ) : null}
        </ol>
      </div>
      {showSql ? <pre className="data-view-sql">{query.text}</pre> : null}
      <section className="data-view-grid" aria-label="Rows">
        {payload && payload.columns.length > 0 ? (
          <ResultGrid
            payload={payload}
            serverSort={{ sorts: gridSorts, onSort: requestSort }}
            editing={editing}
            layout={layout}
          />
        ) : payload ? (
          <p className="result-empty">{payload.command} completed without a row set.</p>
        ) : null}
      </section>
      <footer className={`data-view-statusline${statusLine.severity === "error" ? " error" : ""}`}>
        <span className="data-view-statusline-text" role="status" aria-live="polite">
          {statusLine.text}
        </span>
      </footer>
    </main>
  );
}

const TABLE_ACCENTS = [
  "var(--vscode-charts-blue)",
  "var(--vscode-charts-purple)",
  "var(--vscode-charts-green)",
  "var(--vscode-charts-orange)",
  "var(--vscode-charts-yellow)",
  "var(--vscode-charts-red)",
];

function tableAccent(index: number): string {
  return TABLE_ACCENTS[index % TABLE_ACCENTS.length] ?? TABLE_ACCENTS[0] ?? "currentColor";
}

/** `server · database`, without repeating the database when the server name already ends with it. */
function associationLabel(serverName: string, database: string): string {
  return serverName.endsWith(`/${database}`) || serverName === database
    ? serverName
    : `${serverName} · ${database}`;
}
