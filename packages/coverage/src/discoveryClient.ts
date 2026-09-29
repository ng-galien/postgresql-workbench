import type { Client } from "pg";
import type { CoverageClientFactory } from "./runner.js";

/** A caller's connecting promise cannot be cancelled; close any client it delivers late. */
export function openDiscoveryClient(
  factory: CoverageClientFactory,
  signal: AbortSignal,
): Promise<Client> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve()
      .then(factory)
      .then(async (client) => {
        if (signal.aborted) await client.end();
        else resolve(client);
      })
      .catch(reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Discovery has no transaction to preserve: disconnecting aborts a blocked catalog query. */
export async function withDiscoveryClient<T>(
  factory: CoverageClientFactory,
  signal: AbortSignal,
  action: (client: Client) => Promise<T>,
): Promise<T> {
  const client = await openDiscoveryClient(factory, signal);
  let closing: Promise<void> | undefined;
  const close = () => {
    closing ??= client.end();
    return closing;
  };
  let abort!: () => void;
  const interrupted = new Promise<never>((_resolve, reject) => {
    abort = () => {
      void close().then(() => reject(signal.reason), reject);
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        signal.throwIfAborted();
        return action(client);
      }),
      interrupted,
    ]);
  } finally {
    signal.removeEventListener("abort", abort);
    await close();
  }
}
