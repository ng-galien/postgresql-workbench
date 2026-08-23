/**
 * What to show a reader when something threw. Said once, because four modules of this extension
 * each had their own copy of the same line and a fifth exported it from a Data View module that
 * has nothing to do with the rest of them.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
