import { CoverageInstrumentationError } from "./errors.js";
import { coverageMarkerPrefix, formatCoverageMarker } from "./markers.js";
import type { CoverageAnalysis, CoveragePoint, InstrumentedCoverageSource } from "./model.js";

interface ByteInjection {
  offset: number;
  order: number;
  text: string;
}

export function instrumentCoverageSyntaxBody(
  source: string,
  analysis: CoverageAnalysis,
  runId: string,
): InstrumentedCoverageSource {
  const errors = analysis.diagnostics.filter(({ severity }) => severity === "error");
  if (errors.length > 0) throw new CoverageInstrumentationError(errors);

  const injections: ByteInjection[] = [];
  for (const point of analysis.points) {
    addPointInjections(source, point, runId, injections);
  }

  return {
    body: applyByteInjections(source, injections),
    markerPrefix: coverageMarkerPrefix(runId),
    pointIds: analysis.points.map(({ id }) => id),
  };
}

function addPointInjections(
  source: string,
  point: CoveragePoint,
  runId: string,
  injections: ByteInjection[],
): void {
  const placement = point.placement;
  if (placement.kind === "before") {
    const offset = requiredOffset(placement.byteOffset, point);
    injections.push(beforeInjection(source, offset, pointOrder(point), [marker(runId, point.id)]));
    return;
  }
  if (placement.kind === "inject_else") {
    const offset = requiredOffset(placement.byteOffset, point);
    const indent = indentationAt(source, offset);
    injections.push({
      offset,
      order: pointOrder(point),
      text: `ELSE\n${indent}  ${marker(runId, point.id)}\n${indent}`,
    });
    return;
  }
  if (placement.kind === "loop_enter") {
    const entryOffset = requiredOffset(placement.byteOffset, point);
    injections.push(beforeInjection(source, entryOffset, -1, [marker(runId, point.id)]));
    return;
  }
  const offset = requiredOffset(placement.byteOffset, point);
  const indent = indentationAt(source, offset);
  injections.push({
    offset,
    order: pointOrder(point),
    text: `\n${indent}${marker(runId, point.id)}`,
  });
}

function beforeInjection(
  source: string,
  offset: number,
  order: number,
  statements: readonly string[],
): ByteInjection {
  const indent = indentationAt(source, offset);
  return {
    offset,
    order,
    text: `${statements.join(`\n${indent}`)}\n${indent}`,
  };
}

function applyByteInjections(source: string, injections: readonly ByteInjection[]): string {
  const sourceBuffer = Buffer.from(source, "utf8");
  const grouped = new Map<number, ByteInjection[]>();
  for (const injection of injections) {
    if (injection.offset < 0 || injection.offset > sourceBuffer.length) {
      throw instrumentationError(
        "coverage.invalid-offset",
        `Coverage injection offset ${injection.offset} is outside the PL/pgSQL source.`,
      );
    }
    const group = grouped.get(injection.offset) ?? [];
    group.push(injection);
    grouped.set(injection.offset, group);
  }

  let result = sourceBuffer;
  for (const offset of [...grouped.keys()].sort((left, right) => right - left)) {
    const text = (grouped.get(offset) ?? [])
      .sort((left, right) => left.order - right.order)
      .map((injection) => injection.text)
      .join("");
    result = Buffer.concat([
      result.subarray(0, offset),
      Buffer.from(text, "utf8"),
      result.subarray(offset),
    ]);
  }
  return result.toString("utf8");
}

function indentationAt(source: string, offset: number): string {
  const buffer = Buffer.from(source, "utf8");
  const lineStart = buffer.lastIndexOf(10, Math.max(0, offset - 1)) + 1;
  return buffer.subarray(lineStart, offset).toString("utf8").match(/^\s*/)?.[0] ?? "";
}

function requiredOffset(offset: number | undefined, point: CoveragePoint): number {
  if (offset !== undefined) return offset;
  throw instrumentationError(
    "coverage.ast-placement-missing",
    `Coverage point ${point.id} has no AST byte placement.`,
  );
}

function marker(runId: string, pointId: string): string {
  return `RAISE WARNING '${formatCoverageMarker(runId, pointId)}';`;
}

function pointOrder(point: CoveragePoint): number {
  const value = Number(point.id.replace(/^p/, ""));
  return Number.isNaN(value) ? Number.MAX_SAFE_INTEGER : value;
}

function instrumentationError(code: string, message: string): CoverageInstrumentationError {
  return new CoverageInstrumentationError([{ severity: "error", code, message }]);
}
