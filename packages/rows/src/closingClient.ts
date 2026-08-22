import type { Client } from "pg";

/**
 * Ending a PostgreSQL client that may not answer.
 *
 * A client whose server has gone, or which is waiting on a statement nobody will cancel, never
 * settles its own `end()`. Every surface that opens one for a single piece of work has to be able
 * to put it down anyway, so the two ways of doing that are here rather than beside each caller.
 */

/** Cuts the socket from under a client that will not close on its own. */
export function destroyClientSocket(client: Client): void {
  const internal = client as Client & {
    connection?: { stream?: { destroy: () => void } };
  };
  internal.connection?.stream?.destroy();
}

/** The operation, or the message as an error when it has taken too long. */
export async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
