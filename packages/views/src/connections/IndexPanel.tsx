import type { WorkbenchIndexSummary } from "./protocol.js";

/** Workbench-owned index state, kept visually distinct from PostgreSQL server diagnostics. */
export function IndexPanel({
  connected,
  index,
  onRefresh,
}: {
  connected: boolean;
  index: WorkbenchIndexSummary;
  onRefresh: () => void;
}) {
  const result = index.result;
  const refreshing = index.status === "indexing";
  const progress = progressLabel(index);
  return (
    <section
      aria-label="Workbench index"
      className={`connections-index connections-index-${index.status}`}
    >
      <div className="connections-index-summary">
        <span aria-hidden="true" className="connections-index-mark">
          IX
        </span>
        <div className="connections-index-title">
          <span className="connections-kicker">Workbench index</span>
          <strong>{statusHeadline(index)}</strong>
          <span>{statusDescription(index)}</span>
        </div>
        <span className={`connections-index-status connections-index-status-${index.status}`}>
          {statusLabel(index.status)}
        </span>
        <button
          disabled={!connected || refreshing}
          onClick={onRefresh}
          title={connected ? undefined : "Connect this database to build its index"}
          type="button"
        >
          {refreshing ? "Indexing…" : result ? "Refresh index" : "Build index"}
        </button>
      </div>

      {refreshing ? (
        <div className="connections-index-progress">
          <span>{progress}</span>
          {index.progress?.total ? (
            <span
              aria-label={`${index.progress.completed ?? 0} of ${index.progress.total} ${index.progress.unit ?? "items"}`}
              className="connections-index-progress-track"
              role="progressbar"
              aria-valuemax={index.progress.total}
              aria-valuemin={0}
              aria-valuenow={index.progress.completed ?? 0}
            >
              <span
                style={{
                  width: `${Math.min(100, ((index.progress.completed ?? 0) / index.progress.total) * 100)}%`,
                }}
              />
            </span>
          ) : null}
        </div>
      ) : null}

      {result ? (
        <dl className="connections-index-facts">
          <IndexFact label="Sources" value={formatCount(result.documents)} />
          <IndexFact label="Symbols" value={formatCount(result.symbols)} />
          <IndexFact label="Generation" value={result.generation?.toString() ?? "—"} />
          <IndexFact label="Indexing" value={formatDuration(result.indexingMs)} />
          <IndexFact
            label="Last change"
            value={
              index.change
                ? `${index.change.kind} · ${formatCount(index.change.sources)} sources`
                : "snapshot"
            }
          />
        </dl>
      ) : null}

      {result ? (
        <details className="connections-index-details">
          <summary>Index details</summary>
          <dl>
            <IndexFact label="Read catalog" value={formatDuration(result.introspectionMs)} />
            <IndexFact
              label="Materialize sources"
              value={formatDuration(result.materializationMs)}
            />
            <IndexFact label="Publish sources" value={formatDuration(result.publicationMs)} />
            <IndexFact label="Read symbols" value={formatDuration(result.symbolQueryMs)} />
            <IndexFact label="Query graph" value={formatDuration(result.graphQueryMs)} />
          </dl>
          <div className="connections-index-revision">
            <span>Revision</span>
            <code title={result.revision}>{result.revision}</code>
          </div>
        </details>
      ) : null}
    </section>
  );
}

function IndexFact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function statusHeadline(index: WorkbenchIndexSummary): string {
  switch (index.status) {
    case "available":
      return "Database structure is indexed";
    case "indexing":
      return index.result ? "Refreshing database structure" : "Building database structure";
    case "stale":
      return "The current snapshot is stale";
    case "cancelled":
      return "Indexing was cancelled";
    case "error":
      return "Indexing needs attention";
    case "not-indexed":
      return "No index snapshot yet";
  }
}

function statusDescription(index: WorkbenchIndexSummary): string {
  if (index.message) return index.message;
  if (index.status === "indexing") return progressLabel(index);
  if (index.result) {
    return `${formatCount(index.result.documents)} PostgreSQL sources · ${formatCount(index.result.symbols)} symbols`;
  }
  return "Build the index to power Sources, Cockpit and SQL intelligence.";
}

function statusLabel(status: WorkbenchIndexSummary["status"]): string {
  switch (status) {
    case "available":
      return "Ready";
    case "indexing":
      return "In progress";
    case "stale":
      return "Stale";
    case "cancelled":
      return "Cancelled";
    case "error":
      return "Failed";
    case "not-indexed":
      return "Not indexed";
  }
}

function progressLabel(index: WorkbenchIndexSummary): string {
  const progress = index.progress;
  if (!progress) return "Starting…";
  const count = progress.completed === undefined ? "" : ` · ${formatCount(progress.completed)}`;
  switch (progress.phase) {
    case "reading-catalog":
      return "Reading PostgreSQL catalog…";
    case "connecting-index":
      return "Connecting to the index…";
    case "publishing-sources":
      return `Publishing sources${count}…`;
    case "reading-symbols":
      return `Reading symbols${count}…`;
    case "checking-relations":
      return "Checking indexed relations…";
    case "cancelling":
      return "Cancelling…";
  }
}

function formatCount(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1) return "< 1 ms";
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  return `${(milliseconds / 1000).toFixed(milliseconds < 10_000 ? 1 : 0)} s`;
}
