export interface SearchFacetSuggestion {
  kind: "schema" | "type";
  label: string;
  token: string;
}

export function searchFacetSuggestions(
  query: string,
  facets: { schemas: readonly string[]; kinds: readonly string[] },
): SearchFacetSuggestion[] {
  const token = query.match(/(?:^|\s)([#@])([^\s]*)$/);
  if (!token) return [];
  const prefix = token[1];
  const value = token[2].toLocaleLowerCase();
  const candidates = prefix === "#" ? facets.schemas : facets.kinds;
  return candidates
    .filter((candidate) => candidate.toLocaleLowerCase().includes(value))
    .slice(0, 12)
    .map((candidate) => ({
      kind: prefix === "#" ? "schema" : "type",
      label: candidate,
      token: `${prefix}${candidate}`,
    }));
}

export function applySearchFacet(query: string, token: string): string {
  const current = query.match(/(?:^|\s)[^\s]*$/);
  const prefix = current ? query.slice(0, current.index ?? 0).trimEnd() : query.trimEnd();
  return `${prefix ? `${prefix} ` : ""}${token} `;
}
