import type { WorkbenchGraphRenderEvidence } from "../../protocol.js";

export function readCockpitEvidence(viewport?: {
  x: number;
  y: number;
  zoom: number;
}): WorkbenchGraphRenderEvidence {
  const cards = [...document.querySelectorAll<HTMLElement>("[data-graph-card]")].map((element) => ({
    identity: element.dataset.graphCard ?? "",
    label: element.dataset.graphLabel ?? "",
    kind: element.dataset.graphKind ?? "",
    role: normalizeRole(element.dataset.graphRole),
  }));
  const edges = [...document.querySelectorAll<SVGPathElement>("[data-graph-edge]")].map(
    (element) => ({
      identity: element.dataset.graphEdge ?? "",
      sourceIdentity: element.dataset.sourceIdentity ?? "",
      targetIdentity: element.dataset.targetIdentity ?? "",
      sourceLabel: element.dataset.sourceLabel ?? "",
      targetLabel: element.dataset.targetLabel ?? "",
      kinds: parseKinds(element.dataset.kinds),
    }),
  );
  const input = document.querySelector<HTMLInputElement>(".cockpit-search input");
  const previewElement = document.querySelector<HTMLElement>("[data-graph-preview]");
  const sourceLines = previewElement
    ? [...previewElement.querySelectorAll<HTMLElement>(".postgres-source-line")]
    : [];
  const sourceLineRects = sourceLines.map((line) => line.getBoundingClientRect());
  const sourceCode = previewElement?.querySelector<HTMLElement>(".postgres-source-line-code");
  return {
    cards,
    edges,
    search: input ? { placeholder: input.placeholder, value: input.value } : undefined,
    preview: previewElement
      ? {
          symbolUri: previewElement.dataset.graphPreview ?? "",
          title: previewElement.dataset.graphPreviewTitle ?? "",
          lines: Number(previewElement.dataset.graphPreviewLines ?? 0),
          text: sourceLines
            .map((line) => line.querySelector(".postgres-source-line-code")?.textContent ?? "")
            .join("\n"),
          highlightedTokens: previewElement.querySelectorAll(".postgres-source-token").length,
          renderedLines: sourceLines.length,
          maxVerticalGap: maximumVerticalGap(sourceLineRects),
          backgroundMatchesEditor:
            sourceCode !== null &&
            sourceCode !== undefined &&
            getComputedStyle(sourceCode).backgroundColor ===
              getComputedStyle(document.body).backgroundColor,
        }
      : undefined,
    viewport,
  };
}

function maximumVerticalGap(rects: DOMRect[]): number {
  let maximum = 0;
  for (let index = 1; index < rects.length; index += 1) {
    maximum = Math.max(maximum, rects[index].top - rects[index - 1].bottom);
  }
  return maximum;
}

function normalizeRole(value: string | undefined): "focus" | "neighbor" | "pinned" {
  return value === "focus" || value === "pinned" ? value : "neighbor";
}

function parseKinds(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}
