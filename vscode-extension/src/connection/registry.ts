import type { Client } from "pg";

/** Owns independent PostgreSQL sessions addressed only by their exact Connexion id. */
export class PostgresConnectionRegistry {
  private readonly clients = new Map<string, Client>();

  get connectedIds(): readonly string[] {
    return [...this.clients.keys()];
  }

  client(id: string | undefined): Client | undefined {
    return id ? this.clients.get(id) : undefined;
  }

  isConnected(id: string): boolean {
    return this.clients.has(id);
  }

  async connect(id: string, open: () => Promise<Client>): Promise<Client> {
    const existing = this.clients.get(id);
    if (existing) return existing;
    const client = await open();
    this.clients.set(id, client);
    return client;
  }

  forget(id: string, expected?: Client): boolean {
    const client = this.clients.get(id);
    if (!client || (expected && client !== expected)) return false;
    this.clients.delete(id);
    return true;
  }

  async disconnect(id: string, close: (client: Client) => Promise<void>): Promise<boolean> {
    const client = this.clients.get(id);
    if (!client) return false;
    this.clients.delete(id);
    await close(client);
    return true;
  }

  async dispose(close: (client: Client) => Promise<void>): Promise<void> {
    const clients = [...this.clients.values()];
    this.clients.clear();
    await Promise.allSettled(clients.map((client) => close(client)));
  }
}
