import type { Client } from "pg";

export interface DedicatedNotebookClientProvider {
  createDedicatedClient(serverId: string): Promise<Client>;
}

export class DedicatedNotebookConnectionError extends Error {
  constructor(message: string, options: { cause: unknown }) {
    super(message, options);
    this.name = "DedicatedNotebookConnectionError";
  }
}

export async function createDedicatedNotebookClient(
  provider: DedicatedNotebookClientProvider,
  serverId: string,
): Promise<Client> {
  try {
    return await provider.createDedicatedClient(serverId);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new DedicatedNotebookConnectionError(
      `The scratchpad could not connect to its PostgreSQL binding: ${detail}`,
      { cause },
    );
  }
}

export async function withDedicatedNotebookClient<T>(
  provider: DedicatedNotebookClientProvider,
  serverId: string,
  action: (client: Client) => Promise<T>,
): Promise<T> {
  const client = await createDedicatedNotebookClient(provider, serverId);
  try {
    return await action(client);
  } finally {
    await client.end().catch(() => {});
  }
}
