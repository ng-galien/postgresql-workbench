/** Matches a name literally inside a pattern, so a dot or a parenthesis in it is not a wildcard. */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
