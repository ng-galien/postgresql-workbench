import type { Client } from "pg";
import { destroyClientSocket, withTimeout } from "./closingClient.js";

const NOTEBOOK_CANCELLATION_TIMEOUT_MS = 2_000;

export interface DedicatedNotebookClientProvider {
  createDedicatedClient(serverId: string): Promise<Client>;
}

export class DedicatedNotebookConnectionError extends Error {
  constructor(message: string, options: { cause: unknown }) {
    super(message, options);
    this.name = "DedicatedNotebookConnectionError";
  }
}

export class NotebookExecutionCancelledError extends Error {
  constructor() {
    super("The SQL execution was cancelled by the user.");
    this.name = "NotebookExecutionCancelledError";
  }
}

interface NotebookCancellationBinding {
  readonly provider: DedicatedNotebookClientProvider;
  readonly serverId: string;
  readonly client: Client;
}

/** Bridges a VS Code cell cancellation token to the PostgreSQL backend running that cell. */
export class NotebookClientCancellation {
  private requested = false;
  private binding?: NotebookCancellationBinding;
  private cancellation?: Promise<void>;
  private readonly handlers: Array<() => void> = [];

  get isCancellationRequested(): boolean {
    return this.requested;
  }

  request(): void {
    if (this.requested) return;
    this.requested = true;
    for (const handler of this.handlers.splice(0)) handler();
    this.startCancellation();
  }

  /** Runs `handler` once when cancellation is requested (immediately if already requested). */
  onCancel(handler: () => void): void {
    if (this.requested) handler();
    else this.handlers.push(handler);
  }

  bind(provider: DedicatedNotebookClientProvider, serverId: string, client: Client): void {
    this.binding = { provider, serverId, client };
    this.startCancellation();
  }

  throwIfCancellationRequested(): void {
    if (this.requested) throw new NotebookExecutionCancelledError();
  }

  async settle(): Promise<void> {
    await this.cancellation;
  }

  private startCancellation(): void {
    if (!this.requested || !this.binding || this.cancellation) return;
    const { provider, serverId, client } = this.binding;
    this.cancellation = cancelNotebookClient(provider, serverId, client);
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
      `The Scratchpad could not open its Connexion: ${detail}`,
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

export async function configureNotebookStatementTimeout(
  client: Pick<Client, "query">,
  timeoutMs: number,
): Promise<void> {
  await client.query("SELECT set_config('statement_timeout', $1, false)", [`${timeoutMs}ms`]);
}

export async function cancelNotebookClient(
  provider: DedicatedNotebookClientProvider,
  serverId: string,
  target: Client,
): Promise<void> {
  const pid = notebookClientProcessId(target);
  if (pid === undefined) {
    destroyClientSocket(target);
    return;
  }

  const pendingControl = createDedicatedNotebookClient(provider, serverId);
  let control: Client | undefined;
  try {
    control = await withTimeout(
      pendingControl,
      NOTEBOOK_CANCELLATION_TIMEOUT_MS,
      "The PostgreSQL cancellation Connexion timed out.",
    );
    const result = await withTimeout(
      control.query<{ cancelled: boolean }>("SELECT pg_cancel_backend($1) AS cancelled", [pid]),
      NOTEBOOK_CANCELLATION_TIMEOUT_MS,
      "The PostgreSQL cancellation request timed out.",
    );
    if (!result.rows[0]?.cancelled) destroyClientSocket(target);
  } catch {
    if (!control) closeLateClient(pendingControl);
    destroyClientSocket(target);
  } finally {
    if (control) {
      await withTimeout(
        control.end(),
        NOTEBOOK_CANCELLATION_TIMEOUT_MS,
        "The PostgreSQL cancellation Connexion did not close.",
      ).catch(() => destroyClientSocket(control as Client));
    }
  }
}

function notebookClientProcessId(client: Client): number | undefined {
  const processId = (client as Client & { processID?: unknown }).processID;
  return typeof processId === "number" && Number.isInteger(processId) && processId > 0
    ? processId
    : undefined;
}

function closeLateClient(pending: Promise<Client>): void {
  void pending
    .then((client) => client.end().catch(() => destroyClientSocket(client)))
    .catch(() => {});
}
