import type { PgTapSourceRoutine } from "../../../packages/coverage/src/index.js";

export function coverageRoutineName(routine: PgTapSourceRoutine): string {
  return `${routine.schema}.${routine.name}(${routine.identityArguments})`;
}

export function matchesCoveragePatterns(
  routine: PgTapSourceRoutine,
  include: readonly string[],
  exclude: readonly string[],
): boolean {
  const name = coverageRoutineName(routine);
  const included = include.length === 0 || include.some((pattern) => globMatches(name, pattern));
  return included && !exclude.some((pattern) => globMatches(name, pattern));
}

function globMatches(value: string, pattern: string): boolean {
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\0")
    .replace(/\*/g, ".*")
    .replace(/\0/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${source}$`, "i").test(value);
}
