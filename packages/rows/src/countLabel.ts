/** How a count reads next to its noun: `1 row`, `3 rows`, `0 symbols`. */
export function countLabel(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}
