import * as crypto from "node:crypto";
import * as vscode from "vscode";
import type { DebugResultStore } from "./debugResultStore.js";

export const DEBUG_RESULTS_VIEW_ID = "postgresql-workbench-results";
const DEBUG_RESULTS_CONTAINER_COMMAND =
  "workbench.view.extension.postgresql-workbench-results-container";

interface ResultsWebviewMessage {
  type?: string;
  id?: string;
  text?: string;
}

export class DebugResultsViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private readonly storeSubscription: { dispose(): void };

  constructor(private readonly store: DebugResultStore) {
    this.storeSubscription = store.onDidChange(() => this.update());
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = createDebugResultsHtml(crypto.randomBytes(16).toString("base64"));
    view.webview.onDidReceiveMessage(async (message: ResultsWebviewMessage) => {
      if (message.type === "ready") {
        this.update();
      } else if (message.type === "select" && message.id) {
        this.store.select(message.id);
      } else if (message.type === "copy" && typeof message.text === "string") {
        await vscode.env.clipboard.writeText(message.text);
        await view.webview.postMessage({ type: "copyResult", ok: true });
      } else if (message.type === "openSource") {
        await this.openSelectedSource();
      }
    });
    this.update();
  }

  reveal(preserveFocus = true): void {
    if (this.view) {
      this.view.show(preserveFocus);
      return;
    }
    void vscode.commands.executeCommand(DEBUG_RESULTS_CONTAINER_COMMAND).then(
      () => this.view?.show(preserveFocus),
      () => vscode.commands.executeCommand(`${DEBUG_RESULTS_VIEW_ID}.focus`),
    );
  }

  get visible(): boolean {
    return this.view?.visible ?? false;
  }

  dispose(): void {
    this.storeSubscription.dispose();
  }

  private update(): void {
    void this.view?.webview.postMessage({
      type: "state",
      state: this.store.viewState(),
    });
  }

  private async openSelectedSource(): Promise<void> {
    const source = this.store.selectedEntry?.source;
    if (!source?.uri) return;
    const uri = vscode.Uri.parse(source.uri);
    const line = Math.max(0, (source.line ?? 1) - 1);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, {
      preview: false,
      selection: new vscode.Range(line, 0, line, 0),
    });
  }
}

const DEBUG_RESULTS_NONCE = "__PLPGSQL_RESULTS_NONCE__";
const DEBUG_RESULTS_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-__PLPGSQL_RESULTS_NONCE__'; script-src 'nonce-__PLPGSQL_RESULTS_NONCE__';">
  <style nonce="__PLPGSQL_RESULTS_NONCE__">
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body {
      padding: 0;
      margin: 0;
      color: var(--vscode-foreground);
      background: var(--vscode-panel-background);
      font-family: var(--vscode-font-family);
    }
    button, select { font: inherit; }
    button {
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
      border: 1px solid transparent;
      padding: 3px 8px;
      cursor: pointer;
    }
    button:hover { background: var(--vscode-button-secondaryHoverBackground); }
    button:focus-visible, select:focus-visible, td:focus-visible, pre:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }
    .shell {
      display: grid;
      grid-template-rows: auto auto auto minmax(0, 1fr) auto;
      height: 100vh;
      min-width: 0;
    }
    .top {
      display: flex;
      gap: 8px;
      align-items: center;
      padding: 7px 10px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .top label { flex: 0 0 auto; }
    select {
      flex: 1 1 280px;
      min-width: 0;
      max-width: 720px;
      color: var(--vscode-dropdown-foreground);
      background: var(--vscode-dropdown-background);
      border: 1px solid var(--vscode-dropdown-border);
      padding: 3px 6px;
    }
    .context {
      display: flex;
      min-width: 0;
      gap: 8px;
      align-items: center;
      padding: 6px 10px 0;
    }
    .identity { min-width: 0; flex: 1 1 auto; }
    .identity strong, .identity code {
      display: block;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .identity code {
      margin-top: 2px;
      color: var(--vscode-descriptionForeground);
      font-family: var(--vscode-editor-font-family);
      font-size: 0.92em;
    }
    .meta {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
      min-height: 31px;
      padding: 5px 10px 7px;
      color: var(--vscode-descriptionForeground);
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .badge {
      padding: 2px 6px;
      border-radius: 8px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }
    .status-pending { color: var(--vscode-charts-blue); }
    .status-error { color: var(--vscode-errorForeground); }
    .warning {
      width: 100%;
      color: var(--vscode-editorWarning-foreground);
      line-height: 1.35;
    }
    .grid { overflow: auto; min-height: 0; }
    table {
      border-collapse: separate;
      border-spacing: 0;
      width: max-content;
      min-width: 100%;
      font-family: var(--vscode-editor-font-family);
      font-size: var(--vscode-editor-font-size);
    }
    th, td {
      padding: 5px 8px;
      border-right: 1px solid var(--vscode-panel-border);
      border-bottom: 1px solid var(--vscode-panel-border);
      text-align: left;
      white-space: pre;
      max-width: 520px;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    th {
      position: sticky;
      top: 0;
      z-index: 2;
      background: var(--vscode-editorGroupHeader-tabsBackground);
      font-family: var(--vscode-font-family);
    }
    .column-name, .column-type { display: block; }
    .column-type {
      margin-top: 1px;
      color: var(--vscode-descriptionForeground);
      font-size: 0.85em;
      font-weight: normal;
    }
    tbody tr:hover { background: var(--vscode-list-hoverBackground); }
    td { cursor: default; }
    td.null { color: var(--vscode-descriptionForeground); font-style: italic; }
    td.number { text-align: right; }
    td.json, td.binary { color: var(--vscode-textLink-foreground); }
    td.truncated { box-shadow: inset -3px 0 var(--vscode-editorWarning-foreground); }
    td[tabindex="0"] { position: relative; }
    td[tabindex="0"]::after {
      content: "";
      position: absolute;
      inset: 1px;
      border: 1px solid transparent;
      pointer-events: none;
    }
    td[tabindex="0"]:focus::after { border-color: var(--vscode-focusBorder); }
    .empty, .state {
      display: grid;
      place-items: center;
      align-content: center;
      gap: 6px;
      min-height: 140px;
      padding: 20px;
      color: var(--vscode-descriptionForeground);
      text-align: center;
    }
    .state strong { color: var(--vscode-foreground); }
    .state.error strong { color: var(--vscode-errorForeground); }
    .zero-row {
      height: 80px;
      color: var(--vscode-descriptionForeground);
      text-align: center;
      font-family: var(--vscode-font-family);
    }
    .detail-panel {
      max-height: 38vh;
      min-height: 0;
      border-top: 1px solid var(--vscode-panel-border);
      background: var(--vscode-textCodeBlock-background);
    }
    .detail-panel[hidden] { display: none; }
    .detail-head {
      display: flex;
      gap: 6px;
      align-items: center;
      padding: 6px 10px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .detail-title {
      flex: 1 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .detail {
      max-height: calc(38vh - 35px);
      overflow: auto;
      margin: 0;
      padding: 9px 10px;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font-family: var(--vscode-editor-font-family);
    }
    .sr-status {
      position: fixed;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
    }
    @media (max-width: 460px) {
      .top, .context { flex-wrap: wrap; }
      .context button { width: 100%; }
      th, td { max-width: 300px; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <div class="top"><label for="history">Result</label><select id="history" aria-label="Result history"></select></div>
    <div id="context" class="context" hidden>
      <div class="identity"><strong id="identity"></strong><code id="query"></code></div>
      <button id="open-source" type="button" hidden>Open callsite</button>
    </div>
    <div id="meta" class="meta"></div>
    <div id="content" class="grid"><div class="empty">Run a PL/pgSQL debug call to see its result.</div></div>
    <section id="detail-panel" class="detail-panel" aria-label="Cell inspector" hidden>
      <div class="detail-head">
        <strong id="detail-title" class="detail-title">Cell value</strong>
        <button id="detail-format" type="button" hidden>Raw</button>
        <button id="detail-copy" type="button">Copy</button>
        <button id="detail-close" type="button" aria-label="Close cell inspector">Close</button>
      </div>
      <pre id="detail" class="detail" tabindex="0"></pre>
    </section>
  </div>
  <div id="status" class="sr-status" role="status" aria-live="polite"></div>
  <script nonce="__PLPGSQL_RESULTS_NONCE__">
    const vscode = acquireVsCodeApi();
    const NULL_EXPORT = '\\\\N';
    const history = document.getElementById('history');
    const context = document.getElementById('context');
    const identity = document.getElementById('identity');
    const query = document.getElementById('query');
    const openSource = document.getElementById('open-source');
    const meta = document.getElementById('meta');
    const content = document.getElementById('content');
    const detailPanel = document.getElementById('detail-panel');
    const detailTitle = document.getElementById('detail-title');
    const detail = document.getElementById('detail');
    const detailFormat = document.getElementById('detail-format');
    const detailCopy = document.getElementById('detail-copy');
    const detailClose = document.getElementById('detail-close');
    const status = document.getElementById('status');
    let currentResult;
    let detailRaw = '';
    let detailPretty = '';
    let detailCopyValue = '';
    let showingPretty = false;
    let lastInspectedCell;

    history.addEventListener('change', () => vscode.postMessage({ type: 'select', id: history.value }));
    openSource.addEventListener('click', () => vscode.postMessage({ type: 'openSource' }));
    detailCopy.addEventListener('click', copyDetail);
    detailClose.addEventListener('click', () => closeDetail(true));
    detailFormat.addEventListener('click', toggleDetailFormat);
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !detailPanel.hidden) closeDetail(true);
    });
    window.addEventListener('message', ({ data }) => {
      if (data.type === 'state') render(data.state);
      if (data.type === 'copyResult' && data.ok) announce('Copied to clipboard');
    });
    vscode.postMessage({ type: 'ready' });

    function render(state) {
      currentResult = state.selected;
      history.replaceChildren();
      for (const item of state.results) {
        const option = document.createElement('option');
        option.value = item.id;
        option.textContent = historyLabel(item);
        option.title = item.query || item.label;
        option.selected = state.selected && state.selected.id === item.id;
        history.append(option);
      }
      history.disabled = state.results.length === 0;
      resetChrome();
      if (!currentResult) {
        content.replaceChildren(empty('Run a PL/pgSQL debug call to see its result.'));
        return;
      }

      const resultStatus = currentResult.status || 'success';
      context.hidden = false;
      identity.textContent = currentResult.label || currentResult.command || 'SQL result';
      query.textContent = currentResult.query || '';
      query.title = currentResult.query || '';
      openSource.hidden = !currentResult.source || !currentResult.source.uri;
      addBadge(statusLabel(resultStatus), 'status-' + resultStatus);

      if (resultStatus === 'pending') {
        content.replaceChildren(stateMessage('Running query', 'The result will appear when the debugged call completes.'));
        return;
      }
      if (resultStatus === 'error') {
        addBadge(currentResult.durationMs + ' ms');
        content.replaceChildren(stateMessage('Query failed', currentResult.message, true));
        return;
      }

      addBadge(currentResult.command);
      addBadge(currentResult.rowCount + ' row' + (currentResult.rowCount === 1 ? '' : 's'));
      addBadge(currentResult.columns.length + ' column' + (currentResult.columns.length === 1 ? '' : 's'));
      addBadge(currentResult.durationMs + ' ms');
      addTruncationWarnings(currentResult);
      renderResultTable(currentResult);
    }

    function resetChrome() {
      meta.replaceChildren();
      context.hidden = true;
      identity.textContent = '';
      query.textContent = '';
      openSource.hidden = true;
      closeDetail();
    }

    function renderResultTable(result) {
      if (result.columns.length === 0) {
        content.replaceChildren(empty(result.command + ' completed with no result columns.'));
        return;
      }

      const table = document.createElement('table');
      table.setAttribute('role', 'grid');
      table.setAttribute('aria-label', (result.label || result.command) + ' result grid');
      const head = document.createElement('thead');
      const headRow = document.createElement('tr');
      result.columns.forEach((column, index) => {
        const th = document.createElement('th');
        th.scope = 'col';
        const name = document.createElement('span');
        name.className = 'column-name';
        name.textContent = column.name || 'column ' + (index + 1);
        const type = document.createElement('span');
        type.className = 'column-type';
        type.textContent = column.typeName || 'oid ' + column.dataTypeId;
        th.append(name, type);
        headRow.append(th);
      });
      head.append(headRow);
      table.append(head);

      const body = document.createElement('tbody');
      if (result.rows.length === 0) {
        const row = document.createElement('tr');
        const cell = document.createElement('td');
        cell.className = 'zero-row';
        cell.colSpan = result.columns.length;
        cell.textContent = 'Query completed — 0 rows.';
        row.append(cell);
        body.append(row);
      } else {
        result.rows.forEach((row, rowIndex) => {
          const tr = document.createElement('tr');
          row.forEach((cell, columnIndex) => {
            const td = document.createElement('td');
            td.className = cell.kind + (cell.truncated ? ' truncated' : '');
            td.textContent = cell.value === null ? 'NULL' : cell.value;
            td.dataset.row = String(rowIndex);
            td.dataset.column = String(columnIndex);
            td.tabIndex = rowIndex === 0 && columnIndex === 0 ? 0 : -1;
            td.setAttribute('role', 'gridcell');
            td.setAttribute('aria-label', cellAriaLabel(cell, result.columns[columnIndex], rowIndex));
            td.title = cell.truncated
              ? 'Captured preview is truncated. Click or press Enter to inspect; Ctrl/Cmd+C copies the preview.'
              : 'Click or press Enter to inspect; Ctrl/Cmd+C copies this value.';
            tr.append(td);
          });
          body.append(tr);
        });
      }
      table.append(body);
      table.addEventListener('click', handleGridClick);
      table.addEventListener('keydown', handleGridKeydown);
      table.addEventListener('focusin', handleGridFocus);
      content.replaceChildren(table);
    }

    function handleGridClick(event) {
      const cell = event.target.closest('td[data-row]');
      if (!cell) return;
      activateCell(cell);
      showCellDetail(cell);
    }

    function handleGridFocus(event) {
      const cell = event.target.closest('td[data-row]');
      if (cell) activateCell(cell);
    }

    function handleGridKeydown(event) {
      const cell = event.target.closest('td[data-row]');
      if (!cell) return;
      const row = Number(cell.dataset.row);
      const column = Number(cell.dataset.column);
      let targetRow = row;
      let targetColumn = column;
      if (event.key === 'ArrowLeft') targetColumn -= 1;
      else if (event.key === 'ArrowRight') targetColumn += 1;
      else if (event.key === 'ArrowUp') targetRow -= 1;
      else if (event.key === 'ArrowDown') targetRow += 1;
      else if (event.key === 'Home') targetColumn = 0;
      else if (event.key === 'End') targetColumn = currentResult.columns.length - 1;
      else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        showCellDetail(cell);
        return;
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') {
        event.preventDefault();
        copyCell(cell);
        return;
      } else {
        return;
      }
      event.preventDefault();
      focusCell(targetRow, targetColumn);
    }

    function focusCell(row, column) {
      const boundedRow = Math.max(0, Math.min(currentResult.rows.length - 1, row));
      const boundedColumn = Math.max(0, Math.min(currentResult.columns.length - 1, column));
      const target = content.querySelector(
        'td[data-row="' + boundedRow + '"][data-column="' + boundedColumn + '"]'
      );
      if (!target) return;
      activateCell(target);
      target.focus();
    }

    function activateCell(cell) {
      const active = content.querySelector('td[tabindex="0"]');
      if (active && active !== cell) active.tabIndex = -1;
      cell.tabIndex = 0;
    }

    function showCellDetail(cell) {
      const row = Number(cell.dataset.row);
      const column = Number(cell.dataset.column);
      const value = currentResult.rows[row][column];
      const columnInfo = currentResult.columns[column];
      detailRaw = value.value === null ? 'NULL' : value.value;
      detailCopyValue = value.value === null ? NULL_EXPORT : value.value;
      detailPretty = prettyValue(value);
      showingPretty = detailPretty !== detailRaw;
      lastInspectedCell = cell;
      detailTitle.textContent =
        (columnInfo.name || 'column ' + (column + 1)) +
        ' · row ' + (row + 1) +
        ' · ' + (columnInfo.typeName || 'oid ' + columnInfo.dataTypeId) +
        (value.truncated ? ' · captured preview' : '');
      detailFormat.hidden = detailPretty === detailRaw;
      detailFormat.textContent = showingPretty ? 'Raw' : 'Formatted';
      detail.textContent = showingPretty ? detailPretty : detailRaw;
      detailPanel.hidden = false;
      announce('Cell inspector opened');
    }

    function prettyValue(cell) {
      if (cell.kind !== 'json' || cell.value === null) return cell.value === null ? 'NULL' : cell.value;
      try {
        return JSON.stringify(JSON.parse(cell.value), null, 2);
      } catch {
        return cell.value;
      }
    }

    function toggleDetailFormat() {
      showingPretty = !showingPretty;
      detail.textContent = showingPretty ? detailPretty : detailRaw;
      detailFormat.textContent = showingPretty ? 'Raw' : 'Formatted';
    }

    function copyCell(cell) {
      const row = Number(cell.dataset.row);
      const column = Number(cell.dataset.column);
      const value = currentResult.rows[row][column];
      vscode.postMessage({ type: 'copy', text: value.value === null ? NULL_EXPORT : value.value });
    }

    function copyDetail() {
      vscode.postMessage({ type: 'copy', text: detailCopyValue });
    }

    function closeDetail(returnFocus) {
      detailPanel.hidden = true;
      detail.textContent = '';
      detailRaw = '';
      detailPretty = '';
      detailCopyValue = '';
      if (returnFocus && lastInspectedCell && document.contains(lastInspectedCell)) {
        lastInspectedCell.focus();
      }
      if (!returnFocus) lastInspectedCell = undefined;
    }

    function addTruncationWarnings(result) {
      for (const reason of result.truncationReasons || []) {
        if (reason === 'rows') {
          addWarning(result.capturedRowCount + ' of ' + result.rowCount + ' rows captured. Additional rows are not displayed or exported.');
        } else if (reason === 'cell') {
          addWarning('One or more cells reached the 64 KiB value limit. Truncated cells have an amber edge.');
        } else if (reason === 'payload') {
          addWarning('The 1 MiB result payload limit was reached. Only ' + result.capturedRowCount + ' rows are available.');
        }
      }
    }

    function historyLabel(item) {
      const time = new Date(item.timestamp).toLocaleTimeString();
      const state = item.status === 'pending' ? 'running' : item.status === 'error' ? 'failed' : item.rowCount + ' rows';
      const preview = item.truncated ? ' · preview' : '';
      const connection = item.connection ? ' · ' + item.connection : '';
      return time + ' · ' + item.label + ' · ' + state + preview + connection;
    }

    function statusLabel(value) {
      if (value === 'pending') return 'Running';
      if (value === 'error') return 'Failed';
      return 'Completed';
    }

    function addBadge(text, className) {
      const badge = document.createElement('span');
      badge.className = 'badge' + (className ? ' ' + className : '');
      badge.textContent = text;
      meta.append(badge);
    }

    function addWarning(text) {
      const warning = document.createElement('div');
      warning.className = 'warning';
      warning.textContent = text;
      meta.append(warning);
    }

    function empty(text) {
      const node = document.createElement('div');
      node.className = 'empty';
      node.textContent = text;
      return node;
    }

    function stateMessage(title, message, error) {
      const node = document.createElement('div');
      node.className = 'state' + (error ? ' error' : '');
      const strong = document.createElement('strong');
      strong.textContent = title;
      const description = document.createElement('span');
      description.textContent = message;
      node.append(strong, description);
      return node;
    }

    function cellAriaLabel(cell, column, row) {
      const raw = cell.value === null ? 'PostgreSQL NULL' : cell.value;
      const value = raw.length > 160 ? raw.slice(0, 160) + '…' : raw;
      return (column.name || 'column') + ', row ' + (row + 1) + ', ' + value + (cell.truncated ? ', truncated preview' : '');
    }

    function announce(message) {
      status.textContent = '';
      requestAnimationFrame(() => {
        status.textContent = message;
      });
    }
  </script>
</body>
</html>`;

export function createDebugResultsHtml(nonce: string): string {
  return DEBUG_RESULTS_HTML.replaceAll(DEBUG_RESULTS_NONCE, nonce);
}
