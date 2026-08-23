import {
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { DebugResultCell } from "../../../dap/src/debugger/launch/index.js";
import { countLabel } from "../../../rows/src/countLabel.js";
import { whyNotFiltered } from "../../../rows/src/dataView/cellFilter.js";
import type { DataViewAddition, DataViewCompletion } from "../../../rows/src/dataView/dataView.js";
import {
  dataViewColumnKeys,
  dataViewKeysAt,
  dataViewRowKey,
  dataViewSourceTitle,
  dataViewWritableTable,
  defaultNullsOrder,
  describeDataViewChanges,
} from "../../../rows/src/dataView/dataView.js";
import type {
  DataViewRequest,
  DataViewResponse,
  DataViewSqlToken,
  DataViewState,
} from "../../../rows/src/dataView/dataViewProtocol.js";
import { rowOrder } from "../../../rows/src/dataView/rowOrder.js";
import { shownValues } from "../../../rows/src/dataView/shownValues.js";
import { followLinkRequest } from "../../../rows/src/followLink.js";
import { hasWorkbenchTreeDrag } from "../cockpit/dragAndDrop.js";
import {
  type GridSelection,
  selectedOrdinals,
  selectedRowCount,
  selectedRows,
} from "../results/gridSelection.js";
import { IconButton } from "../results/IconButton.js";
import { anchorUnder, Menu, type MenuEntry, type MenuPoint } from "../results/Menu.js";
import { Modal } from "../results/Modal.js";
import { type GridEditing, type GridLayout, ResultGrid } from "../results/ResultGrid.js";
import { ResultNavigation } from "../results/ResultNavigation.js";
import { nextResultSort, resultRowRange, resultRowSummary } from "../results/resultFormatting.js";
import type { WebviewMessaging } from "../webviewPage.js";
import { ExportDialog, type ExportSource } from "./ExportDialog.js";
import { FilterHighlight, useScrollFollower } from "./FilterHighlight.js";
import { useReorderable } from "./reorder.js";
import { nextRequestId } from "./requests.js";
import { SqlPanel } from "./SqlPanel.js";

export type DataViewMessaging = WebviewMessaging<DataViewRequest, DataViewResponse>;

interface Notice {
  message: string;
  severity: "info" | "error";
}

/**
 * Reading rows out of a file and into the table is not built yet, so nothing offers it. The
 * control and the dialog stay here, and the rule that says where rows could go is the same one
 * adding a row already asks: what is missing is the file, not the place to put it. Turning this
 * to true is what offering it will be.
 */
const IMPORT_ROWS_OFFERED: boolean = false;

const COMPLETION_DEBOUNCE_MS = 120;
const COMPLETIONS_ID = "data-view-filter-completions";

/** The identifier a combobox points at to say which proposal is current. */
function completionId(index: number): string {
  return `${COMPLETIONS_ID}-${index}`;
}

/**
 * WHERE editor: multi-line (Shift+Enter), Enter applies, completions come from the SQL authoring
 * server through the host (Ctrl+Space or while typing).
 *
 * Running the filter does not take the caret away from the line it was typed on: while the rows
 * are being fetched the field refuses keys but keeps them, because a disabled field loses the
 * focus to the page and a reader who pressed Enter is still writing here. Only a query the engine
 * cannot rewrite disables it outright — there, the field has nothing to do.
 */
function FilterInput({
  value,
  busy,
  unavailable,
  messaging,
  onApply,
}: {
  value: string;
  busy: boolean;
  unavailable: boolean;
  messaging: DataViewMessaging;
  onApply(text: string): void;
}) {
  const [draft, setDraft] = useState(value);
  const [items, setItems] = useState<DataViewCompletion[]>([]);
  const [named, setNamed] = useState<readonly DataViewSqlToken[]>([]);
  const [selected, setSelected] = useState(0);
  const [focused, setFocused] = useState(false);
  const requestId = useRef(0);
  const tokenRequestId = useRef(0);
  const timer = useRef<number | undefined>(undefined);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const highlight = useRef<HTMLDivElement>(null);
  const dirty = draft.trim() !== value.trim();

  const followScroll = useScrollFollower(textarea, highlight, draft);

  useEffect(() => {
    if (!focused) setDraft(value);
  }, [value, focused]);

  useEffect(() => {
    tokenRequestId.current = nextRequestId();
    const requested = tokenRequestId.current;
    // Nothing typed, nothing to colour: an empty condition would cost a round trip to answer none.
    if (draft.trim() === "") {
      setNamed([]);
      return;
    }
    const timer = window.setTimeout(
      () =>
        messaging.post({
          type: "data-view/tokens",
          requestId: requested,
          of: { filter: draft },
        }),
      COMPLETION_DEBOUNCE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [draft, messaging]);

  useEffect(
    () =>
      messaging.subscribe((message) => {
        if (message.type === "data-view/tokens" && message.requestId === tokenRequestId.current) {
          setNamed(message.tokens);
          return;
        }
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
      requestId.current = nextRequestId();
      messaging.post({ type: "data-view/complete", requestId: requestId.current, text, offset });
    }, COMPLETION_DEBOUNCE_MS);
  };
  const close = () => {
    setItems([]);
    requestId.current = nextRequestId();
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
    if (busy) return;
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
    <div className={`filter-input${dirty ? " dirty" : ""}`}>
      <span className="codicon codicon-filter data-view-clause-mark" aria-hidden="true" />
      <div className="filter-field">
        <FilterHighlight text={draft} named={named} ref={highlight} />
        <textarea
          ref={textarea}
          className="filter-textarea"
          rows={rows}
          value={draft}
          placeholder="WHERE … (Enter runs, Shift+Enter new line, Ctrl+Space completes)"
          spellCheck={false}
          disabled={unavailable}
          readOnly={busy}
          aria-label="Filter (WHERE)"
          // A field with proposals is a combobox: the list is its own, and one entry is current.
          role="combobox"
          aria-expanded={items.length > 0}
          aria-controls={COMPLETIONS_ID}
          aria-autocomplete="list"
          {...(items.length > 0 ? { "aria-activedescendant": completionId(selected) } : {})}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            window.setTimeout(close, 150);
          }}
          onChange={(event) => {
            setDraft(event.target.value);
            requestCompletions(event.target.value, event.target.selectionStart);
          }}
          onScroll={followScroll}
          onSelect={followScroll}
          onKeyDown={handleKey}
        />
      </div>
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
      {items.length > 0 ? (
        <div
          className="filter-completions"
          id={COMPLETIONS_ID}
          role="listbox"
          aria-label="Completions"
        >
          {items.slice(0, 12).map((item, index) => (
            <button
              key={`${item.kind ?? ""}:${item.label}:${item.detail ?? ""}:${item.insertText}`}
              type="button"
              id={completionId(index)}
              role="option"
              aria-selected={index === selected}
              className={`filter-completion${index === selected ? " selected" : ""}`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => accept(item)}
            >
              {item.kind ? <span className="filter-completion-kind">{item.kind}</span> : null}
              <span className="filter-completion-label">{item.label}</span>
              {item.detail ? <span className="filter-completion-detail">{item.detail}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** What pressing a criterion does, said the same way to a pointer and to a screen reader. */
function turningOver(item: { text: string; direction: "ascending" | "descending" }): string {
  const other = item.direction === "ascending" ? "descending" : "ascending";
  return `Sorted ${item.direction} by ${item.text} — click for ${other}`;
}

/** Where this criterion's NULLs go, and what pressing it would change. */
function whereNullsGo(
  asWritten: "first" | "last",
  isDefault: boolean,
  direction: "ascending" | "descending",
): string {
  if (isDefault) {
    return `NULLs ${asWritten} — what PostgreSQL does for ${direction} order. Click to put them ${asWritten === "last" ? "first" : "last"}.`;
  }
  return `NULLs ${asWritten}, asked for. Click to leave them where PostgreSQL puts them.`;
}

/** The menus the toolbar opens. One is open at a time, so which one is one fact, held once. */
type ToolbarMenu = "columns" | "more" | "changes";

export function DataViewApp({ messaging }: { messaging: DataViewMessaging }) {
  const [state, setState] = useState<DataViewState>();
  const [progress, setProgress] = useState<number>();
  const [notice, setNotice] = useState<Notice>();
  /** The failure the reader has read and put away, so it is not shown again unchanged. */
  const [dismissed, setDismissed] = useState<string>();
  const [showSql, setShowSql] = useState(false);
  /** Whether the reader turned editing on; the gutter, the edit bar and cell editing follow it. */
  const [editMode, setEditMode] = useState(false);
  /** Whether the value the cursor is on is shown whole, beside the grid. */
  const [inspecting, setInspecting] = useState(false);
  /** What is selected in the grid, held here because the edit bar acts on it. */
  const [selection, setSelection] = useState<GridSelection>();
  /*
   * Which toolbar menu is open and where it opened: a menu is drawn under the control that asked
   * for it, and there is nothing else to remember about it.
   */
  const [toolbar, setToolbar] = useState<{ at: MenuPoint; which: ToolbarMenu }>();
  /** Which dialog is open over the view: rows coming in from a file, or rows going out to one. */
  const [transfer, setTransfer] = useState<"import" | "export">();
  const [dropActive, setDropActive] = useState(false);
  const [additions, setAdditions] = useState<DataViewAddition[]>();
  /** Where the proposals were asked for, which is where the paths to choose between open too. */
  const [additionsAt, setAdditionsAt] = useState<MenuPoint>();
  const [additionFilter, setAdditionFilter] = useState("");
  const [choices, setChoices] = useState<{
    addition: DataViewAddition;
    title: string;
    choices: Array<{ index: number; label: string; description: string }>;
  }>();

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
    // Nothing is editable, and no gutter shows, until the reader asks for it.
    if (!state || !editMode || state.editability.tables.length === 0) return undefined;
    // The grid asks for these once per rendered cell, on every scroll: indexed, never scanned.
    const tablesByOid = new Map(
      state.editability.tables.map((table) => [table.tableOid, table] as const),
    );
    const editsByRow = new Map(
      state.edits.map((edit) => [`${edit.ordinal}:${dataViewRowKey(edit)}`, edit] as const),
    );
    // Rows go one table at a time; a join gives the grid no table to take them from or put them in.
    const writable = dataViewWritableTable(state.editability);
    const onlyTable = "reason" in writable ? undefined : writable;
    const removedKeys = new Set(state.removedRows.map((row) => dataViewRowKey(row)));
    /** Which stored row a grid row is, for one of the tables the query projects. */
    const identityOf = (
      table: { tableOid: number; keyOrdinals: number[] },
      row: readonly DebugResultCell[],
    ) => ({
      tableOid: table.tableOid,
      key: table.keyOrdinals.map((keyOrdinal) => row[keyOrdinal]?.value ?? null),
    });
    const rowIdentity = (row: readonly DebugResultCell[], ordinal: number) => {
      const policy = state.editability.columns[ordinal];
      if (!policy?.editable) return undefined;
      const table = tablesByOid.get(policy.tableOid);
      return table ? identityOf(table, row) : undefined;
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
      /**
       * A row belongs to one table or to none the grid may choose between. Over a join the cells
       * stay editable and the gutter stays away, which is the whole of the rule.
       */
      ...(onlyTable
        ? {
            rows: {
              // Asked per rendered row on every scroll frame; no row removed is the usual state.
              isRemoved: (row) =>
                removedKeys.size > 0 && removedKeys.has(dataViewRowKey(identityOf(onlyTable, row))),
              added: state.addedRows,
              drop: (localId) => messaging.post({ type: "data-view/drop-row", localId }),
              fill: (localId, values) =>
                messaging.post({ type: "data-view/fill-row", localId, values }),
              appendPasted: (values, above) =>
                messaging.post({ type: "data-view/add-row", values, above }),
            },
          }
        : {}),
    };
  }, [state, messaging, editMode]);

  // Both live above the early return, where hooks must be: what may move and what moving means are
  // read from this render's own state, so the handlers a list spreads are always the fresh ones.
  const tableOrder = useReorderable(
    () => state?.query.structured ?? false,
    (from, to) => messaging.post({ type: "data-view/reorder-table", from, to }),
  );
  const sortOrder = useReorderable(
    (index) => index >= 0,
    (from, to) => {
      const sorts = (state?.query.orderBy ?? []).flatMap((item) =>
        item.column ? [{ column: item.column, direction: item.direction }] : [],
      );
      const [moved] = sorts.splice(from, 1);
      if (!moved) return;
      sorts.splice(to, 0, moved);
      messaging.post({ type: "data-view/sort", sorts });
    },
  );

  /** Where each row sits in the grid, which is what a selection and a new row are counted in. */
  /*
   * The proposals as they are shown: grouped under the table or the schema they belong to. The
   * order they are read in is the order the arrow keys walk, which the menu takes from the order
   * they are given in.
   */
  const additionGroups = useMemo(() => {
    if (!additions) return [];
    const needle = additionFilter.trim().toLowerCase();
    const matches = additions.filter(
      (item) =>
        !needle ||
        item.label.toLowerCase().includes(needle) ||
        item.detail.toLowerCase().includes(needle),
    );
    const groups: { heading: string; accent?: string; items: DataViewAddition[] }[] = [];
    for (const tableIndex of [...(state?.projection.tables ?? []).map((_t, index) => index), -1]) {
      const table = tableIndex >= 0 ? state?.projection.tables[tableIndex] : undefined;
      const mine = matches.filter((item) => item.tableIndex === tableIndex);
      /*
       * Relations that join nothing in the query are every other relation of the database: one
       * list of them is unreadable, so they are shown under the schema they belong to.
       */
      const byGroup = new Map<string | undefined, DataViewAddition[]>();
      for (const item of mine) byGroup.set(item.group, [...(byGroup.get(item.group) ?? []), item]);
      for (const [group, items] of byGroup) {
        groups.push({
          heading: table ? `${table.schema}.${table.name}` : (group ?? "Other tables and views"),
          ...(table ? { accent: tableAccent(table.accent) } : {}),
          items,
        });
      }
    }
    return groups;
  }, [additions, additionFilter, state?.projection.tables]);
  const shownRows = useMemo(
    () => rowOrder(state?.addedRows ?? [], state?.payload?.rows.length ?? 0),
    [state],
  );
  /*
   * The loaded row a new one would go over: the one the reader is on. A new row appears just above
   * it, and above the first row when the reader has not moved off it.
   */
  const addAbove = useMemo(() => {
    if (!selection) return 0;
    const shown = shownRows.at(selection.anchor.row);
    return "added" in shown ? shown.added.above : shown.loaded;
  }, [selection, shownRows]);
  /*
   * What the edit bar says and what it may act on. A rectangle of cells is not a set of rows: the
   * delete control stays out of reach until the reader has selected rows in the gutter.
   */
  const selected = useMemo(() => {
    const table = state?.editability.tables.length === 1 ? state.editability.tables[0] : undefined;
    if (selection?.kind !== "rows" || !table || !state?.payload) return { rows: [], added: [] };
    const loaded = state.payload.rows ?? [];
    const { first, last } = selectedRows(selection);
    const picked: { added: string[]; rows: { tableOid: number; key: (string | null)[] }[] } = {
      added: [],
      rows: [],
    };
    for (let index = first; index <= last; index += 1) {
      const shown = shownRows.at(index);
      if ("added" in shown) {
        picked.added.push(shown.added.localId);
        continue;
      }
      const row = loaded[shown.loaded];
      if (row)
        picked.rows.push({
          tableOid: table.tableOid,
          key: table.keyOrdinals.map((keyOrdinal) => row[keyOrdinal]?.value ?? null),
        });
    }
    return picked;
  }, [selection, state, shownRows]);
  const selectedCount = selected.rows.length + selected.added.length;

  if (!state) {
    return (
      <main className="data-view">
        <p className="data-view-status">Opening the Data View…</p>
      </main>
    );
  }

  const payload = state.payload;
  // Rows come in one table at a time, exactly as they are added one at a time.
  const writableTable = dataViewWritableTable(state.editability);
  const addable =
    "reason" in writableTable ? `Rows can only be added ${writableTable.reason}` : undefined;
  const importable =
    "reason" in writableTable ? `Rows can only be imported ${writableTable.reason}` : undefined;
  const navigation = payload?.navigation;
  // The same rules the Scratchpad output applies, read from the one place that states them.
  const navigationState = {
    navigation,
    // A result being written to is not navigable either: the rule states it, no caller overrides it.
    busy: state.busy || state.applying,
    closed: state.status !== "ready" || Boolean(state.message),
  };
  const disabled = state.busy || state.applying;
  const editCount = state.edits.length + state.removedRows.length + state.addedRows.length;
  const editable = state.editability.tables.length > 0;
  // A Data View with nothing in it is a legal starting state, not a broken query: the reader adds
  // the first relation and it becomes the base the rest composes onto.
  const emptyQuery = state.query.text.trim().length === 0;
  const query = state.query;
  const columnNames = payload?.columns.map((column) => column.name) ?? [];
  /** Grid-column sorts, in ORDER BY order (items that are not grid columns are kept as text only). */
  const columnSorts = query.orderBy.flatMap((item) =>
    item.column
      ? [
          {
            column: item.column,
            direction: item.direction,
            ...(item.nulls ? { nulls: item.nulls } : {}),
          },
        ]
      : [],
  );
  const gridSorts = columnSorts.flatMap((sort) => {
    const columnIndex = columnNames.indexOf(sort.column);
    return columnIndex >= 0 ? [{ columnIndex, direction: sort.direction }] : [];
  });
  const columnKeys = dataViewColumnKeys(state.projection, columnNames);
  // Identity and relationship values: what a reader who does not write SQL has no use for. The
  // host decides whether they start hidden; the view only offers to flip them.
  const technicalKeys = dataViewKeysAt(columnKeys, state.editability.technicalOrdinals);
  const technicalHidden =
    technicalKeys.length > 0 && technicalKeys.every((key) => query.hidden.includes(key));

  const hiddenOrdinals = new Set(
    columnKeys.flatMap((key, ordinal) => (query.hidden.includes(key) ? [ordinal] : [])),
  );
  const visibleOrdinals = columnNames.flatMap((_name, ordinal) =>
    hiddenOrdinals.has(ordinal) ? [] : [ordinal],
  );
  /*
   * What the export dialog needs to know about the rows behind each of its scopes. The values come
   * from the same place the clipboard takes them, so what is previewed and written is what the
   * grid shows — pending edits and rows waiting to be added included.
   */
  /* The type a column was declared with — `character(2)`, not `character` — for a CREATE TABLE. */
  const declaredType = (ordinal: number): string | undefined => {
    const policy = state.editability.columns[ordinal];
    return policy?.editable ? policy.dataType : payload?.columns[ordinal]?.typeName;
  };
  /* The table INSERT statements would be written into; a query over several has no single one. */
  const exportTable =
    state.editability.tables.length === 1 && state.editability.tables[0]
      ? `${state.editability.tables[0].schema}.${state.editability.tables[0].name}`
      : undefined;
  const exportSource = ((): ExportSource => {
    const columns = payload?.columns ?? [];
    const loadedRows = payload?.rows ?? [];
    const order = shownRows;
    const shownOrdinals = visibleOrdinals;
    const band = selection ? selectedRows(selection) : undefined;
    const selectedOnly =
      selection && band
        ? { ordinals: selectedOrdinals(selection, shownOrdinals), from: band.first, to: band.last }
        : { ordinals: [], from: 0, to: -1 };
    return {
      valuesFor: (scope) =>
        shownValues({
          columns,
          rows: loadedRows,
          order,
          editFor: editing?.editFor,
          typeFor: declaredType,
          ...(scope === "selection"
            ? selectedOnly
            : { ordinals: shownOrdinals, from: 0, to: order.count - 1 }),
        }),
      counts: {
        selection: selectedOnly.to - selectedOnly.from + 1,
        loaded: order.count,
        all: payload?.rowCount,
      },
      table: exportTable,
    };
  })();
  const selectionSummary = !selection
    ? "Nothing selected"
    : selection.kind === "rows"
      ? `${countLabel(selectedRowCount(selection), "row")} selected`
      : `${countLabel(selectedRowCount(selection), "row")} × ${countLabel(selectedOrdinals(selection, visibleOrdinals).length, "column")}`;
  /*
   * Anything the reader asks for starts the failure over: what stood was about the last attempt,
   * and this is a new one. An error is never dismissed on its own, so something has to — and a
   * reader who dismissed one and then asked again must be told again, even in the same words.
   */
  const post = (message: DataViewRequest) => {
    if (notice?.severity === "error") setNotice(undefined);
    setDismissed(undefined);
    messaging.post(message);
  };
  /*
   * What went wrong, whatever it was: a query that failed to load, or a write the database
   * refused. It is shown as a band across the top of the view rather than in the corner of the
   * status line — a reader who pressed Apply and reads nothing takes the press for having done
   * nothing, while the changes are in fact still held.
   */
  const failure =
    state.status === "error"
      ? (state.message ?? "Error")
      : notice?.severity === "error"
        ? notice.message
        : undefined;
  const alert = failure === dismissed ? undefined : failure;
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
        cellMenu: (ordinal, value) => {
          /*
           * Two of the three reasons a value cannot be filtered on are visible from here, so the
           * menu says them rather than offering the action and letting a notice take it back. The
           * third — a query that no longer names the table — only the host can see.
           */
          const refused = whyNotFiltered({
            name: columnNames[ordinal] ?? "",
            ...(state.payload?.columns[ordinal]?.typeName === undefined
              ? {}
              : { typeName: state.payload.columns[ordinal].typeName }),
            tableIndex: state.projection.columnTable[ordinal],
          });
          const filter = (negate: boolean) => ({
            kind: "action" as const,
            label: negate ? "Exclude" : "Filter",
            ...(refused === undefined ? {} : { disabled: refused }),
            run: () => post({ type: "data-view/filter-cell", ordinal, value, negate }),
          });
          return [
            filter(false),
            filter(true),
            { kind: "action", label: "Inspect", run: () => setInspecting(true) },
          ];
        },
        columnMenu: (ordinal) => {
          const column = columnNames[ordinal] ?? "";
          const visible = columnNames
            .map((_name, index) => index)
            .filter((index) => !hiddenOrdinals.has(index));
          const position = visible.indexOf(ordinal);
          const left = position > 0 ? visible[position - 1] : undefined;
          const right = position >= 0 ? visible[position + 1] : undefined;
          const does = (label: string, run: () => void): MenuEntry => ({
            kind: "action",
            label,
            run,
          });
          return [
            does("Sort ascending", () => sortBy(ordinal, "ascending")),
            does("Sort descending", () => sortBy(ordinal, "descending")),
            ...(columnSorts.length > 0
              ? [
                  does("Add ascending sort", () => sortBy(ordinal, "ascending", true)),
                  does("Add descending sort", () => sortBy(ordinal, "descending", true)),
                  does("Clear sort", () => applySorts([])),
                ]
              : []),
            does("Hide column", () =>
              post({ type: "data-view/hide", column: columnKeys[ordinal] ?? column }),
            ),
            ...(left === undefined
              ? []
              : [
                  does("Move left", () =>
                    post({ type: "data-view/reorder", from: ordinal, to: left }),
                  ),
                ]),
            ...(right === undefined
              ? []
              : [
                  does("Move right", () =>
                    post({ type: "data-view/reorder", from: ordinal, to: right }),
                  ),
                ]),
            does("Edit projection in query…", () =>
              post({ type: "data-view/edit-query", clause: "select" }),
            ),
          ];
        },
      }
    : undefined;
  /*
   * What each toolbar menu offers, as entries. The menu draws them, walks them and dismisses
   * itself; what is worth offering, and what each thing does, is the view's to say.
   *
   * Each is a function, and the one that is open is the only one called: a reader moving the
   * cursor through the grid re-renders this view, and the changes waiting to be applied are not
   * described again on every move for a drawer nobody opened.
   */
  const columnEntries = (): MenuEntry[] => [
    ...[...state.projection.tables.map((_table, index) => index), undefined].flatMap(
      (tableIndex) => {
        const ordinals = columnNames.flatMap((_name, ordinal) =>
          state.projection.columnTable[ordinal] === tableIndex ? [ordinal] : [],
        );
        if (ordinals.length === 0) return [];
        const table = tableIndex === undefined ? undefined : state.projection.tables[tableIndex];
        const accent = table ? tableAccent(table.accent) : undefined;
        return [
          {
            kind: "group" as const,
            heading: table ? `${table.schema}.${table.name}` : "Computed values",
            ...(accent ? { accent } : {}),
            entries: ordinals.map((ordinal): MenuEntry => {
              const name = columnNames[ordinal] ?? "";
              const key = columnKeys[ordinal] ?? name;
              const hidden = hiddenOrdinals.has(ordinal);
              return {
                kind: "check",
                label: name,
                checked: !hidden,
                run: () =>
                  post(
                    hidden
                      ? { type: "data-view/unhide", column: key }
                      : { type: "data-view/hide", column: key },
                  ),
              };
            }),
          },
        ];
      },
    ),
    /* Identity and relationship columns turn on and off together, the way one of them does. */
    ...(technicalKeys.length > 0
      ? [
          {
            kind: "check" as const,
            label: countLabel(technicalKeys.length, "key column"),
            checked: !technicalHidden,
            run: () => post({ type: "data-view/technical-columns", hidden: !technicalHidden }),
          },
        ]
      : []),
    /* Bringing them all back is not one more column: it is what to do when too many are gone. */
    ...(query.hidden.length > 0
      ? [
          { kind: "separator" as const },
          {
            kind: "action" as const,
            label: "Show all columns",
            run: () => post({ type: "data-view/unhide" }),
          },
        ]
      : []),
  ];

  const moreEntries = (): MenuEntry[] => [
    {
      kind: "action",
      label: "Edit in a SQL editor…",
      run: () => post({ type: "data-view/edit-query" }),
    },
    {
      kind: "action",
      label: "Open in a Scratchpad",
      run: () => post({ type: "data-view/open-sql" }),
    },
  ];

  /* The changes waiting to be applied: a menu to read, so what it holds is read and not run. */
  const changeEntries = (): MenuEntry[] => [
    {
      kind: "group",
      heading: `${countLabel(editCount, "change")} waiting to be applied`,
      entries: describeDataViewChanges(
        state.edits,
        state.removedRows,
        state.addedRows,
        state.editability,
      ).map(
        (change): MenuEntry => ({
          kind: "note",
          content: (
            <div className="pending-edit">
              <span className="pending-edit-target">
                {change.table} · {change.row}
              </span>
              {change.kind === "delete" ? (
                <span className="pending-edit-change">
                  <span className="pending-edit-removal">The whole row goes away</span>
                </span>
              ) : change.kind === "insert" ? (
                <span className="pending-edit-change">
                  <span className="pending-edit-insertion">A new row</span>
                </span>
              ) : (
                <span className="pending-edit-change">
                  <span className="pending-edit-column">{change.column}</span>
                  <span className="pending-edit-original">{change.original ?? "NULL"}</span>
                  <span className="codicon codicon-arrow-right" aria-hidden="true" />
                  <span className="pending-edit-value">{change.value ?? "NULL"}</span>
                </span>
              )}
            </div>
          ),
        }),
      ),
    },
  ];

  /* The toolbar's three menus, named where they are offered rather than where they are drawn. */
  const toolbarMenus: Record<ToolbarMenu, { label: string; entries: () => MenuEntry[] }> = {
    columns: { label: "Columns", entries: columnEntries },
    more: { label: "More actions", entries: moreEntries },
    changes: { label: "Pending changes", entries: changeEntries },
  };
  const openToolbarMenu = (event: ReactMouseEvent<HTMLElement>, which: ToolbarMenu) =>
    setToolbar({ at: anchorUnder(event.currentTarget), which });
  /* A drawer of changes with nothing left in it is closed, not opened on an empty list. */
  const openMenu = toolbar && (toolbar.which !== "changes" || editCount > 0) ? toolbar : undefined;

  /*
   * The proposals go, the point they were asked at stays: choosing between join paths closes the
   * proposals and opens the paths in their place, under the same control.
   */
  const closeAdditions = () => {
    setAdditions(undefined);
    setChoices(undefined);
  };
  /*
   * What can be added to the query: the proposals, or — when one of them can be reached by more
   * than one path — the paths to choose between, which take the whole menu until one is taken.
   */
  const additionEntries = (): MenuEntry[] =>
    choices
      ? [
          {
            kind: "group",
            heading: `${choices.title} — ${choices.addition.label}`,
            entries: [
              ...choices.choices.map(
                (choice): MenuEntry => ({
                  kind: "action",
                  icon: "git-merge",
                  label: choice.label,
                  detail: choice.description,
                  title: choice.description,
                  run: () =>
                    post({
                      type: "data-view/compose",
                      addition: choices.addition,
                      relationChoice: choice.index,
                    }),
                }),
              ),
              /* Leaving is all it does: taking an action is what dismisses a menu. */
              { kind: "action", label: "Cancel", run: () => {} },
            ],
          },
        ]
      : additionGroups.length > 0
        ? additionGroups.map(
            (group): MenuEntry => ({
              kind: "group",
              heading: group.heading,
              ...(group.accent ? { accent: group.accent } : {}),
              entries: group.items.map(
                (item): MenuEntry => ({
                  kind: "action",
                  icon: item.kind === "table" ? "table" : "symbol-field",
                  label: item.label,
                  detail: item.detail,
                  title:
                    item.kind !== "table"
                      ? `Add column ${item.label} (${item.detail})`
                      : emptyQuery
                        ? // Nothing to join to yet: this relation becomes the base.
                          `Start the query with ${item.label}`
                        : `JOIN ${item.label} through ${item.detail}`,
                  run: () => post({ type: "data-view/compose", addition: item }),
                }),
              ),
            }),
          )
        : [{ kind: "group", heading: "Nothing to add", entries: [] }];

  // One fixed status line: messages never push the grid around.
  const statusLine: { text: string; severity: "info" | "error" } =
    // A failure has a band of its own across the top; saying it twice is saying it once too often.
    notice && !failure
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
      <header className="data-view-toolbar" role="toolbar" aria-label="Data view actions">
        {/*
          What a reader reaches for most often sits on the left and what they reach for least on
          the right: composing the query, walking the rows and choosing the columns they want to
          see are the work; reading the SQL and exporting are what happens once in a session.
        */}
        <div className="toolbar-side toolbar-side-often">
          <div className="toolbar-group toolbar-identity">
            <span
              className="data-view-association"
              title={`Connexion Association: ${state.serverName} · ${state.source.database}`}
            >
              <span className="codicon codicon-database" aria-hidden="true" />
              {associationLabel(state.serverName, state.source.database)}
            </span>
          </div>

          <div className="toolbar-group">
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
          </div>

          <div className="toolbar-group">
            <IconButton
              icon={query.hidden.length > 0 ? "eye-closed" : "list-selection"}
              label={
                query.hidden.length > 0
                  ? `Columns (${query.hidden.length} hidden)`
                  : "Show or hide columns"
              }
              disabled={!query.structured || columnNames.length === 0}
              expanded={toolbar?.which === "columns"}
              onClick={(event) => openToolbarMenu(event, "columns")}
              text={query.hidden.length > 0 ? query.hidden.length : undefined}
            />
          </div>
        </div>

        <div className="toolbar-side toolbar-side-seldom">
          <div className="toolbar-group">
            {IMPORT_ROWS_OFFERED ? (
              <IconButton
                icon="arrow-circle-down"
                label={importable ?? "Import rows from a file…"}
                disabled={importable !== undefined}
                onClick={() => setTransfer("import")}
              />
            ) : null}
            <IconButton
              icon="arrow-circle-up"
              label="Export rows to a file…"
              disabled={!payload || payload.columns.length === 0}
              onClick={() => setTransfer("export")}
            />
          </div>

          <div className="toolbar-group">
            <IconButton
              icon="code"
              label={showSql ? "Hide the SQL" : "Show the SQL"}
              onClick={() => setShowSql((current) => !current)}
              primary={showSql}
            />
          </div>
          <div className="toolbar-group">
            <IconButton
              icon="ellipsis"
              label="More actions"
              expanded={toolbar?.which === "more"}
              onClick={(event) => openToolbarMenu(event, "more")}
            />
          </div>
        </div>
      </header>

      {/* Whichever of the toolbar's menus is open, drawn under the control that asked for it. */}
      {openMenu ? (
        <Menu
          at={openMenu.at}
          label={toolbarMenus[openMenu.which].label}
          entries={toolbarMenus[openMenu.which].entries()}
          onClose={() => setToolbar(undefined)}
        />
      ) : null}

      {/* What went wrong, at full width across the top, where a reader cannot walk past it. */}
      {alert ? (
        <div className="data-view-alert" role="alert">
          <span className="codicon codicon-error" aria-hidden="true" />
          <span className="data-view-alert-text">{alert}</span>
          <button
            type="button"
            className="data-view-alert-dismiss"
            title="Dismiss"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setDismissed(alert)}
          >
            <span className="codicon codicon-close" aria-hidden="true" />
          </button>
        </div>
      ) : null}

      {IMPORT_ROWS_OFFERED && transfer === "import" ? (
        <Modal
          title="Import rows"
          description="Reading rows out of a file and into the table is not built yet."
          onClose={() => setTransfer(undefined)}
        >
          <p className="modal-pending">
            This is where a file is chosen, its columns lined up with the table's, and the rows it
            holds shown before any of them are written.
          </p>
        </Modal>
      ) : null}

      {transfer === "export" && payload ? (
        <ExportDialog
          source={exportSource}
          title={query.structured ? (state.projection.tables[0]?.name ?? "result") : "result"}
          onClose={() => setTransfer(undefined)}
          onExport={(choice, scope) => {
            setTransfer(undefined);
            post({
              type: "data-view/export",
              choice,
              scope,
              ...(scope === "selection" && selection
                ? {
                    selected: {
                      from: selectedRows(selection).first,
                      to: selectedRows(selection).last,
                      ordinals: selectedOrdinals(selection, visibleOrdinals),
                    },
                  }
                : {}),
            });
          }}
        />
      ) : null}

      {showSql ? (
        <SqlPanel sql={query.text} messaging={messaging} onClose={() => setShowSql(false)} />
      ) : null}

      <section
        className="data-view-tables"
        aria-label="Tables in the query"
        {...tableOrder.containerProps((event) =>
          [...event.currentTarget.querySelectorAll<HTMLElement>(".data-view-table-badge")].map(
            (badge) => {
              const bounds = badge.getBoundingClientRect();
              return bounds.left + bounds.width / 2;
            },
          ),
        )}
      >
        <IconButton
          icon="add"
          label={
            emptyQuery
              ? "Add the first table of the query"
              : "Add a column or a related table to the query"
          }
          disabled={!query.structured && !emptyQuery}
          expanded={additions !== undefined}
          onClick={(event) => {
            setAdditionsAt(anchorUnder(event.currentTarget));
            post({ type: "data-view/additions" });
          }}
        />
        {additions && additionsAt ? (
          <Menu
            at={additionsAt}
            label={emptyQuery ? "Tables to start the query with" : "Columns and tables to add"}
            entries={additionEntries()}
            /*
             * A reader types, walks down and presses Enter without leaving the field. Choosing
             * between paths has nothing to narrow, so there the menu walks itself.
             */
            header={
              choices ? undefined : (
                <input
                  value={additionFilter}
                  placeholder="Filter columns and related tables…"
                  spellCheck={false}
                  onChange={(event) => setAdditionFilter(event.target.value)}
                />
              )
            }
            onClose={closeAdditions}
          />
        ) : null}
        <ol className="data-view-tables-list">
          {state.projection.tables.map((table, index) => (
            <li
              key={table.tableOid}
              className={`data-view-table-badge${tableOrder.isTarget(index) ? " drag-over" : ""}`}
              style={{ "--column-accent": tableAccent(table.accent) } as CSSProperties}
              title={`${table.schema}.${table.name} — its columns carry the same accent. Drag to move its columns.`}
              {...tableOrder.itemProps(index, `${table.schema}.${table.name}`)}
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
                onClick={() =>
                  post({ type: "data-view/remove-table", schema: table.schema, name: table.name })
                }
              >
                <span className="codicon codicon-close" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ol>
        {/*
         * Where the rows come from, said once. A badge per table says it in full and can act on
         * it, so the title only stands in when there is no badge to say it — a query over
         * something that is not a table, or one that has yet to name a table at all.
         */}
        {state.projection.tables.length === 0 ? (
          <span className="data-view-title" title={query.text}>
            {emptyQuery ? "No table yet — add one with +" : dataViewSourceTitle(state.source)}
          </span>
        ) : null}
      </section>
      <div className="data-view-query-line">
        <FilterInput
          value={query.whereText ?? ""}
          busy={disabled}
          unavailable={!query.structured}
          messaging={messaging}
          onApply={(text) => post({ type: "data-view/filter", text })}
        />
      </div>
      <div className="data-view-query-line data-view-order-line">
        <ol className="data-view-order">
          <span className="codicon codicon-list-ordered data-view-clause-mark" aria-hidden="true" />
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
                  key={`${item.text}:${item.direction}:${item.nulls ?? ""}`}
                  className={`data-view-clause active${sortOrder.isTarget(sortIndex) ? " drag-over" : ""}`}
                  style={
                    table
                      ? ({ "--column-accent": tableAccent(table.accent) } as CSSProperties)
                      : undefined
                  }
                  {...sortOrder.itemProps(sortIndex, item.text)}
                >
                  <span className="data-view-order-rank">{index + 1}</span>
                  {item.column ? (
                    /*
                     * The criterion itself turns over: a reader who wants the other direction
                     * reaches for the thing they are reading, not for a second icon beside it.
                     */
                    <button
                      type="button"
                      className="data-view-clause-turn"
                      title={turningOver(item)}
                      aria-label={turningOver(item)}
                      onClick={() =>
                        applySorts(
                          columnSorts.map((sort) =>
                            sort.column === item.column
                              ? {
                                  ...sort,
                                  direction:
                                    sort.direction === "ascending" ? "descending" : "ascending",
                                }
                              : sort,
                          ),
                        )
                      }
                    >
                      <span
                        className={`codicon codicon-${item.direction === "ascending" ? "arrow-up" : "arrow-down"}`}
                        aria-hidden="true"
                      />
                      <span className="data-view-clause-text">{item.column}</span>
                    </button>
                  ) : (
                    <>
                      <span
                        className={`codicon codicon-${item.direction === "ascending" ? "arrow-up" : "arrow-down"}`}
                        aria-hidden="true"
                      />
                      <span className="data-view-clause-text" title={item.text}>
                        {item.text}
                      </span>
                    </>
                  )}
                  {item.column ? (
                    <>
                      {(() => {
                        /*
                         * Where the NULLs of this column go. It always says where they are, the
                         * one PostgreSQL would choose included — a reader should not have to know
                         * that ascending puts them last to know where they are.
                         */
                        const asWritten = item.nulls ?? defaultNullsOrder(item.direction);
                        const isDefault = asWritten === defaultNullsOrder(item.direction);
                        return (
                          <button
                            type="button"
                            className={`data-view-clause-nulls${isDefault ? "" : " overridden"}`}
                            title={whereNullsGo(asWritten, isDefault, item.direction)}
                            aria-label={whereNullsGo(asWritten, isDefault, item.direction)}
                            onClick={() =>
                              applySorts(
                                columnSorts.map((sort) =>
                                  sort.column === item.column
                                    ? {
                                        column: sort.column,
                                        direction: sort.direction,
                                        ...(isDefault
                                          ? {
                                              nulls: (asWritten === "last" ? "first" : "last") as
                                                | "first"
                                                | "last",
                                            }
                                          : {}),
                                      }
                                    : sort,
                                ),
                              )
                            }
                          >
                            <span className="data-view-clause-nulls-label">NULL</span>
                            <span
                              className={`codicon codicon-fold-${asWritten === "first" ? "up" : "down"}`}
                              aria-hidden="true"
                            />
                          </button>
                        );
                      })()}
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
      {/*
        The rows: how many there are, how to walk them, and whether they may be written. Every one
        of these acts on what is under it, so it sits between the query that chose the rows and the
        rows themselves — a control put beside the connection would say it acted on the connection.
      */}
      <div className="data-view-rows-line">
        <ResultNavigation
          state={navigationState}
          onAction={(action) => post({ type: "data-view/navigate", action })}
        >
          <span
            className="result-navigation-summary"
            title={
              payload
                ? [
                    resultRowSummary(payload),
                    ...(payload.truncated ? payload.truncationReasons : []),
                  ].join(" · ")
                : undefined
            }
          >
            {payload ? resultRowRange(payload) : ""}
          </span>
        </ResultNavigation>
        {/*
          What stands outside the count, so that nothing beside the arrows changes width as a
          reader pages: a mark for a result cut short, and one for a cursor that has closed.
        */}
        {payload?.truncated ? (
          <span
            className="codicon codicon-warning data-view-rows-mark"
            title={`Cut short: ${payload.truncationReasons.join(", ")}`}
          />
        ) : null}
        {navigationState.closed ? (
          <span
            className="codicon codicon-debug-disconnect data-view-rows-mark"
            title="Cursor closed; refresh to load again"
          />
        ) : null}
        <span className="data-view-rows-spacer" />
        {/*
          The value panel shows what a cell holds, so it belongs with the rows and not with the
          view — beside the control that decides whether those rows may be written.
        */}
        <IconButton
          icon="inspect"
          label={
            inspecting
              ? "Stop showing the value under the cursor"
              : "Show the value under the cursor, whole"
          }
          primary={inspecting}
          onClick={() => setInspecting((on) => !on)}
        />
        {editable ? (
          <IconButton
            icon="edit"
            label={editMode ? "Leave edit mode" : "Edit mode"}
            text="Edit"
            primary={editMode}
            onClick={() => {
              setEditMode((on) => !on);
              setSelection(undefined);
            }}
          />
        ) : null}
      </div>
      {/*
        The edit bar: what a reader has selected, what they can do to it, and what is waiting to be
        written. It shows only in edit mode, immediately above the rows it acts on.
      */}
      {editMode && editable ? (
        <div
          className="data-view-edit-bar"
          role="toolbar"
          aria-label="Row editing"
          /*
           * This bar acts on the grid, so it must not take the keystrokes from it. A reader who
           * copies a row, presses the button that makes an empty one and pastes has never left the
           * grid — and would find the paste going to a button if the press moved the focus. The
           * press is refused, not the focus moved: Tab still reaches every control here.
           */
          onMouseDown={(event) => event.preventDefault()}
        >
          <span className="edit-bar-selection" aria-live="polite">
            {selectionSummary}
          </span>
          <span className="edit-bar-divider" aria-hidden="true" />
          <button
            type="button"
            className="edit-bar-button add"
            title={addable ?? "Add an empty row to fill in"}
            disabled={addable !== undefined}
            onClick={() => post({ type: "data-view/add-row", above: addAbove })}
          >
            ✚ Add row
          </button>
          <button
            type="button"
            className="edit-bar-button remove"
            title={
              selectedCount > 0
                ? `Delete ${countLabel(selectedCount, "row")}`
                : "Select rows in the gutter to delete them"
            }
            disabled={selectedCount === 0}
            onClick={() => {
              // A row that was only ever local is taken back; one that exists is provisioned away.
              for (const localId of selected.added) post({ type: "data-view/drop-row", localId });
              // The selection stays: the rows are still on screen, struck through, and pressing
              // this again is how a reader puts them back.
              if (selected.rows.length > 0)
                post({ type: "data-view/remove-rows", rows: selected.rows });
            }}
          >
            ✕ Delete
          </button>
          <span className="edit-bar-divider" aria-hidden="true" />
          <div className="edit-bar-changes">
            <button
              type="button"
              className={`edit-bar-button count${editCount > 0 ? " pending" : ""}`}
              aria-live="polite"
              aria-haspopup="menu"
              aria-expanded={toolbar?.which === "changes"}
              title={`${countLabel(editCount, "change")} — click to read them`}
              disabled={editCount === 0}
              onClick={(event) => openToolbarMenu(event, "changes")}
            >
              <span className="codicon codicon-edit" aria-hidden="true" /> {editCount}
            </button>
          </div>
          <button
            type="button"
            className="edit-bar-button"
            title="Discard every change"
            disabled={editCount === 0 || state.applying}
            onClick={() => post({ type: "data-view/discard" })}
          >
            ↩ Discard
          </button>
          <button
            type="button"
            className={`edit-bar-button apply${editCount > 0 ? " ready" : ""}`}
            title="Apply in one transaction (Ctrl/Cmd+S)"
            disabled={editCount === 0 || state.applying}
            onClick={() => post({ type: "data-view/apply" })}
          >
            <span
              className={`codicon codicon-${state.applying ? "sync~spin" : "save"}`}
              aria-hidden="true"
            />{" "}
            Apply
          </button>
        </div>
      ) : null}

      <section className="data-view-grid" aria-label="Rows">
        {payload && payload.columns.length > 0 ? (
          <ResultGrid
            onFollowLink={(href) => post(followLinkRequest(href))}
            payload={payload}
            selection={selection}
            onSelect={setSelection}
            inspecting={inspecting}
            onInspecting={setInspecting}
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
