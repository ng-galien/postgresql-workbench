export const DEBUG_ACTION_INTERVAL_MS = 500;
export const DEBUG_DAP_EVENT_TIMEOUT_MS = 30_000;
export const DEBUG_INTEGRATION_TEST_TIMEOUT_MS = 60_000;
export const DEBUG_PLAYWRIGHT_TEST_TIMEOUT_MS = 150_000;

type DebugTestWait = (milliseconds: number) => Promise<unknown>;

const lastActionStartedAt = new WeakMap<object, Promise<number | undefined>>();

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Keep pldebugger test commands far enough apart for the listener/target
 * exchange to settle. The cadence is scoped to one debugger session so
 * independent tests never delay each other.
 */
export async function runPacedDebugAction<T>(
  debuggerSession: object,
  action: () => Promise<T>,
  wait: DebugTestWait = delay,
): Promise<T> {
  const previous = lastActionStartedAt.get(debuggerSession) ?? Promise.resolve(undefined);
  const scheduledStart = previous.then(async (previousStartedAt) => {
    if (previousStartedAt !== undefined) {
      const remaining = DEBUG_ACTION_INTERVAL_MS - (Date.now() - previousStartedAt);
      if (remaining > 0) await wait(remaining);
    }
    return Date.now();
  });
  lastActionStartedAt.set(debuggerSession, scheduledStart);
  await scheduledStart;
  return action();
}
