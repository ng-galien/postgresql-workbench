import type { Client } from "pg";
import * as vscode from "vscode";
import { createDedicatedNotebookClient } from "../../../packages/rows/src/notebookClient.js";
import type { ResultBinding } from "../../../packages/rows/src/resultPayload.js";
import type { ConnectionManager } from "../connection/index.js";

const SHUTDOWN_DRAIN_TIMEOUT_MS = 2_000;
const SHUTDOWN_DATABASE_STEP_TIMEOUT_MS = 1_000;

export type ScratchpadTransactionStatus = "in-progress" | "failed";

export interface ScratchpadStatement {
  readonly sql: string;
  readonly succeeded: boolean;
}

export interface ScratchpadTransaction {
  readonly scratchpadUri: string;
  readonly scratchpadName: string;
  readonly association: ResultBinding;
  readonly status: ScratchpadTransactionStatus;
  readonly statements: readonly ScratchpadStatement[];
}

export interface ScratchpadChangeResult<T> {
  readonly accepted: boolean;
  readonly value?: T;
}

interface OpenScratchpadTransaction {
  scratchpadUri: string;
  scratchpadName: string;
  association: ResultBinding;
  status: ScratchpadTransactionStatus;
  statements: ScratchpadStatement[];
  client: Client;
}

/** Owns the live PostgreSQL Transaction of every MANUAL Scratchpad. */
export class ScratchpadTransactionManager implements vscode.Disposable {
  private readonly transactions = new Map<string, OpenScratchpadTransaction>();
  private readonly openingClients = new Map<string, Client>();
  private readonly operationTails = new Map<string, Promise<void>>();
  private readonly operationConnections = new Map<string, string>();
  private readonly blockedConnections = new Map<string, number>();
  private readonly blockedScratchpads = new Map<string, number>();
  private readonly changed = new vscode.EventEmitter<string | undefined>();
  readonly onDidChange = this.changed.event;
  private shutdownPromise?: Promise<void>;
  private acceptingOperations = true;

  constructor(private readonly connections: ConnectionManager) {}

  transaction(scratchpadUri: string): ScratchpadTransaction | undefined {
    return this.transactions.get(scratchpadUri);
  }

  soleTransaction(): ScratchpadTransaction | undefined {
    if (this.transactions.size !== 1) return undefined;
    return this.transactions.values().next().value;
  }

  transactionsForConnection(connectionId: string): readonly ScratchpadTransaction[] {
    return [...this.transactions.values()].filter(
      ({ association }) => association.connectionId === connectionId,
    );
  }

  execute<T>(
    scratchpadUri: string,
    scratchpadName: string,
    association: ResultBinding,
    action: (client: Client) => Promise<T>,
  ): Promise<T> {
    if (this.blockedScratchpads.has(scratchpadUri)) {
      return Promise.reject(
        new Error("The Scratchpad is changing. Run the Statement again afterward."),
      );
    }
    if (this.blockedConnections.has(association.connectionId)) {
      return Promise.reject(
        new Error("The Scratchpad Connection is changing. Run the Statement again afterward."),
      );
    }
    return this.runExclusive(scratchpadUri, association.connectionId, async () => {
      let transaction = this.transactions.get(scratchpadUri);
      if (transaction?.status === "failed") {
        throw new Error("This Scratchpad Transaction failed. Roll it back before executing again.");
      }
      if (!transaction) {
        const client = await createDedicatedNotebookClient(
          this.connections,
          association.connectionId,
        );
        this.openingClients.set(scratchpadUri, client);
        try {
          if (!this.acceptingOperations) {
            throw new Error("Scratchpad Transactions are shutting down.");
          }
          await client.query("BEGIN");
          if (!this.acceptingOperations) {
            throw new Error("Scratchpad Transactions are shutting down.");
          }
        } catch (error) {
          this.openingClients.delete(scratchpadUri);
          await client.end().catch(() => {});
          throw error;
        }
        transaction = {
          scratchpadUri,
          scratchpadName,
          association,
          status: "in-progress",
          statements: [],
          client,
        };
        this.openingClients.delete(scratchpadUri);
        this.transactions.set(scratchpadUri, transaction);
        this.changed.fire(scratchpadUri);
      }
      return action(transaction.client);
    });
  }

  record(scratchpadUri: string, sql: string, succeeded: boolean): void {
    const transaction = this.transactions.get(scratchpadUri);
    if (!transaction) return;
    transaction.statements.push({ sql, succeeded });
    if (!succeeded) transaction.status = "failed";
    this.changed.fire(scratchpadUri);
  }

  markFailed(scratchpadUri: string): void {
    const transaction = this.transactions.get(scratchpadUri);
    if (!transaction || transaction.status === "failed") return;
    transaction.status = "failed";
    this.changed.fire(scratchpadUri);
  }

  async commit(scratchpadUri: string): Promise<boolean> {
    if (!this.acceptingOperations) return false;
    return this.runExclusive(scratchpadUri, undefined, async () => {
      const transaction = this.transactions.get(scratchpadUri);
      if (!transaction || transaction.status === "failed") return false;
      return this.settle(transaction, "COMMIT");
    });
  }

  async rollback(scratchpadUri: string): Promise<boolean> {
    if (!this.acceptingOperations) return false;
    return this.runExclusive(scratchpadUri, undefined, async () => {
      const transaction = this.transactions.get(scratchpadUri);
      if (!transaction) return false;
      return this.settle(transaction, "ROLLBACK");
    });
  }

  /** Rolls every open Transaction back without asking, for a workbench being reset to a clean state. */
  async rollbackAll(): Promise<void> {
    for (const scratchpadUri of [...this.transactions.keys()]) {
      await this.rollback(scratchpadUri).catch(() => {});
    }
  }

  async runScratchpadChange<T>(
    scratchpadUri: string,
    action: string,
    change: () => Promise<T>,
    isNoOp: () => boolean = () => false,
  ): Promise<ScratchpadChangeResult<T>> {
    if (!this.acceptingOperations) return { accepted: false };
    this.block(this.blockedScratchpads, scratchpadUri);
    try {
      return await this.runExclusive(scratchpadUri, undefined, async () => {
        if (isNoOp()) return { accepted: true };
        if (!(await this.resolveOpenTransaction(scratchpadUri, action))) {
          return { accepted: false };
        }
        return { accepted: true, value: await change() };
      });
    } finally {
      this.unblock(this.blockedScratchpads, scratchpadUri);
    }
  }

  async acquireConnectionChange(
    connectionId: string,
    _action: string,
  ): Promise<vscode.Disposable | undefined> {
    if (!this.acceptingOperations) return undefined;
    this.block(this.blockedConnections, connectionId);
    try {
      await Promise.allSettled(
        [...this.operationTails.entries()]
          .filter(
            ([scratchpadUri]) => this.operationConnections.get(scratchpadUri) === connectionId,
          )
          .map(([, tail]) => tail),
      );
      for (const transaction of [...this.transactions.values()].filter(
        ({ association }) => association.connectionId === connectionId,
      )) {
        await this.runExclusive(transaction.scratchpadUri, undefined, async () => {
          try {
            await this.settle(transaction, "ROLLBACK");
          } catch {
            // A connection lifecycle action must always be able to proceed. ROLLBACK settlement
            // already closes the dedicated Scratchpad client in its finally block.
          }
        });
      }
      return new vscode.Disposable(() => this.unblock(this.blockedConnections, connectionId));
    } catch (error) {
      this.unblock(this.blockedConnections, connectionId);
      throw error;
    }
  }

  /** Best effort safety rule: extension shutdown never commits implicit work. */
  async shutdown(): Promise<void> {
    if (!this.shutdownPromise) {
      this.acceptingOperations = false;
      this.shutdownPromise = this.finishOperationsAndRollback();
    }
    await this.shutdownPromise;
  }

  dispose(): void {
    void this.shutdown();
    this.changed.dispose();
  }

  private async close(transaction: OpenScratchpadTransaction): Promise<void> {
    if (this.transactions.get(transaction.scratchpadUri) === transaction) {
      this.transactions.delete(transaction.scratchpadUri);
    }
    this.changed.fire(transaction.scratchpadUri);
    await transaction.client.end().catch(() => {});
  }

  private async settle(
    transaction: OpenScratchpadTransaction,
    command: "COMMIT" | "ROLLBACK",
  ): Promise<boolean> {
    try {
      await transaction.client.query(command);
    } catch (error) {
      if (command === "COMMIT") {
        transaction.status = "failed";
        this.changed.fire(transaction.scratchpadUri);
      }
      throw error;
    } finally {
      if (command === "ROLLBACK" || transaction.status !== "failed") {
        await this.close(transaction);
      }
    }
    return true;
  }

  /**
   * A Scratchpad closed while it holds an open Transaction is told so before anything happens:
   * confirming rolls the Transaction back, Cancel leaves it open for a Scratchpad reopened later.
   */
  async resolveClosedScratchpad(scratchpadUri: string): Promise<void> {
    if (!this.acceptingOperations || !this.transactions.has(scratchpadUri)) return;
    await this.runExclusive(scratchpadUri, undefined, async () => {
      const transaction = this.transactions.get(scratchpadUri);
      if (!transaction) return;
      const choice = await vscode.window.showWarningMessage(
        `${transaction.scratchpadName} has a ${
          transaction.status === "failed" ? "failed Transaction" : "Transaction in progress"
        }. Closing the Scratchpad rolls it back.`,
        { modal: true },
        "Roll Back",
      );
      if (choice !== "Roll Back") return;
      await this.settle(transaction, "ROLLBACK").catch(() => {});
    }).catch(() => {});
  }

  private async resolveOpenTransaction(scratchpadUri: string, action: string): Promise<boolean> {
    const transaction = this.transactions.get(scratchpadUri);
    if (!transaction) return true;
    const choices = transaction.status === "failed" ? ["Rollback"] : ["Commit", "Rollback"];
    const choice = await vscode.window.showWarningMessage(
      `${transaction.scratchpadName} has a ${transaction.status === "failed" ? "failed Transaction" : "Transaction in progress"}. Resolve it before ${action}.`,
      { modal: true },
      ...choices,
    );
    if (choice === "Commit") return this.settle(transaction, "COMMIT");
    if (choice === "Rollback") return this.settle(transaction, "ROLLBACK");
    return false;
  }

  private block(blocked: Map<string, number>, key: string): void {
    blocked.set(key, (blocked.get(key) ?? 0) + 1);
  }

  private unblock(blocked: Map<string, number>, key: string): void {
    const remaining = (blocked.get(key) ?? 1) - 1;
    if (remaining === 0) blocked.delete(key);
    else blocked.set(key, remaining);
  }

  private runExclusive<T>(
    scratchpadUri: string,
    connectionId: string | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (!this.acceptingOperations) {
      return Promise.reject(new Error("Scratchpad Transactions are shutting down."));
    }
    if (connectionId) this.operationConnections.set(scratchpadUri, connectionId);
    const previous = this.operationTails.get(scratchpadUri) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.operationTails.set(scratchpadUri, tail);
    void tail.then(() => {
      if (this.operationTails.get(scratchpadUri) !== tail) return;
      this.operationTails.delete(scratchpadUri);
      this.operationConnections.delete(scratchpadUri);
    });
    return result;
  }

  private async finishOperationsAndRollback(): Promise<void> {
    const drained = await settlesWithin(
      Promise.allSettled([...this.operationTails.values()]).then(() => undefined),
      SHUTDOWN_DRAIN_TIMEOUT_MS,
    );
    await Promise.all(
      [...this.transactions.values()].map((transaction) =>
        this.closeForShutdown(transaction, drained),
      ),
    );
    await Promise.all(
      [...this.openingClients.entries()].map(async ([scratchpadUri, client]) => {
        this.openingClients.delete(scratchpadUri);
        await settlesWithin(client.end(), SHUTDOWN_DATABASE_STEP_TIMEOUT_MS);
      }),
    );
  }

  private async closeForShutdown(
    transaction: OpenScratchpadTransaction,
    attemptRollback: boolean,
  ): Promise<void> {
    if (this.transactions.get(transaction.scratchpadUri) === transaction) {
      this.transactions.delete(transaction.scratchpadUri);
    }
    if (attemptRollback) {
      await settlesWithin(
        transaction.client.query("ROLLBACK").then(() => undefined),
        SHUTDOWN_DATABASE_STEP_TIMEOUT_MS,
      );
    }
    await settlesWithin(transaction.client.end(), SHUTDOWN_DATABASE_STEP_TIMEOUT_MS);
    this.changed.fire(transaction.scratchpadUri);
  }
}

async function settlesWithin(operation: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
