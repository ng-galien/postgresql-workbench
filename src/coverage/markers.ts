const MARKER_NAMESPACE = "postgresql-workbench-cov";
const SAFE_TOKEN = /^[a-zA-Z0-9_-]+$/;

export function coverageMarkerPrefix(runId: string): string {
  assertSafeToken(runId, "run ID");
  return `${MARKER_NAMESPACE}:${runId}:`;
}

export function formatCoverageMarker(runId: string, pointId: string): string {
  assertSafeToken(pointId, "point ID");
  return `${coverageMarkerPrefix(runId)}${pointId}`;
}

export function parseCoverageMarker(
  message: string,
  runId: string,
): { pointId: string } | undefined {
  const prefix = coverageMarkerPrefix(runId);
  if (!message.startsWith(prefix)) return undefined;
  const pointId = message.slice(prefix.length);
  if (!SAFE_TOKEN.test(pointId)) return undefined;
  return { pointId };
}

function assertSafeToken(value: string, label: string): void {
  if (!SAFE_TOKEN.test(value)) {
    throw new Error(`Invalid coverage ${label}: ${value}`);
  }
}
